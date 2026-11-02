import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

import type { ProcessSnapshot } from "@cybersafe/shared-types";
import { parseProcStat, parseProcStatusUids, type ProcFsLike } from "./process-termination-posix.js";

/**
 * Enumeração de processos em POSIX (Linux) — a fonte do Gestor de Tarefas
 * quando não há CIM.
 *
 * Porque não `systeminformation`: a bibliotecaria é útil para métricas, mas a
 * identidade de um processo tem de vir do mesmo sítio onde o ponto de decisão
 * a volta a procurar. Aqui a fonte única é `/proc/<pid>`: o `startedAt` do
 * snapshot é o `starttime` de `/proc/<pid>/stat` convertido com o relógio do
 * kernel, e é esse mesmo valor que a terminação revalida antes do sinal. Duas
 * fontes diferentes dariam duas respostas diferentes para a mesma pergunta, e
 * a segunda seria sempre «não confirmado».
 *
 * O que NÃO é inventado:
 *  - `HZ` (ticks do relógio por segundo) e `PAGESIZE` vêm de `getconf`. Sem
 *    `getconf`, não há conversão: `startedAt` fica `""` (ausência) e a
 *    terminação recusa, em vez de assumir 100 Hz e 4 KiB;
 *  - CPU sem amostra anterior é a MÉDIA DA VIDA do processo (utime+stime /
 *    idade), não 0% e não uma amostra instantânea fingida; a partir da segunda
 *    enumeração passa a ser a variação no intervalo real;
 *  - `path` vazio quando o `link` não se lê (processo de outro utilizador) — a
 *    UI mostra ausência, nunca uma adivinha;
 *  - zero processos utilizáveis É FALHA, não «o Linux não tem processos».
 */

/** Superfície de `/proc` de que este módulo precisa; injectável nos testes. */
export interface ProcDirLike extends ProcFsLike {
  readdirSync(caminho: string): string[];
  readlinkSync(caminho: string, codificacao: "utf-8"): string;
}

export interface PosixProviderOptions {
  proc?: ProcDirLike;
  raizProc?: string;
  agora?: () => number;
  /**
   * Leitura de `/proc/stat` e `/etc/passwd`. Por omissão usa a MESMA façade do
   * `proc`: trocar a raiz (num teste, num chroot, num container) troca tudo,
   * e um acesso direto ao disco nunca contorna a fonte injetada.
   */
  leitura?: (caminho: string) => string;
  /** `getconf CLK_TCK` / `getconf PAGESIZE`. `null` = sem resposta. */
  sysconf?: (nome: "CLK_TCK" | "PAGESIZE") => number | null;
}

/** Estado entre enumerações: só existe para o CPU intervalo fazer sentido. */
interface AmostraAnterior {
  /** `starttime` em ticks — âncora: PID reutilizado tem outra amostra. */
  starttime: number;
  /** utime+stime acumulados na amostra. */
  ticks: number;
  /** Instante da amostra em ms de época. */
  atMs: number;
}

const MIB = 1024 * 1024;
/** Campos 14..15 (utime, stime) e 24 (rss) de `/proc/<pid>/stat`, a partir do `state`. */
const DESLOCAMENTO_UTIME = 14 - 3;
const DESLOCAMENTO_STIME = 15 - 3;
const DESLOCAMENTO_RSS = 24 - 3;

/**
 * Constantes do sistema lidas uma vez por processo. `null` é uma resposta
 * legítima («não conseguimos perguntar») e propaga-se como ausência.
 */
interface ConstantesSistema {
  /** ticks do relógio por segundo (normalmente 100, nunca assumido). */
  hz: number | null;
  /** bytes por página (normalmente 4096, nunca assumido). */
  pageSize: number | null;
  /** Início do boot em ms de época, e a idade do sistema em segundos. */
  bootMs: number | null;
}

function sysconfPadrao(nome: "CLK_TCK" | "PAGESIZE"): number | null {
  try {
    const saida = execFileSync("getconf", [nome], { encoding: "utf-8", timeout: 2_000 }).trim();
    const valor = Number.parseInt(saida, 10);
    return Number.isFinite(valor) && valor > 0 ? valor : null;
  } catch {
    return null;
  }
}

