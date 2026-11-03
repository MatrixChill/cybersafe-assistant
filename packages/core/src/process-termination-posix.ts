import * as fs from "node:fs";

import { killProcessTree, type KillProcessTreeOptions } from "./response.js";
import type { TerminationIdentity, TerminationLease } from "./safe-process-termination.js";
import type { KillProcessResult } from "@cybersafe/shared-types";

/**
 * Terminação de processos em POSIX (Linux) — o equivalente funcional do
 * `taskkill /F /T /PID` do Windows, sem copiar a implementação dele.
 *
 * Porque existe um módulo próprio:
 *  - `taskkill` não existe no Linux; chamar `spawn("taskkill")` produziria
 *    `ENOENT` e o utilizador veria uma falha sem causa.
 *  - montar comandos de shell com um PID vindo do ecrã é superfície de injeção;
 *    aqui não há shell nenhum: `process.kill(pid, sinal)` é a única ação.
 *  - um PID é um número reutilizável. No Windows o `taskkill` é por PID e a
 *    revalidação é feita via CIM; no Linux a identidade verificável está em
 *    `/proc/<pid>` (instante de início, UID, estado). É essa a fonte que usamos,
 *    e quando ela não confirma, **não há efeito**.
 *
 * O que este módulo NÃO faz, de propósito:
 *  - não escala de SIGTERM para SIGKILL sozinho (SIGKILL é operação separada e
 *    tem de ser pedida explicitamente por quem confirma);
 *  - não sinaliza processos de outro UID, nem `init`/`kthreadd`, nem threads de
 *    kernel, nem o próprio processo;
 *  - não faz `kill(-pgid)`: varrer o grupo de processos mataria o terminal ou o
 *    gestor de sessão de quem pediu.
 *
 * `pidfd`: seria o mecanismo ideal contra reutilização de PID (`pidfd_send_signal`
 * prende o sinal à instância, não ao número). Node não expõe `pidfd_open` e não
 * há addon nativo Linux neste projeto, logo a alternativa honesta é revalidar
 * `/proc/<pid>` imediatamente antes do sinal e depois dele. Fica registado como
 * lacuna conhecida, não como suporte.
 */

export type PosixTerminationSignal = "SIGTERM" | "SIGKILL";

/** Identidade verificável de um processo lida de `/proc`. */
export interface PosixProcessIdentity {
  pid: number;
  ppid: number;
  /** `Name:` de `/proc/<pid>/stat` (campo 1) — sem os parêntesis. */
  comm: string;
  /** Campo 22 de `/proc/<pid>/stat`: jiffies desde o boot em que nasceu. */
  starttime: number;
  state: string;
  uid: number;
  euid: number;
  /** Threads de kernel (`kthreadd` e filhos) não têm `cmdline`. */
  kernelThread: boolean;
}

/** Só o que é lido do disco; injectável para os testes não dependerem de `/proc`. */
export interface ProcFsLike {
  readFileSync(caminho: string, codificacao: "utf-8"): string;
  existsSync(caminho: string): boolean;
}

export interface PosixSelfContext {
  pid: number;
  uid: number;
  euid: number;
}

const RAIZ_PROC = "/proc";

/**
 * Analisa o conteúdo de `/proc/<pid>/stat`.
 *
 * O `comm` vem entre parêntesis e pode conter espaços e parêntesis (ex.:
 * `(a b) c`), por isso o único corte seguro é o PRIMEIRO `(` e o ÚLTIMO `)`.
 * Depois disso os campos correm a partir do `state`, que é o campo 3.
 */
export function parseProcStat(conteudo: string): Omit<PosixProcessIdentity, "uid" | "euid" | "kernelThread"> | null {
  const abre = conteudo.indexOf("(");
  const fecha = conteudo.lastIndexOf(")");
  if (abre < 0 || fecha <= abre) return null;
  const comm = conteudo.slice(abre + 1, fecha);
  const campos = conteudo.slice(fecha + 1).trim().split(/\s+/);
  // campos[0] = state (campo 3). ppid = campo 4 → índice 1. starttime = campo 22 → 22-3 = 19.
  if (campos.length < 20) return null;
  const ppid = Number.parseInt(campos[1], 10);
  const state = campos[0];
  const starttime = Number.parseInt(campos[19], 10);
  if (!Number.isFinite(ppid) || !Number.isFinite(starttime)) return null;
  return { pid: Number.parseInt(conteudo.slice(0, abre).trim(), 10) || 0, ppid, comm, starttime, state };
}