/**
 * `btime` de `/proc/stat` é o instante do boot em segundos de época — é ele
 * que transforma o `starttime` (ticks desde o boot) num instante real.
 * Sem `btime` não há `startedAt`: quem consome recusa a ação.
 */
function tempoBoot(leitura: (caminho: string) => string): number | null {
  try {
    const linha = /^btime\s+(\d+)/m.exec(leitura("/proc/stat"));
    if (!linha) return null;
    const segundos = Number.parseInt(linha[1], 10);
    return Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : null;
  } catch {
    return null;
  }
}

/** `/etc/passwd` uma vez: UID → nome. Utilizador desconhecido fica `uid:N`. */
function mapaUtilizadores(leitura: (caminho: string) => string): Map<number, string> {
  const mapa = new Map<number, string>();
  try {
    for (const linha of leitura("/etc/passwd").split("\n")) {
      const partes = linha.split(":");
      if (partes.length < 3) continue;
      const uid = Number.parseInt(partes[2], 10);
      if (Number.isInteger(uid) && partes[0]) mapa.set(uid, partes[0]);
    }
  } catch {
    // Sem `/etc/passwd` legível (container mínimo, NSS remoto): a alternativa
    // numérica é verdadeira e suficiente para distinguir donos.
  }
  return mapa;
}

/** Analisa os campos de `/proc/<pid>/stat` que a listagem precisa. */
export function analisarLinhasStat(conteudo: string): {
  pid: number; comm: string; ppid: number; state: string; starttime: number; cpuTicks: number; rssPages: number;
} | null {
  const base = parseProcStat(conteudo);
  if (!base) return null;
  const fecha = conteudo.lastIndexOf(")");
  const campos = conteudo.slice(fecha + 1).trim().split(/\s+/);
  if (campos.length <= DESLOCAMENTO_RSS) return null;
  const utime = Number.parseInt(campos[DESLOCAMENTO_UTIME], 10);
  const stime = Number.parseInt(campos[DESLOCAMENTO_STIME], 10);
  const rss = Number.parseInt(campos[DESLOCAMENTO_RSS], 10);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    ...base,
    cpuTicks: utime + stime,
    rssPages: Number.isFinite(rss) && rss >= 0 ? rss : 0,
  };
}

/**
 * Percentagem de CPU. Sem amostra anterior não há intervalo: devolve a média
 * da vida do processo e marca `mediaVida`, para o chamador saber que o número
 * não é uma amostra instantânea.
 */
export function calcularCpuPercent(
  atual: AmostraAnterior,
  anterior: AmostraAnterior | undefined,
  hz: number,
  idadeSegundos: number,
): { cpu: number; base: "intervalo" | "media-vida" } {
  if (anterior && anterior.starttime === atual.starttime && atual.atMs > anterior.atMs) {
    const seg = (atual.atMs - anterior.atMs) / 1000;
    const delta = atual.ticks - anterior.ticks;
    if (seg > 0 && delta >= 0) {
      return { cpu: (delta / hz / seg) * 100, base: "intervalo" };
    }
  }
  if (idadeSegundos > 0) {
    return { cpu: (atual.ticks / hz / idadeSegundos) * 100, base: "media-vida" };
  }
  return { cpu: 0, base: "media-vida" };
}

/** Estado do fornecedor entre chamadas — um por instância. */
export interface PosixProcessProviderState {
  amostras: Map<number, AmostraAnterior>;
  constantes: ConstantesSistema | null;
  utilizadores: Map<number, string> | null;
}

function constantes(
  leitura: (caminho: string) => string,
  sysconf: (nome: "CLK_TCK" | "PAGESIZE") => number | null,
): ConstantesSistema {
  return {
    hz: sysconf("CLK_TCK"),
    pageSize: sysconf("PAGESIZE"),
    bootMs: tempoBoot(leitura),
  };
}

/**
 * Enumera os processos de `/proc`. Lança quando a fonte não responde — a
 * mesma política do CIM no Windows: «não consegui ler» não é «não há
 * processos», e uma lista vazia mentira apaga o ecrã inteiro ao utilizador.
 */