/** `Uid:\treal\teffective\tsaved\tfs` de `/proc/<pid>/status`. */
export function parseProcStatusUids(conteudo: string): { uid: number; euid: number } | null {
  const linha = /^Uid:\s+(\d+)\s+(\d+)/m.exec(conteudo);
  if (!linha) return null;
  return { uid: Number.parseInt(linha[1], 10), euid: Number.parseInt(linha[2], 10) };
}

/**
 * Identidade do processo, ou `null` quando não existe (`ESRCH`/sem diretório) ou
 * quando um ficheiro essencial não se lê. `null` significa «não há prova», e é
 * tratado como recusa — nunca como «assume que está bem».
 */
export function readPosixProcessIdentity(
  pid: number,
  proc: ProcFsLike = fs,
  raiz: string = RAIZ_PROC,
): PosixProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const base = `${raiz}/${pid}`;
  try {
    if (!proc.existsSync(base)) return null;
    const stat = parseProcStat(proc.readFileSync(`${base}/stat`, "utf-8"));
    if (!stat) return null;
    const uids = parseProcStatusUids(proc.readFileSync(`${base}/status`, "utf-8"));
    if (!uids) return null;
    let cmdline = "";
    try {
      cmdline = proc.readFileSync(`${base}/cmdline`, "utf-8").replace(/\0/g, " ").trim();
    } catch {
      // Sem `cmdline` legível não conseguimos distinguir thread de kernel de
      // processo zombie: a recusa acontece no guard, não aqui.
      cmdline = "";
    }
    return {
      pid,
      ppid: stat.ppid,
      comm: stat.comm,
      starttime: stat.starttime,
      state: stat.state,
      uid: uids.uid,
      euid: uids.euid,
      kernelThread: cmdline === "" && stat.ppid <= 2,
    };
  } catch {
    return null;
  }
}

export type PosixTerminationRefusal =
  | "sem-identidade"
  | "identidade-nao-confirma"
  | "nome-nao-corresponde"
  | "processo-ja-terminou"
  | "processo-zombie"
  | "thread-de-kernel"
  | "processo-proprio"
  | "outro-utilizador";

/**
 * `/proc/<pid>/comm` é o nome executável, cortado a 15 caracteres; o `name` do
 * snapshot pode vir como nome curto (`node`) ou como caminho do executável
 * (`/usr/local/bin/node`), por isso comparamos a BASE do caminho. A tolerância
 * é só esta: nomes sem relação são PID reutilizado, e a resposta é recusar.
 * Prefixos só contam quando o lado curto tem 3+ caracteres — `a.startsWith(b)`
 * com um `b` de uma letra aceitaria quase qualquer coisa, o que não é prova.
 */
export function commCorresponde(comm: string, nomeSnapshot: string): boolean {
  const a = comm.trim().toLowerCase();
  const bruto = nomeSnapshot.trim().toLowerCase();
  if (!a || !bruto) return false;
  const b = bruto.split(/[\\/]/).pop() ?? bruto;
  if (!b) return false;
  if (a === b) return true;
  const curto = Math.min(a.length, b.length);
  return curto >= 3 && (b.startsWith(a) || a.startsWith(b));
}

/** O que o instantâneo dizia sobre o processo selecionado. */
export interface PosixTerminationExpectation {
  /** `starttime` do snapshot em que a seleção foi feita (prova de identidade). */
  esperadoStarttime?: number;
  /** `name` do snapshot: divergir do `comm` é PID reutilizado. */
  esperadoNome?: string;
}

/**
 * Decide ANTES de qualquer sinal. Devolve o motivo, ou `null` quando o sinal é
 * permitido. `esperadoStarttime` é a identidade do instante em que o utilizador
 * selecionou o processo: divergir é PID reutilizado, e a resposta é recusar.
 * O mesmo vale para o nome — `starttime` igual entre dois processos curtos é
 * possível (jiffies do boot), o nome é a segunda independência barata.
 */
export function decidePosixTermination(
  identidade: PosixProcessIdentity | null,
  contexto: PosixSelfContext,
  esperanca?: PosixTerminationExpectation | number,
): PosixTerminationRefusal | null {
  // Aceita a forma antiga (só o starttime) para não quebrar chamadas internas.
  const esperado = typeof esperanca === "number" ? { esperadoStarttime: esperanca } : (esperanca ?? {});
  if (!identidade) return "sem-identidade";
  if (identidade.state === "Z") return "processo-zombie";
  if (identidade.state === "X") return "processo-ja-terminou";
  if (typeof esperado.esperadoStarttime === "number" && identidade.starttime !== esperado.esperadoStarttime) {
    return "identidade-nao-confirma";
  }
  if (esperado.esperadoNome && !commCorresponde(identidade.comm, esperado.esperadoNome)) {
    return "nome-nao-corresponde";
  }
  if (identidade.pid <= 2 || identidade.kernelThread) return "thread-de-kernel";
  // Só o NOSSO PID é intocável aqui. Filhos diretos do chamador NÃO são
  // protegidos por esta regra: a prova medida em WSL2 mostrou que isso recusava
  // qualquer processo legítimo do ecrã (falso positivo). A proteção de
  // ancestrais e de componentes do CyberSafe vive em `classifyKillTarget`,
  // que tem a lista real de PID/caminhos do serviço — é aí, e não aqui, que o
  // motor trava o que é dele.
  if (identidade.pid === contexto.pid) return "processo-proprio";
  // UID efetivo do alvo diferente do nosso, e não somos root: o kernel devolvia
  // EPERM; recusar antes é mais honesto do que deixar o sinal adivinhar.
  if (contexto.euid !== 0 && identidade.euid !== contexto.euid) return "outro-utilizador";
  return null;
}

export interface TerminatePosixOptions extends KillProcessTreeOptions, PosixTerminationExpectation {
  /** SIGTERM é o pedido normal; SIGKILL tem de ser pedido explicitamente. */
  signal?: PosixTerminationSignal;
  self?: PosixSelfContext;
  proc?: ProcFsLike;
  raizProc?: string;
  /** Seam de teste: `process.kill` e espera. */
  signalImpl?: (pid: number, sinal: NodeJS.Signals | 0) => void;
  sleepMs?: (ms: number) => Promise<void>;
  agora?: () => number;
}

const esperaPadrao = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Sinaliza um processo POSIX com verificação de identidade de ponta a ponta.
 *
 * Devolve o mesmo `KillProcessResult` do `taskkill` para que o serviço não
 * precise de dois caminhos de diagnóstico. `stdout`/`stderr` são substituídos
 * por uma linha de contexto legível: não há utilitário externo a capturar, e
 * inventar saída vazia seria pior do que dizer o que foi lido.
 */