export function listPosixProcesses(
  estado: PosixProcessProviderState,
  opcoes: PosixProviderOptions = {},
): ProcessSnapshot[] {
  const proc = opcoes.proc ?? (fs as unknown as ProcDirLike);
  const raiz = opcoes.raizProc ?? "/proc";
  const agora = opcoes.agora ?? (() => Date.now());
  const leitura = opcoes.leitura ?? ((caminho: string) => proc.readFileSync(caminho, "utf-8"));
  const sysconf = opcoes.sysconf ?? sysconfPadrao;

  if (!estado.constantes) estado.constantes = constantes(leitura, sysconf);
  if (!estado.utilizadores) estado.utilizadores = mapaUtilizadores(leitura);
  const { hz, pageSize, bootMs } = estado.constantes;

  let pids: string[];
  try {
    pids = proc.readdirSync(raiz);
  } catch (error) {
    throw new Error(
      `enumeração POSIX de processos indisponível: ${raiz} não é legível (${(error as Error).message})`,
    );
  }

  const agoraMs = agora();
  const proximas = new Map<number, AmostraAnterior>();
  const linhas: ProcessSnapshot[] = [];

  for (const entrada of pids) {
    const pid = Number.parseInt(entrada, 10);
    if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== entrada) continue;
    const base = `${raiz}/${pid}`;

    let stat: ReturnType<typeof analisarLinhasStat> | null = null;
    try {
      stat = analisarLinhasStat(proc.readFileSync(`${base}/stat`, "utf-8"));
    } catch {
      // Nasceu ou morreu entre o `readdir` e a leitura: ausência normal, não erro.
      continue;
    }
    if (!stat || stat.pid !== pid) continue;

    let uid: number | null = null;
    try {
      uid = parseProcStatusUids(proc.readFileSync(`${base}/status`, "utf-8"))?.uid ?? null;
    } catch {
      uid = null;
    }

    let commandLine = "";
    try {
      commandLine = proc.readFileSync(`${base}/cmdline`, "utf-8").replace(/\0/g, " ").trim();
    } catch {
      commandLine = "";
    }

    let caminho = "";
    try {
      caminho = proc.readlinkSync(`${base}/exe`, "utf-8");
    } catch {
      // Threads de kernel e processos de outro utilizador: sem link legível.
      caminho = "";
    }

    const amostra: AmostraAnterior = { starttime: stat.starttime, ticks: stat.cpuTicks, atMs: agoraMs };
    proximas.set(pid, amostra);

    // `startedAt` só existe quando HZ e boot são conhecidos. Ausência é
    // string vazia: a UI mostra «desconhecido» e a terminação recusa.
    const idadeSegundos = hz && bootMs !== null ? (agoraMs - bootMs) / 1000 - stat.starttime / hz : 0;
    const startedAt = hz && bootMs !== null
      ? new Date(bootMs + stat.starttime / hz * 1000).toISOString()
      : "";
    const cpu = hz
      ? calcularCpuPercent(amostra, estado.amostras.get(pid), hz, Math.max(0, idadeSegundos)).cpu
      : 0;

    linhas.push({
      pid,
      ppid: stat.ppid,
      name: stat.comm,
      path: caminho,
      commandLine,
      user: uid === null ? undefined : estado.utilizadores!.get(uid) ?? `uid:${uid}`,
      cpu,
      memoryMb: pageSize ? (stat.rssPages * pageSize) / MIB : 0,
      startedAt,
      signer: undefined,
      trusted: "neutral",
    });
  }

  estado.amostras = proximas;

  if (linhas.length === 0) {
    throw new Error(`enumeração POSIX de processos: zero registos legíveis em ${raiz} — fonte indisponível, não lista vazia`);
  }
  return linhas;
}

/**
 * Fornecedor com estado próprio, para o serviço instalar uma vez e chamar
 * sempre ao mesmo objeto (as amostras de CPU são por instância).
 */
export class PosixProcessProvider {
  private readonly estado: PosixProcessProviderState = {
    amostras: new Map(),
    constantes: null,
    utilizadores: null,
  };

  constructor(private readonly opcoes: PosixProviderOptions = {}) {}

  /** Lista síncrona; o serviço chama-a dentro da enumeração já single-flight. */
  list(): ProcessSnapshot[] {
    return listPosixProcesses(this.estado, this.opcoes);
  }

  /** O que a fonte sabe sobre o sistema; `null` quando não foi perguntado. */
  constantes(): ConstantesSistema | null {
    return this.estado.constantes;
  }
}