export async function terminatePosixProcess(
  pid: number,
  options: TerminatePosixOptions = {},
): Promise<KillProcessResult> {
  const sinal = options.signal ?? "SIGTERM";
  const prazoMs = options.timeoutMs ?? 5_000;
  const proc = options.proc ?? (fs as unknown as ProcFsLike);
  const raiz = options.raizProc ?? RAIZ_PROC;
  const enviar = options.signalImpl ?? ((p: number, s: NodeJS.Signals | 0) => { process.kill(p, s); });
  const dormir = options.sleepMs ?? esperaPadrao;
  const agora = options.agora ?? (() => Date.now());
  const self = options.self ?? { pid: process.pid, uid: process.getuid?.() ?? -1, euid: process.geteuid?.() ?? -1 };

  const identidade = readPosixProcessIdentity(pid, proc, raiz);
  const recusa = decidePosixTermination(identidade, self, {
    esperadoStarttime: options.esperadoStarttime,
    esperadoNome: options.esperadoNome,
  });
  if (recusa) {
    return {
      ok: false,
      status: recusa === "outro-utilizador" ? "access-denied" : recusa === "processo-ja-terminou" ? "not-found" : "failed",
      pid,
      error: `terminacao recusada antes do sinal: ${recusa}`,
      stderr: `identity=${identidade ? `comm=${identidade.comm} starttime=${identidade.starttime} euid=${identidade.euid} state=${identidade.state}` : "desconhecida"}`,
    };
  }

  const alvo = identidade as PosixProcessIdentity;
  try {
    enviar(pid, sinal);
  } catch (error) {
    const codigo = (error as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      status: codigo === "ESRCH" ? "not-found" : codigo === "EPERM" ? "access-denied" : "failed",
      pid,
      error: `falha ao enviar ${sinal}: ${codigo ?? (error as Error).message}`,
      stderr: `identity=comm=${alvo.comm} starttime=${alvo.starttime} euid=${alvo.euid}`,
    };
  }

  // Espera ativa: o sinal é assíncrono. «Enviei» não é «terminou».
  const limite = agora() + Math.max(250, prazoMs);
  for (;;) {
    const actual = readPosixProcessIdentity(pid, proc, raiz);
    if (!actual) {
      return {
        ok: true,
        status: "ok",
        pid,
        stdout: `${sinal} entregue; processo terminou (pid=${pid}, starttime=${alvo.starttime})`,
      };
    }
    // PID reutilizado durante a espera: o antigo já não existe; não sinalizamos de novo.
    if (actual.starttime !== alvo.starttime) {
      return {
        ok: false,
        status: "not-found",
        pid,
        error: `pid reapareceu com identidade diferente (starttime ${alvo.starttime} -> ${actual.starttime}); o alvo anterior terminou`,
      };
    }
    if (actual.state === "Z") {
      return { ok: true, status: "ok", pid, stdout: `${sinal} entregue; processo em zombie (reap do pai pendente)` };
    }
    if (agora() >= limite) {
      return {
        ok: false,
        status: "timeout",
        pid,
        error: `${sinal} entregue mas o processo continua vivo apos ${prazoMs} ms; SIGKILL exige confirmacao explicita separada`,
        stderr: `identity=comm=${actual.comm} starttime=${actual.starttime} state=${actual.state}`,
      };
    }
    await dormir(100);
  }
}

/**
 * Seam único do serviço: Windows continua a executar exatamente o mesmo
 * `killProcessTree` de sempre; POSIX usa o sinalizador próprio. A escolha é
 * feita em tempo de chamada (não na importação), para que um teste em Windows
 * continue a ver `taskkill` e um runner Linux nunca spawn um `.exe`.
 */
export async function killProcessPlatform(
  pid: number,
  options?: TerminatePosixOptions,
): Promise<KillProcessResult> {
  if (process.platform === "win32") {
    return killProcessTree(pid, options);
  }
  return terminatePosixProcess(pid, options);
}

/* ── bilhete de terminação (o pedido do ecrã, não só o primitivo) ──────────── */

/** Unix→FILETIME: 1601-01-01 em relação a 1970-01-01, em milissegundos. */
const DESLOCAMENTO_FILETIME_MS = 11_644_473_600_000;

/**
 * O contrato de identidade do motor compara o instante de criação como FILETIME
 * de 100 ns, porque é isso que o CIM publica. Linux não tem FILETIME: o que
 * existe é `boot + starttime/HZ`, com a resolução de 1/HZ (10 ms a HZ=100).
 * Converter para milissegundos exatos e preencher os últimos quatro dígitos com
 * zeros é o mesmo padding que o .NET faz no `Get-CimInstance` — os zeros são a
 * unidade do kernel, não precisão medida. É por isso que esta função devolve
 * também o ISO com 7 decimais: a linha do ecrã e o `creation` do bilhete têm de
 * sair da mesma conversão, senão a comparação nunca bate certo.
 */
export function criacaoPosix(ms: number): { startedAt: string; creation: string } | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const inteiro = Math.round(ms);
  return {
    startedAt: new Date(inteiro).toISOString().replace(/Z$/, "0000Z"),
    creation: ((BigInt(inteiro) + BigInt(DESLOCAMENTO_FILETIME_MS)) * 10_000n).toString(),
  };
}

export interface PosixTerminationLeaseOptions {
  /** `CLK_TCK` medido (`getconf`). Sem ele não há instante nem bilhete. */
  hz: number;
  /** Instante do boot em ms, vindo de `/proc/stat btime`. */
  bootMs: number;
  proc?: ProcFsLike;
  raizProc?: string;
  self?: PosixSelfContext;
  /** Sinal do pedido normal. SIGKILL continua uma operação à parte. */
  signal?: PosixTerminationSignal;
  signalImpl?: (pid: number, sinal: NodeJS.Signals | 0) => void;
  /** Caminho do executável; `""` quando o kernel não o mostra a este UID. */
  pathLeitura?: (pid: number) => string;
  /** A proteção do serviço (PID próprio, ancestrais, componentes CyberSafe). */
  protegido?: (identidade: PosixProcessIdentity, caminho: string) => boolean;
}

/**
 * Lease POSIX para `SafeProcessTermination`.
 *
 * O lease do Windows pinia um handle de processo: entre a preparação e a
 * confirmação não há pesquisa nenhuma, e um PID reutilizado é impossível por
 * construção. Em POSIX sem `pidfd_open` (que o Node não expõe) não existe
 * equivalente, por isso este lease faz o mais forte que a plataforma permite:
 * fixa o `starttime` lido no momento em que a seleção foi aceite e, antes de
 * cada leitura e do próprio sinal, relê `/proc` e compara. Instância diferente
 * é `reused`, e o `confirmation` devolvido diz `identity-reconfirmed` em vez de
 * mentir que foi um handle pinado.
 */
export function abrirLeasePosixTerminacao(
  pid: number,
  opcoes: PosixTerminationLeaseOptions,
): TerminationLease {
  const proc = opcoes.proc ?? (fs as unknown as ProcFsLike);
  const raiz = opcoes.raizProc ?? RAIZ_PROC;
  const self = opcoes.self ?? {
    pid: process.pid, uid: process.getuid?.() ?? -1, euid: process.geteuid?.() ?? -1,
  };
  const sinal = opcoes.signal ?? "SIGTERM";
  const enviar = opcoes.signalImpl ?? ((p: number, s: NodeJS.Signals | 0) => { process.kill(p, s); });
  const lerPath = opcoes.pathLeitura ?? ((p: number) => {
    try { return fs.readlinkSync(`${raiz}/${p}/exe`); } catch { return ""; }
  });
  const ler = () => readPosixProcessIdentity(pid, proc, raiz);
  const instante = ler();
  if (!instante) {
    // O `prepare` pergunta por `exited()` antes de ler identidade: um PID que
    // já não existe é respondido como «já saiu», não como falha opaca.
    const morto: TerminationLease = {
      confirmation: "identity-reconfirmed",
      read: () => ({ pid, name: "", path: "", startedAt: "", creation: "", eligible: false, reason: "sem-identidade" }),
      exited: () => true,
      terminate: () => { throw new Error("posix: o processo já tinha saído; nenhum sinal foi enviado"); },
      close: () => {},
    };
    return morto;
  }
  const pin = instante.starttime;
  let fechado = false;

  const identidadeAtual = (): TerminationIdentity => {
    const atual = ler();
    const caminho = atual ? lerPath(pid) : "";
    if (!atual) {
      return { pid, name: "", path: "", startedAt: "", creation: "", eligible: false, reason: "sem-identidade" };
    }
    const criada = criacaoPosix(opcoes.bootMs + atual.starttime / opcoes.hz * 1000);
    const recusa = decidePosixTermination(atual, self, { esperadoStarttime: pin, esperadoNome: instante.comm });
    const protegidoPeloServico = criada !== null && (opcoes.protegido?.(atual, caminho) ?? false);
    return {
      pid,
      name: atual.comm,
      path: caminho,
      startedAt: criada?.startedAt ?? "",
      creation: criada?.creation ?? "",
      eligible: criada !== null && recusa === null && !protegidoPeloServico,
      reason: recusa ?? (protegidoPeloServico ? "protegido" : criada === null ? "criacao-invalida" : undefined),
    };
  };

  return {
    confirmation: "identity-reconfirmed",
    read: identidadeAtual,
    exited: () => {
      const atual = ler();
      return !atual || atual.state === "X" || atual.state === "Z";
    },
    terminate: () => {
      if (fechado) throw new Error("posix: o bilhete já tinha sido fechado; nenhum sinal foi enviado");
      const atual = ler();
      const recusa = decidePosixTermination(atual, self, { esperadoStarttime: pin, esperadoNome: instante.comm });
      if (recusa) {
        throw new Error(`posix: sinal recusado antes de enviar (${recusa}); nenhum efeito produzido`);
      }
      if (opcoes.protegido?.(atual!, lerPath(pid))) {
        throw new Error("posix: o alvo é protegido pelo serviço; nenhum sinal foi enviado");
      }
      enviar(pid, sinal);
    },
    close: () => { fechado = true; },
  };
}
