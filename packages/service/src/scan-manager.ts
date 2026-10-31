import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { pinFixture } from "./fixture-pin.js";
import { readBoundedArchiveEntry } from "@cybersafe/core";
import type { ExclusionReasonCount, ScanState, ScanType, SecurityEvent } from "@cybersafe/shared-types";
import type { FileScanResponse, ThreatEvent } from "@cybersafe/shared-types";
import { categorizeFsError, isTransientFsError } from "./scan-error.js";
// ————— Observabilidade do CANCELAMENTO (TP-A5-D2-20261020) —————
//
// Medido no A5 (20/10, 22:45): o `scan.start` deixou 5 linhas de registo com requestId
// e scanId; o `scan.cancel` não deixou NENHUMA. Sem registo, «a UI mostrou cancelado»,
// «o manager recebeu o pedido» e «o terminal foi emitido e gravado» passam a ser a mesma
// frase — e um cancelamento que chega tarde demais fica indistinguível de um que nunca
// chegou ao serviço.
//
// Fronteira honesta: o ACK do handler NÃO prova o terminal, «emitido» não prova «gravado», e
// a cadeia do histórico resolvida NÃO prova persistência — `ScanHistory.record` (scan-history.ts)
// apanha a falha do append e resolve mesmo quando nada foi escrito. Por isso o estágio se chama
// `terminal_historico_processado` e a gravação é provada à parte, pela consulta do histórico.
//
// Zero ruído fora de DEV: o registo só existe com isolamento VERIFICADO e o gate de fixture
// efetivamente montado — provados pelo registo privado do próprio módulo de instalação, não pelo
// texto da função. Produção e modo desligado mantêm exatamente os logs de hoje.
// Nunca nomes, caminhos, utilizador, payload, tokens ou erros brutos — só enums, UUID e timestamp.
import {
  alvoAindaIntacto,
  gateDeFixtureMontadoPara,
  GATE_CODE,
  identidadeAindaBate,
  obterSnapshotValidado,
  FIXTURE_SCAN_FLAG,
  type SnapshotFixture,
} from "./dev-fixture-gate.js";

export type CancelDesfecho = "cancelado" | "desconhecido" | "ja_terminal";
export type CancelEstagio = "recebido" | "processado" | "terminal_emitido" | "terminal_historico_processado";

const CANCEL_ESTAGIOS = new Set<string>(["recebido", "processado", "terminal_emitido", "terminal_historico_processado"]);
const CANCEL_STATUS = new Set<string>(["cancelled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// O prefixo de pipe de um run isolado. Escrito por partes com String.fromCharCode
// porque uma literal com barras em string de origem ja foi medida errada (escapes de
// string comem a barra antes de `pipe` e de `cybersafe`): o valor TEM de bater com o
// pipe que o runner isolado cria, ou a autorizacao do registo falha em silêncio.
const BARRA_PIPE = String.fromCharCode(92);
const PREFIXO_PIPE_DEV = BARRA_PIPE + BARRA_PIPE + "." + BARRA_PIPE + "pipe" + BARRA_PIPE + "cybersafe-dev-";

/**
 * Autoriza o registo do cancelamento? Nada aqui é declarado pelo chamador: o isolamento é
 * lido do ambiente e o gate é provado pelo registo privado do módulo que o instala — a mesma
 * porta que o A4 usa, para o corpus de teste.
 */
export function cancelamentoObservavel(alvo: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.NODE_ENV ?? "") !== "development") return false;
  if (String(env.CYBERSAFE_DEV_ISOLATION ?? "") !== "1") return false;
  if (String(env[FIXTURE_SCAN_FLAG] ?? "") !== "1") return false;
  const pipe = String(env.CYBERSAFE_DEV_PIPE_NAME ?? "");
  if (!pipe.startsWith(PREFIXO_PIPE_DEV)) return false;
  return gateDeFixtureMontadoPara(alvo, env).montado;
}

/** Uma linha, forma fixa. Silencioso quando não autorizado; nunca ecoa o valor recebido. */
export function linhaDeCancelamento(
  alvo: unknown,
  estagio: CancelEstagio,
  scanId: unknown,
  extra?: { desfecho?: CancelDesfecho; status?: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!CANCEL_ESTAGIOS.has(estagio)) return;
  if (!cancelamentoObservavel(alvo, env)) return;
  const id = typeof scanId === "string" && UUID_RE.test(scanId) ? scanId : "invalido";
  const partes = [`stage=${estagio}`, `scanId=${id}`];
  if (extra?.desfecho) partes.push(`desfecho=${extra.desfecho}`);
  if (extra?.status && CANCEL_STATUS.has(extra.status)) partes.push(`status=${extra.status}`);
  partes.push(`ts=${new Date().toISOString()}`);
  console.log(`[ScanCancel] ${partes.join(" ")}`);
}

import type { FsErrorCategory } from "./scan-error.js";

/**
 * Agrega uma categoria de exclusão à lista publicada para a UI.
 *
 * Pura e imutável (fácil de testar sem scan nenhum). O `detail` só entra quando
 * é um token seguro (extensão/nome de ficheiro): exclusões por caminho ficam
 * sem detalhe — o caminho é do utilizador e não atravessa o IPC.
 */
/** Agrega um motivo de inconclusivo por categoria, sem caminhos. */
export function addInconclusiveReason(
  list: InconclusiveReasonCount[],
  reason: InconclusiveReason,
): InconclusiveReasonCount[] {
  const idx = list.findIndex((entry) => entry.reason === reason);
  if (idx < 0) return [...list, { reason, count: 1 }];
  const next = list.slice();
  next[idx] = { ...next[idx], count: next[idx].count + 1 };
  return next;
}

export function addExclusionReason(
  list: ExclusionReasonCount[],
  category: { reason: ExclusionReasonCount["reason"]; detail?: string } | null,
): ExclusionReasonCount[] {
  const reason: ExclusionReasonCount["reason"] = category?.reason ?? "path";
  const detail = reason === "path" ? undefined : category?.detail;
  const key = `${reason}:${detail ?? ""}`;
  const idx = list.findIndex((entry) => `${entry.reason}:${entry.detail ?? ""}` === key);
  if (idx < 0) return [...list, { reason, detail, count: 1 }];
  const next = list.slice();
  next[idx] = { ...next[idx], count: next[idx].count + 1 };
  return next;
}

/**
 * Registo persistente do fim de análises (R7-L3). Injectado pelo
 * engine — o caminho de `scans.jsonl` deriva do `baseDir` do
 * serviço. Opcional: sem ele, o scan corre exactamente como antes.
 */
export interface ScanHistoryRecorder {
  record(state: ExtendedScanState): Promise<void>;
}

/**
 * Contencao de caminhos (USB read-only): `alvo` esta' DENTRO de `raiz`?
 *
 * Comparacao por caminho relativo (`path.relative` cobre a
 * insensibilidade a maiusculas do Windows e as raizes de unidade), nunca
 * por `startsWith` de strings cruas — que aceitaria `C:\\PEN2` como se
 * estivesse dentro de `C:\\PEN`. Pura e testavel.
 */
export function estaContidoNaRaiz(raizResolvida: string, alvoResolvido: string): boolean {
  if (!raizResolvida || !alvoResolvido) return false;
  const relativo = path.relative(path.resolve(raizResolvida), path.resolve(alvoResolvido));
  return relativo === "" || (!relativo.startsWith("..") && !path.isAbsolute(relativo));
}

/** Interface to avoid circular dependency with engine.ts */
export interface ScanEngine {
  scanArtifact(
    filePath: string,
    source: ThreatEvent["source"],
    options?: { skipVirusTotal?: boolean; origin?: string; scanId?: string; readOnly?: boolean },
  ): Promise<FileScanResponse | null>;
  emitScanProgress(scanState: ScanState): void;
  /**
   * Gatekeeper de exclusões do motor. Quando implementado, o ScanManager deixa
   * de enviar ficheiros excluídos aos motores e conta-os como `filesExcluded`
   * (sem os apresentar como "analisados").
   */
  isExcluded?(filePath: string): boolean;
  /**
   * PORQUÊ o ficheiro foi excluído (categoria + detalhe seguro), ou null.
   * Opcional: sem isto os excluídos continuam a ser contados, mas a UI não os
   * consegue explicar — e o utilizador fica com um número sem origem.
   */
  exclusionCategory?(
    filePath: string,
  ): { reason: ExclusionReasonCount["reason"]; detail?: string } | null;
/**
   * Marca a INTENÇÃO de abortar um scan ANTE de o controller do motor existir.
   * O motor (`signalForScan`) lê esta marca quando criar o controller, para o
   * signal nascer já abortado.
   *
   * P1 — ABORT STICKY: um cancel que chegue na janela de looksLikeZip (antes
   * do motor criar o controller) era silencioso — o controller nascia depois,
   * vivo, e o batch arrancava com o scan já cancelado.
   */
  markScanAborted?(scanId: string): void;
  /**
   * Aborta o trabalho de MOTORES em curso (não o scan em si). O cancel de um
   * scan muda o estado, mas sem isto o `clamscan` que já tinha arrancado
   * continuava a varrer sozinho com ~1 GB de RAM, sem dono e sem forma de o
   * travar — o cancel só efirava a quando o loop voltasse a ver o estado.
   */
  abortEngineWork?(scanId: string): void;
  /**
   * FASE 4: corre UM clamscan para N ficheiros e guarda o veredicto de cada
   * um. Opcional — sem isto o motor corre um clamscan por ficheiro, que e
   * correcto e lento (o carregamento da base e pago N vezes).
   */
  prefetchClamav?(
    filePaths: string[],
    scanId?: string,
    onProgress?: (processedFiles: number) => void,
  ): Promise<{ spawned: boolean; error?: string; files?: number }>;
  /** Liberta o prefetch. Tem de ser chamado no `finally` do scan. */
  clearClamavPrefetch?(scanId?: string): void;
}

/**
 * Scan state as tracked by the worker. `ScanState` (shared-types) is the single
 * canonical contract for the whole pipeline (service → desktop → renderer);
 * `ExtendedScanState` adds diagnostic-only `failedByReason`, which is not part
 * of the IPC contract.
 */
export interface ExtendedScanState extends ScanState {
  /**
   * Failure reason → count, aggregated during gathering + scanning.
   * NUNCA transporta caminhos de ficheiros — só categorias (ver categorizeFsError).
   * É extra no runtime; normalizeScanState decide se o expõe à UI.
   */
  failedByReason?: Record<FsErrorCategory, number>;
  /**
   * Motivo agregado dos ficheiros inconclusivos. Extra no runtime, como
   * `failedByReason`; `normalizeScanState` decide se o expõe à UI.
   */
  inconclusiveByReason?: InconclusiveReasonCount[];
}

/**
 * Diagnostico opt-in (P0 SCANNER_RUNTIME_ZERO_PROGRESS). Nunca muda
 * comportamento: so escreve quando `CYBERSAFE_DEBUG_SCAN=1`, e os detalhes
 * passados aqui nunca contem caminhos de origem nem conteudo de ficheiros.
 * Mesmo formato do `scanPerfLog` do core, para uma linha do tempo unica.
 */
function scanPerfLog(event: string, scanId?: string, details = ""): void {
  if (process.env.CYBERSAFE_DEBUG_SCAN !== "1") return;
  console.log(
    `[ScanPerf] ${event} scanId=${scanId ?? "n/a"} at=${new Date().toISOString()}${details ? ` ${details}` : ""}`,
  );
}

// ── Quick Scan constants ──────────────────────────────────────────────
/** Maximum files a Quick Scan will gather (risk-based budget) */
export const QUICK_SCAN_BUDGET = 800;
/** Maximum recursion depth for Quick Scan directory walking */
const QUICK_SCAN_MAX_DEPTH = 2;
/** Maximum age in ms for a file to be considered "recent" (30 days) */
const QUICK_SCAN_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/** High-risk extensions prioritised by Quick Scan */
const HIGH_RISK_EXTENSIONS = new Set([
  ".exe", ".dll", ".msi", ".scr", ".com", ".ps1", ".bat", ".cmd",
  ".vbs", ".js", ".jar", ".lnk", ".docm", ".xlsm", ".pptm",
  ".zip", ".7z", ".rar", ".iso", ".img", ".wsf", ".wsh",
]);

/**
 * Quotas por raiz do quick scan.
 *
 * O gathering corre raiz a raiz. Sem quota, uma pasta com milhares de
 * candidatos (Downloads) enchia o orçamento antes de Desktop/Documents/
 * Startup/Temp serem lidas — a ordenação por risco acontecia depois, já sem
 * candidatos das outras áreas. Estas quotas são aplicadas ao conjunto reunido
 * de TODAS as raízes; o resto do orçamento é preenchido em round-robin.
 */
const QUICK_SCAN_ROOT_WEIGHTS = [0.4, 0.2, 0.1, 0.2, 0.1] as const;

/** Motivo agregado de um resultado inconclusivo. Nunca transporta caminhos. */
export type InconclusiveReason =
  | "engine-unavailable"
  | "engine-failed"
  | "no-verdict"
  | "coverage-incomplete";

export interface InconclusiveReasonCount {
  reason: InconclusiveReason;
  count: number;
}

/**
 * Distribui o orçamento do quick scan por TODAS as raízes já recolhidas.
 *
 * Cada raiz contribui primeiro com a sua quota (peso) e o restante é
 * preenchido em round-robin, com risco primeiro dentro de cada raiz. Uma raiz
 * grande deixa de poder consumir o orçamento antes das outras.
 * Pura e determinística — testada sem filesystem nem motores.
 */
export function allocateQuickScanCandidates(
  perRoot: ReadonlyArray<ReadonlyArray<string>>,
  budget: number,
): string[] {
  if (!Number.isFinite(budget) || budget <= 0) return [];
  const limit = Math.max(0, Math.floor(budget));
  const ordenadas = perRoot.map((root) => {
    const vistos = new Set<string>();
    const unicos = root.filter((p) => (vistos.has(p) ? false : (vistos.add(p), true)));
    const risco = unicos.filter((p) => HIGH_RISK_EXTENSIONS.has(path.extname(p).toLowerCase()));
    const resto = unicos.filter((p) => !HIGH_RISK_EXTENSIONS.has(path.extname(p).toLowerCase()));
    return [...risco, ...resto];
  });
  const ativas = ordenadas
    .map((root, index) => ({ root, index }))
    .filter((entry) => entry.root.length > 0);
  if (ativas.length === 0) return [];

  const totalPeso = ativas.reduce(
    (soma, { index }) => soma + (QUICK_SCAN_ROOT_WEIGHTS[index] ?? 0.1),
    0,
  );
  const quotas = ativas.map(({ index }) =>
    Math.max(1, Math.floor((limit * (QUICK_SCAN_ROOT_WEIGHTS[index] ?? 0.1)) / totalPeso)),
  );

  const picked: string[] = [];
  const usados = ativas.map(() => 0);
  const vistos = new Set<string>();
  const identity = (p: string) => path.win32.normalize(p).toLowerCase();
  const incluir = (p: string): boolean => {
    if (picked.length >= limit || vistos.has(identity(p))) return false;
    vistos.add(identity(p));
    picked.push(p);
    return true;
  };

  ativas.forEach(({ root }, idx) => {
    const quota = Math.min(root.length, quotas[idx]);
    for (let i = 0; i < quota; i += 1) incluir(root[i]);
    usados[idx] = quota;
  });

  let restante = limit - picked.length;
  while (restante > 0) {
    let avancou = false;
    for (let idx = 0; idx < ativas.length && restante > 0; idx += 1) {
      const root = ativas[idx].root;
      while (usados[idx] < root.length && vistos.has(identity(root[usados[idx]]))) usados[idx] += 1;
      if (usados[idx] >= root.length) continue;
      incluir(root[usados[idx]]);
      usados[idx] += 1;
      restante -= 1;
      avancou = true;
    }
    if (!avancou) break;
  }
  return picked;
}

// Full Scan cap
const FULL_SCAN_MAX_FILES = 50000;

export class ScanManager {
  private activeScans = new Map<string, ExtendedScanState>();
  /**
   * Scans USB read-only em curso (por id). O motor recebe `readOnly` em
   * cada `scanArtifact` e o walk nao sai da raiz resolvida.
   */
  private readonly scansSomenteLeitura = new Set<string>();
  private currentScanPromise: Promise<void> | null = null;
  private isCancelled = new Set<string>();
  /** A ZIP candidate is incomplete if any internal entry could not be evaluated. */
  private readonly archiveCoverageGaps = new Set<string>();

  /**
   * Opções SÓ de teste: a lease de locks é uma primitiva nativa cujo
   * `CloseHandle` não falha de propósito, e a única forma honesta de
   * exercitar o ramo «libertação não confirmada» é substituí-la no teste
   * (mesmo padrão do `forkImpl` do watcher). Em produção é SEMPRE o
   * `pinFixture` real.
   */
  private readonly fixtureLeaseFactory: typeof pinFixture;
  constructor(
    private engine: ScanEngine,
    private history?: ScanHistoryRecorder,
    options: { fixtureLeaseFactory?: typeof pinFixture } = {},
  ) {
    this.fixtureLeaseFactory = options.fixtureLeaseFactory ?? pinFixture;
  }

  public getActiveScans(): ExtendedScanState[] {
    return Array.from(this.activeScans.values());
  }

  /**
   * Currently running (or queued) scan, if any.
   * This is the backend source of truth the UI resyncs against after a remount
   * or a page navigation, so a running scan is never lost by the renderer.
   */
  public getActiveScan(): ExtendedScanState | null {
    for (const state of this.activeScans.values()) {
      if (state.status === "running" || state.status === "queued") return state;
    }
    return null;
  }

  /** Resultado terminal em memória; não altera a semântica de getActiveScan. */
  public getLastScan(id?: string): ExtendedScanState | null {
    const state = id === undefined
      ? Array.from(this.activeScans.values()).at(-1)
      : this.activeScans.get(id);
    if (!state || !["completed", "cancelled", "failed"].includes(state.status)) return null;
    return structuredClone(state);
  }

  public getScan(id: string): ExtendedScanState | undefined {
    return this.activeScans.get(id);
  }

  public cancelScan(id: string): CancelDesfecho {
    if (!this.activeScans.has(id)) {
      // Desconhecido é um facto por si: sem registo em curso não há nada para cancelar,
      // e sintetizar um terminal seria inventar um acontecimento que não aconteceu.
      linhaDeCancelamento(this, "processado", id, { desfecho: "desconhecido" });
      return "desconhecido";
    }
    // P1-4 — IDEMPOTENTE, e a marca entra ANTES de qualquer trabalho.
    //
    // O `isCancelled.add` tem de ser a PRIMEIRA coisa: um segundo `cancelScan`
    // que chegue enquanto o primeiro está a abortar o motor encontra o estado
    // já `cancelled` e saía pelo ramo de baixo — mas a marca de cancelamento
    // nunca era posta se esse ramo não existisse. Por isso o guard é o estado
    // terminal, não a ausência do registo.
    this.isCancelled.add(id);
    const state = this.activeScans.get(id)!;
    if (state.status === "cancelled") {
      // Já está cancelado: publicar outra vez seria um segundo evento com o
      // mesmo facto, e o renderer contaria dois cancelamentos.
      linhaDeCancelamento(this, "processado", id, { desfecho: "ja_terminal" });
      return "ja_terminal";
    }
if (state.status === "running" || state.status === "queued") {
       // O estado muda, E o motor em curso é abortado. Cancelar sem abortar
       // deixava o clamscan a trabalhar sozinho com quase 1 GB de RAM.
       //
       // P1 — ABORT STICKY: a intenção entra ANTES de o controller do motor
       // existir. Um cancel que chegar na janela de looksLikeZip (antes do
       // motor criar o AbortController) só abortava um controller que ainda
       // não existia; o motor nascia depois, vivo, e o batch arrancava com o
       // scan já cancelado. `markScanAborted` guarda a intenção em
       // `scanAbortIntents` e o `signalForScan` lê-a quando criar o
       // controller, para o signal nascer já abortado.
       this.engine.markScanAborted?.(id);
       this.engine.abortEngineWork?.(id);
      // `filesInEngineBatch: 0` e dito AQUI porque passa a ser verdade AQUI:
      // o abort mata o processo do clamscan (medido: engine.ts -> signal ->
      // core `handle.killTree()`), portanto ja nao ha nenhum ficheiro dentro
      // do batch a partir deste instante.
      //
      // MEDIDO (P1 cancel-mid-batch, teste 4): sem isto, o evento terminal e o
      // `getScan` ficavam a dizer "20 ficheiros no batch" para sempre — a
      // zeroagem no `finally` do prefetch chegava depois, mas a guarda TERMINAL
      // descarta qualquer escrita posterior, e o `waitTerminal` da UI le o
      // estado entre o cancel e esse `finally`. O facto dito na altura certa
      // nao precisa de republica tardia: nenhuma via pode voltar a subir o
      // contador depois do terminal, porque todas passam por esta guarda.
      // «Processado» é dito ANTES da escrita terminal: este estágio afirma que o manager
      // aceitou e tratou o pedido. O terminal tem de ser provado pelos seus próprios
      // estágios — é exatamente aí que um ACK otimista mente, e é por isso que a resposta
      // do handler continua `{ success: true }` (contrato) enquanto o registo diz a
      // verdade em três partes.
      linhaDeCancelamento(this, "processado", id, { desfecho: "cancelado" });
      // TERMINAL COERENTE (medido na prova integrada, 2026-10-23): um cancelamento a
      // meio deixa no estado o `progress` e o `filesAnalyzed` que a etapa do motor
      // publicou — 400 ficheiros «analisados» e 99% quando o scanner só tinha aceite
      // 61. O terminal de um cancelado tem de dizer o que este scan efectivamente
      // fechou: `filesScanned` conta tudo o que fechou ciclo (analisado, excluído ou
      // falhado), e os veredictos aceites são o que sobra depois de excluídos e
      // falhados. Um cancelado nunca é 100 nem prova análise completa.
      const totalCancelado = state.filesTotal ?? 0;
      const aceitesCancelado = Math.max(
        0,
        (state.filesScanned ?? 0) - (state.filesExcluded ?? 0) - (state.filesFailed ?? 0),
      );
      this.updateScan(id, {
        status: "cancelled",
        endTime: new Date().toISOString(),
        filesInEngineBatch: 0,
        filesAnalyzed: aceitesCancelado,
        // Tecto 99, não 100: «cancelado nunca é 100» é um INvariante do contrato,
        // não uma consequência de corrida. Mesmo que `filesScanned` já iguale o
        // total no instante exacto em que o cancelamento chega (o último `emit` do
        // loop publica 100 com `status: running`), um scan cancelado não pode
        // afirmar conclusão. O `completed` mantém o 100 dele.
        progress: totalCancelado > 0
          ? Math.min(99, Math.floor(((state.filesScanned ?? 0) / totalCancelado) * 100))
          : 0,
      });
      return "cancelado";
    }
    // Terminal por outro motivo (completed/failed entretanto): nada a cancelar, e não se
    // publica um `cancelled` por cima de um terminal que já existe.
    linhaDeCancelamento(this, "processado", id, { desfecho: "ja_terminal" });
    return "ja_terminal";
  }

  private updateScan(id: string, updates: Partial<ExtendedScanState>) {
    const current = this.activeScans.get(id);
    if (current) {
      // P1-4 — UM ESTADO TERMINAL É TERMINAL.
      //
      // MEDIDO: sem esta porta, `cancelScan` escrevia `cancelled`, e o
      // `runScanLoop` escrevia `running` logo a seguir (a linha
      // `updateScan(id, { status: "running" })` corre depois de o cancelamento
      // ja ter chegado). O utilizador via um scan cancelado voltar a correr, e o
      // motor trabalhava com a memoria que o cancelamento prometeu libertar.
      //
      // MEDIDO (P1-4-F): esta porta so bloqueava quando o `incoming` NAO era
      // terminal — logo um `incoming` terminal PASSAVA. `cancelled -> completed`
      // passava, e `cancelled -> failed` passava pelo `catch` exterior do
      // `runScanLoop` quando um erro de motor chegava depois do cancelamento. O
      // utilizador cancelava, via "cancelado", e o scan passava a "falhou" com
      // a mensagem do clamscan. O comentario prometia "terminal nao e revogavel"
      // e o codigo nao cumpria.
      //
      // A promessa cumprida e UMA guarda: se o estado ACTUAL e terminal, NADA o
      // substitui. As tres guardas anteriores (incoming nao-terminal, incoming
      // igual ao corrente, e incoming ausente) eram casos particularizados deste
      // mesmo — ficam subsumidas, e o medido de cada uma fica registado aqui:
      //
//  - `updateScan` sem `status` (o `phase: "gathering"`, os contadores, o
       //    `filesInEngineBatch`) fazia spread do estado corrente — que ja era
       //    `cancelled` — e voltava a EMITIR. O renderer via um segundo
       //    `cancelled` e contava dois cancelamentos para o mesmo facto.
       //
       //    EXCEÇÃO INTENCIONAL (P2, heartbeat): `updateScan(id, {})` com um
       //    objeto VAZIO é o caso legítimo de "não há nada de novo no estado,
       //    mas a revisão tem de avançar". O heartbeat a cada 1 s chama-o para
       //    dizer "ainda estou vivo" sem alterar qualquer campo — e o contrato
       //    de revisão estritamente crescente exige que a revisão suba a cada
       //    emissão. Um objeto vazio não tem `status`, por isso o spread não
       //    reescreve o estado corrente; o que muda é a revision (sempre +1) e
       //    o updatedAt. O renderer vê um snapshot novo com o mesmo conteúdo.
       //  - `cancelScan` e `runScanLoop` escreviam ambos `cancelled`, e o renderer
      //    via DOIS eventos para o mesmo facto. Republicar obriga o renderer a
      //    adivinhar; um snapshot idempotente e o que lhe permite ser
      //    idempotente.
      //
      // O que a guarda nao muda, porque ja estava aprovado assim: o heartbeat so
      // escreve em `running`/`queued` (a guarda de 1 s no `runScanLoop`), logo
      // nunca chega aqui com um scan terminal; e a revisao monotonica so sobe
      // quando ha uma emissao a fazer, porque um terminal bloqueado nao emite.
      const TERMINAL: ReadonlyArray<ExtendedScanState["status"]> = ["cancelled", "completed", "failed"];
      if (TERMINAL.includes(current.status)) {
        return;
      }
      // Revisão monotónica: cada emissão tem uma revisão estritamente maior, para
      // que o renderer possa rejeitar um snapshot/evento atrasado (que faria os
      // contadores recuarem).
      const revision = (updates.revision ?? current.revision ?? 0) + 1;
      const updated: ExtendedScanState = {
        ...current,
        ...updates,
        revision,
        updatedAt: new Date().toISOString(),
      };
      this.activeScans.set(id, updated);
      if (process.env.CYBERSAFE_DEBUG_SCAN === "1") {
        console.log(`[ScanManager] emit id=${id} rev=${revision} status=${updated.status} progress=${updated.progress} files=${updated.filesScanned}/${updated.filesTotal ?? "?"} analyzed=${updated.filesAnalyzed ?? 0} excluded=${updated.filesExcluded ?? 0} failed=${updated.filesFailed ?? 0} phase=${updated.phase} at=${new Date().toISOString()}`);
      }
      // R7-L3 — histórico persistente. A guarda terminal acima garante
      // que esta transição acontece UMA vez por scanId: o registo é
      // exactamente-once por análise, assíncrono e sem impacto no scan
      // (o recorder nunca rejeita e nunca bloqueia o estado).
      // O emitScanProgress é notificação ao renderer; nunca pode impedir
      // o registo persistente do estado terminal. Se a emissão lançar,
      // o historial ainda deve ser gravado (terminal vs history: nunca
      // deixamos o estado terminal na memoria sem tentativa de registo).
      //
      // #38 (terminal vs history, retoma Qoder): o registo é INICIADO
      // ANTES do emit. A UI refresca o historico em resposta ao evento
      // terminal (ScanHistoryPanel via sessionTerminada); com o emit
      // primeiro, a leitura disparada pelo evento podia chegar ao
      // ficheiro antes da linha em curso na chain do record
      // (scan-history.ts: `chain.then(run)` -> readEntries -> appendFile).
      // ScanHistory.query captura e aguarda a chain já enfileirada antes de
      // ler, pelo que uma consulta iniciada pelo evento terminal vê o commit
      // desta tentativa. Esta espera pertence à query, nunca ao scan/emissor.
      // O `void ... .catch` mantem-se: o recorder nunca rejeita e nunca
      // bloqueia a emissao. O try/catch protege apenas o caso de um
      // recorder lancar de forma sincrona — isso nao pode suprimir o
      // evento terminal ao renderer.
      if (TERMINAL.includes(updated.status)) {
        try {
          if (updated.status === "cancelled" && typeof this.history?.record === "function") {
            // «emitido» e «o histórico processou» não são a mesma coisa, e nenhum dos dois é
            // «gravado». `ScanHistory.record` absorve a falha do append e resolve de qualquer
            // forma (scan-history.ts: tenta, apanha, resolve) — por isso o `then` NÃO pode
            // alegar persistência, e não existe ramo de falha para alegar. A gravação é
            // provada à parte, pela consulta do histórico.
            void Promise.resolve(this.history.record(updated)).then(
              () => linhaDeCancelamento(this, "terminal_historico_processado", id, { status: updated.status }),
            );
          } else {
            void this.history?.record(updated).catch(() => undefined);
          }
        } catch {
          // registo falhado de forma sincrona: o emit segue e a guarda
          // terminal ja garantiu o estado em memoria.
        }
      }
      this.engine.emitScanProgress(updated);
      if (updated.status === "cancelled") {
        // «emitido» = o emissor do serviço aceitou o estado terminal e devolveu sem lançar.
        // É um facto diferente de «o histórico processou a tentativa» e diferente do ACK
        // do handler: três coisas distintas, três linhas distintas.
        linhaDeCancelamento(this, "terminal_emitido", id, { status: updated.status });
      }
    }
  }

  public async startScan(
    type: ScanType,
    targetPath?: string,
    options?: {
      readOnly?: boolean;
      /**
       * Confirmação terminal OPCIONAL (USB): corre imediatamente antes de o
       * scan declarar `completed`, para provar que o alvo ainda está lá com a
       * MESMA identidade na MESMA raiz. Só o adapter USB a fornece — um scan
       * normal não tem callback e o terminal mantém-se exactamente como antes.
       * `{ ok: false }` (ou lançar) ⇒ terminal seguro, NUNCA `completed`.
       */
      confirmarTerminal?: () => Promise<{ ok: boolean; motivo?: string }>;
    },
  ): Promise<string | null> {
    // ONE ACTIVE SCAN: the backend refuses a second scan instead of queueing it
    // silently, so the UI can never end up with several accidental workers.
    // Cancelled is visible to the caller before the worker has finished its
    // finally block (engine abort, prefetch cleanup and promise release). Keep
    // the single-scan lock until that worker settles, or a second scan can
    // overlap the first scan's ClamAV teardown.
    // Tipo validado na fronteira: um tipo fora de quick|full|custom nao pode
    // chegar a resolvePathsForScan (que devolveria [] e fecharia em failed sem
    // causa clara). Erro explicito antes de tocar no estado do scanner.
    if (type !== "quick" && type !== "full" && type !== "custom") {
      throw new Error(`Tipo de análise inválido: "${String(type)}". Use quick, full ou custom.`);
    }
    if (this.currentScanPromise || this.getActiveScan()) {
      return null;
    }

    const id = randomUUID();
    // USB: scan estritamente read-only — nenhuma quarentena, nenhuma
    // escrita no dispositivo e nenhuma saida da raiz resolvida.
    if (options?.readOnly === true) this.scansSomenteLeitura.add(id);
    const state: ExtendedScanState = {
      id,
      type,
      status: "queued",
      progress: 0,
      filesScanned: 0,
      filesAnalyzed: 0,
      filesInconclusive: 0,
      filesExcluded: 0,
      filesFailed: 0,
      threatsFound: 0,
      revision: 0,
      sessionSequence: this.activeScans.size + 1,
      startTime: new Date().toISOString(),
      targetPath,
      phase: "preparing",
    };

    this.activeScans.set(id, state);

    // O ponto de entrada do pedido: sem isto a linha do tempo comeca a meio e
    // nao se distingue "o scan nunca comecou" de "comecou e parou depois".
    scanPerfLog(
      type === "quick" ? "QUICK_SCAN_ACCEPTED" : "SCAN_ACCEPTED",
      id,
      `type=${type} target=${targetPath ? "custom" : "default"}`,
    );

    // We run the scan async and don't block
    void this.runScanLoop(id, type, targetPath, options?.confirmarTerminal);
    return id;
  }

  /**
   * Corre a confirmação terminal injetada e distingue "confirmado" de "não
   * confirmado". NUNCA lança: um erro do callback é uma recusa declarada —
   * falhar a confirmar não pode transformar-se num `completed`.
   */
  private async confirmarTerminal(
    id: string,
    confirmar: () => Promise<{ ok: boolean; motivo?: string }>,
  ): Promise<string | null> {
    try {
      const resultado = await confirmar();
      if (resultado && resultado.ok === true) return null;
      const motivo = typeof resultado?.motivo === "string" ? resultado.motivo.trim() : "";
      return motivo !== "" ? motivo : "alvo não confirmado no fim da análise — resultado não publicado";
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      scanPerfLog("SCAN_TERMINAL_CONFIRMACAO_ERRO", id, `erro=${mensagem}`);
      return `confirmação do alvo falhou no fim da análise (${mensagem}) — resultado não publicado`;
    }
  }

  private async runScanLoop(
    id: string,
    type: ScanType,
    targetPath?: string,
    confirmarTerminal?: () => Promise<{ ok: boolean; motivo?: string }>,
  ) {
    if (this.isCancelled.has(id)) {
      this.isCancelled.delete(id);
      return;
    }

    let resolveScan: () => void;
    this.currentScanPromise = new Promise(r => { resolveScan = r; });

    // Check again after acquiring the promise — race with cancel
    if (this.isCancelled.has(id)) {
      resolveScan!();
      this.currentScanPromise = null;
      return;
    }

    // Files discovered during gathering — mutated in place and read live by the
    // heartbeat below (a filesystem walk can take a long time without producing
    // per-file events, which used to leave the UI blind during "gathering").
    const files: string[] = [];

    // USB read-only: raiz resolvida (realpath) para garantir que nenhuma
    // entrada escapa por junction/reparse point. `null` = raiz nao
    // resolvivel: nesse caso nada e' analisado (guarda no loop abaixo).
    const somenteLeitura = this.scansSomenteLeitura.has(id);
    const raizReal = somenteLeitura && targetPath ? await fs.realpath(targetPath).catch(() => null) : null;
    let foraDaRaiz = 0;

    // ── TP-PAP-FREEBUFF-TOCTOU-20261027: a prova do gate vale no INSTANTE DO USO ──
    //
    // O gate prova o alvo no `scan.start`; este loop corre depois e abre caminhos
    // outra vez. Sem re-verificação, uma junction criada nesse intervalo (ou uma
    // pasta/ficheiro substituído no mesmo caminho) era analisada como se fosse o
    // corpus validado. A prova é a identidade efectiva (dev+ino, por handle)
    // capturada na validação; divergência ⇒ falha FECHADA, nada do objecto novo
    // vai ao motor.
    //
    // Fixture-only: share-read locks pin the full ancestor chain and corpus
    // objects through all prefetch/per-file engine reopens. stat is diagnostic,
    // never the protection against a replacement after the final check.
    const fixtureMontado =
      String(process.env[FIXTURE_SCAN_FLAG] ?? "") === "1" && gateDeFixtureMontadoPara(this).montado;
    const snapshotValidado: SnapshotFixture | null =
      fixtureMontado && targetPath ? obterSnapshotValidado(targetPath) : null;
    let fixtureLease: ReturnType<typeof pinFixture> | undefined;
    /** Terminal seguro: uma prova quebrada NUNCA se transforma em `completed`. */
    const falhaFixture = (motivo: string) => {
      scanPerfLog("FIXTURE_IDENTIDADE_RECUSADA", id, motivo);
      this.updateScan(id, {
        status: "failed",
        phase: "finalizing",
        error: motivo,
        endTime: new Date().toISOString(),
      });
    };

    // Heartbeat: keep publishing the current state while the scan works, so the
    // UI can distinguish "engine busy" from "engine unreachable" (watchdog).
const heartbeat = setInterval(() => {
       const state = this.activeScans.get(id);
       // P1-4 — o heartbeat só existe para dizer "ainda estou vivo". Reemitir o
       // ESTADO EM CACHE num scan já terminal publicava um segundo `cancelled`
       // (MEDIDO) — e um renderer que conta eventos via dois cancelamentos para o
       // mesmo facto. Terminal é terminal: não há nada a anunciar.
       if (!state || (state.status !== "running" && state.status !== "queued")) return;
       if (state.phase === "gathering") {
         this.updateScan(id, { filesDiscovered: files.length });
       } else {
         // P2 — CONTRATO DE REVISÃO (scan-manager.ts:210-214).
         //
         // Cada emissão tem uma revisão ESTRITAMENTE crescente, para o renderer
         // poder rejeitar um snapshot/evento atrasado (que faria os contadores
         // recuarem). O heartbeat chamava `emitScanProgress(state)` DIRETAMENTE,
         // contornando `updateScan` — a mesma instância de estado, com a MESMA
         // revision, era reemitida a cada segundo. Um renderer que compara por
         // revision via um heartbeat a cada 1 s com a mesma revisão, e o
         // snapshot mais recente nunca avançava.
         //
         // MEDIDO: sem isto, o `events` do renderer recebia N snapshots idênticos
         // com revision constante; o `currentRevision` do scanSession nunca
         // subia e o heartbeat era invisível.
         //
         // A correção passa por `updateScan(id, {})`: um update sem mudanças de
         // significado, mas com revision+1 e updatedAt novo. O estado é o mesmo,
         // a revisão avança — o contrato cumpre-se e o heartbeat é visível.
         this.updateScan(id, {});
       }
     }, 1000);

    this.updateScan(id, { status: "running", phase: "preparing" });

    try {
      // A prova, quando existe, é re-verificada ANTES de qualquer leitura.
      if (fixtureMontado) {
        if (type !== "custom" || !targetPath) {
          return falhaFixture(`${GATE_CODE}: sessão de fixture só aceita scan custom validado — análise recusada`);
        }
        if (!snapshotValidado) {
          return falhaFixture(`${GATE_CODE}: sem validação de identidade registada para este alvo — análise recusada`);
        }
        // Acquire before gather, prefetch, ZIP reads or any engine handoff.
        // Identity is verified on the locked HANDLE; acquisition failure
        // releases partial handles and fails closed before analysis.
        fixtureLease = this.fixtureLeaseFactory(snapshotValidado);
        const deriva = alvoAindaIntacto(snapshotValidado);
        if (deriva) {
          return falhaFixture(`${GATE_CODE}: ${deriva} — análise recusada`);
        }
      }

      const maxFiles = type === "quick" ? QUICK_SCAN_BUDGET : FULL_SCAN_MAX_FILES;
      const pathsToScan = await this.resolvePathsForScan(type, targetPath);
      let scanned = 0;
      let analyzed = 0;
      let excluded = 0;
      let threats = 0;
      let filesFailed = 0;
      let filesInconclusive = 0;
      let inconclusiveByReason: InconclusiveReasonCount[] = [];
      /** Razões de ficheiros inacessíveis, agregadas por categoria. */
      let failedByReason: Record<FsErrorCategory, number> = {} as Record<FsErrorCategory, number>;
      // PORQUÊ cada ficheiro ficou fora dos motores — agregado por categoria.
      // É o dado que permite explicar (sem inventar) a diferença entre
      // "ficheiros considerados" e "ficheiros analisados".
      let excludedBy: ExclusionReasonCount[] = [];
      // Ficheiros que o motor de assinaturas JA analysed dentro do batch. Vive
      // no scope do scan (e nao dentro do `if` do prefetch) porque o loop por
      // ficheiro tambem o precisa: sem isto o contador recua de N para 1 quando
      // o batch termina.
      let analisadosNoBatch = 0;

      // 0. Custom scan: reportar o tipo real do alvo (ficheiro ou pasta). Isto é
      // informação do serviço, por isso a UI continua correta mesmo depois de
      // ressincronizar (voltar à página a meio de um scan).
      if (type === "custom" && targetPath) {
        const targetStat = await fs.lstat(targetPath).catch(() => null);
        const targetKind = targetStat?.isFile()
          ? "file"
          : targetStat?.isDirectory()
            ? "directory"
            : undefined;
        // Num ficheiro único, o nome a analisar fica visível desde o início.
        this.updateScan(id, {
          targetKind,
          currentFile: targetKind === "file" ? path.basename(targetPath) : undefined,
        });
      }

      // 1. Gather files
      const gatherStart = Date.now();
      const gatherStats = { failed: 0, failedByReason: {} as Record<FsErrorCategory, number> };
      this.updateScan(id, {
        phase: "gathering",
        filesDiscovered: 0,
        filesScanned: 0,
        filesAnalyzed: 0,
        filesInconclusive: 0,
        filesExcluded: 0,
        filesFailed: 0,
        progress: 0,
      });
      if (type === "quick") {
        // Quick scan: recolher cada raiz até ao orçamento (nunca mais do que
        // isso) e só depois distribuir. A ordem de recolha deixa de ser a
        // ordem de seleção, por isso Downloads não esgota o limite.
        const porRaiz: string[][] = [];
        for (const p of pathsToScan) {
          if (this.isCancelled.has(id)) break;
          const destaRaiz: string[] = [];
          await this.gatherFilesQuick(p, destaRaiz, id, 0, QUICK_SCAN_MAX_DEPTH, maxFiles, gatherStats);
          porRaiz.push(destaRaiz);
        }
        const selectionStarted = Date.now();
        files.push(...allocateQuickScanCandidates(porRaiz, maxFiles));
        scanPerfLog("SELECTION", id, `elapsedMs=${Date.now() - selectionStarted} gathered=${porRaiz.reduce((sum, root) => sum + root.length, 0)} selected=${files.length}`);
      } else {
        for (const p of pathsToScan) {
          if (this.isCancelled.has(id)) break;
          await this.gatherFiles(p, files, id, maxFiles, gatherStats);
          if (files.length >= maxFiles) break;
        }
      }

      // Sort quick scan files: high-risk extensions first, then recent first
      if (type === "quick") {
        files.sort((a, b) => {
          const extA = path.extname(a).toLowerCase();
          const extB = path.extname(b).toLowerCase();
          const riskA = HIGH_RISK_EXTENSIONS.has(extA) ? 0 : 1;
          const riskB = HIGH_RISK_EXTENSIONS.has(extB) ? 0 : 1;
          return riskA - riskB;
        });
      }

      scanPerfLog(
        "FILES_DISCOVERED",
        id,
        `count=${files.length} roots=${pathsToScan.length} elapsedMs=${Date.now() - gatherStart}`,
      );

      // O total REAL de candidatos fica congelado aqui: é o denominador do
      // progresso. FULL_SCAN_MAX_FILES é um cap de segurança, não um total.
      // Inclui diretórios inacessíveis encontrados no gathering: eles fazem
      // parte do total considerado, mesmo não tendo sido enumerados.
      const totalFiles = files.length + gatherStats.failed;
      scanPerfLog(
        "FILES_SELECTED",
        id,
        `count=${totalFiles} budget=${maxFiles} type=${type} failed=${gatherStats.failed}`,
      );
      if (totalFiles === 0) {
        // Explicit terminal state — a zero-file scan must never stay "running".
        //
        // Mas NUNCA sobrescreve um estado terminal já decidido. O caso real:
        // cancelar durante a gathering parte a recolha, `files` fica vazio e
        // este ramo escrevia `completed` + `progress: 100` por cima do
        // `cancelled` — dois estados terminais para o mesmo scan, com o
        // cancel do utilizador ignorado. Um scan cancelado é cancelado.
        const statusNow = this.activeScans.get(id)?.status;
        if (statusNow !== "running" && statusNow !== "queued") {
          return;
        }
        // Nenhum ficheiro para analisar = erro, nunca "concluído". Um alvo inválido
        // ou sem ficheiros não pode parecer uma análise feita (decisão do utilizador).
        this.updateScan(id, {
          status: "failed",
          phase: "finalizing",
          error: "Nenhum ficheiro para analisar no alvo selecionado.",
          filesDiscovered: 0,
          filesTotal: 0,
          filesScanned: 0,
          endTime: new Date().toISOString(),
        });
        return;
      }

       // Inicializa os contadores com as entradas inacessíveis do gathering:
       // estes ficheiros/directórios não puderam ser lidos, mas são
       // candidatos considerados e contam como falhados no pipeline.
       scanned = gatherStats.failed;
       filesFailed = gatherStats.failed;
       failedByReason = { ...(gatherStats.failedByReason || {}) } as Record<FsErrorCategory, number>;

      // Transition to scanning phase
       this.updateScan(id, { phase: "scanning", progress: 0, filesDiscovered: files.length, filesTotal: totalFiles, filesScanned: gatherStats.failed, filesProcessed: gatherStats.failed, filesFailed: gatherStats.failed, failedByReason: Object.keys(gatherStats.failedByReason).length > 0 ? { ...gatherStats.failedByReason } : undefined });

      // Fixture: segunda verificação do alvo, com o gather fechado — uma
      // substituição que tenha acontecido DURANTE o gather não passa daqui.
      if (snapshotValidado) {
        const deriva = alvoAindaIntacto(snapshotValidado);
        if (deriva) {
          return falhaFixture(`${GATE_CODE}: ${deriva} — análise recusada`);
        }
      }

      // 2. Scan files
      const startTime = Date.now();
      let lastEmit = 0;
      // Profiling DEV agregado (nunca por ficheiro, só com CYBERSAFE_DEBUG_SCAN=1).
      const perfEnabled = process.env.CYBERSAFE_DEBUG_SCAN === "1";
      let engineMs = 0;
      let zipCount = 0;

      // FASE 4 (P0 CLAMAV_RESOURCE_EXHAUSTION): UM clamscan para o scan todo.
      //
      // O clamscan paga ~6,2 s e ~981 MB de carregamento de base POR PROCESSO.
      // Com um spawn por ficheiro, um scan de 20 ficheiros custava ~2 minutos
      // e ia somando hundreds de MB. Numa unica invocacao custam-se uma vez.
      //
      // O que continua igual: a analise por ficheiro, os threat records, a
      // quarentena, o progresso e o cancelamento. O clamscan e o unico motor
      // que se move, e o resultado continua a ser por ficheiro.
      if (this.engine.prefetchClamav && !this.isCancelled.has(id)) {
        // So os ficheiros que realmente vao aos motores: um excluido nao
        // conta como analisado, e um ZIP e tratado pelo `scanZipWithSafety`.
        const candidatos: string[] = [];
        // Porque um ficheiro selecionado fica FORA do batch: e' isto que explica
        // SELECTED=800 -> PREFETCH=728 sem inventar. Nunca duas causas para o
        // mesmo ficheiro (o loop de exclusao e o de zip sao mutuamente
        // exclusivos).
        let skippedExcluded = 0;
        let skippedZip = 0;
        // Os ZIP continuam a ser um candidato proprio na decomposicao
        // (selected = candidatos + excluidos + zip), mas o ficheiro EXTERNO do
        // arquivo pode ser verificado no mesmo batch de ClamAV em vez de pagar
        // um cold start por arquivo. Nao muda a contagem de candidatos nem o
        // eixo de progresso.
        const zipOuterPaths: string[] = [];
        for (const file of files) {
          if (this.isCancelled.has(id)) break;
          if (snapshotValidado) {
            const deriva = identidadeAindaBate(snapshotValidado, file);
            if (deriva) {
              return falhaFixture(`${GATE_CODE}: ${deriva} — análise recusada sem tocar no novo objecto`);
            }
          }
          if (this.engine.isExcluded?.(file)) {
            skippedExcluded++;
            continue;
          }
          const isZip =
            path.extname(file).toLowerCase() === ".zip" || (await this.looksLikeZip(file));
          if (snapshotValidado && isZip) {
            return falhaFixture(`${GATE_CODE}: arquivos exigem uma lease própria para entradas extraídas — análise recusada`);
          }
          // P1 — JANELA DE CANCEL DURANTE looksLikeZip (Codex finding).
          //
          // `await this.looksLikeZip(file)` é um ponto de suspensão: se
          // cancelScan chegar DURANTE esse await, o ciclo prosseguava sem
          // revalidar e o ficheiro entrava em `candidatos`. Re-verificar
          // imediatamente depois do await, antes de push, é a defesa na
          // própria linha onde o ciclo perdeu o último controlo.
          //
          // MEDIDO (scan-cancel-prefetch-window.test.js): sem esta
          // re-verificação, prefetchClamav era chamado com
          // calledWhileCancelled=true e o signal criado no interior do engine
          // nunca nasceria abortado.
          if (this.isCancelled.has(id)) break;
          if (isZip) {
            skippedZip++;
            zipOuterPaths.push(file);
            continue;
          }
          candidatos.push(file);
        }
        // P1 — JANELA DE CANCEL DURANTE looksLikeZip (defesa em profundidade).
        //
        // O re-check de dentro do ciclo cobre um cancel que chega DURANTE um
        // await looksLikeZip. Este re-check cobre um cancel que chega DEPOIS do
        // último looksLikeZip (o ciclo terminou, mas `candidatos` está
        // preenchido e o `if (candidatos.length > 0)` seguinte não
        // revalidava). É o ponto onde o ciclo perdeu o último controlo.
        //
        // MEDIDO (scan-cancel-prefetch-window.test.js, teste 2): sem esta
        // verificação, o segundo teste era RED — prefetchClamav era chamado
        // após o último looksLikeZip com o scan já cancelado.
        if (this.isCancelled.has(id)) {
          scanPerfLog("PREFETCH_CANCELLED_BEFORE_START", id, `candidatos=${candidatos.length}`);
        } else if (candidatos.length > 0) {
          const prefetchStarted = Date.now();
          // O batch demora ~7,6 s (carrega ~1 GB de base) e devolve TUDO de uma
          // vez. Sem publicar o count, a UI ficava 7 s a dizer "A verificar os
          // ficheiros encontrados" com 0% e 0 f/s — descrevendo um trabalho que
          // ainda não tinha começado. Isto diz a verdade: estão N ficheiros
          // dentro do clamscan, e ainda não foi avaliado nenhum.
          this.updateScan(id, { filesInEngineBatch: candidatos.length });

          // O clamscan vai dizendo, linha a linha, quantos ficheiros ja varreu.
          // Publicamos isso como o que e': ficheirosJA ANALISADOS pelo motor de
          // assinaturas. Nao e' um temporizador nem uma animacao — e' a contagem
          // das linhas que o clamscan escreveu.
          //
          // `analisadosNoBatch` e' o maximo visto, porque o numero so cresce. Continua
          // a ser o eixo DA ETAPA do motor — é isto que distingue "clamscan já varreu
          // N ficheiros" de "a scanner já ACEITOU N veredictos".
          //
          // DECISÃO (2026-10-23, medido na prova integrada): a etapa NÃO escreve
          // `filesAnalyzed`. Um batch cancelado a meio devolve/produz veredictos que o
          // scanner deita fora; promova-los a `filesAnalyzed` era afirmar cobertura que
          // não existe (400 do batch contra 61 aceites). `filesAnalyzed` passa a contar
          // apenas resultados efectivamente aceites pelo loop de resultados.
          let ultimoRelato = 0;
          const relatar = (n: number) => {
            if (n <= analisadosNoBatch) return;
            analisadosNoBatch = n;
            // Nao inundar o pipe: um evento por cada 1% ou por cada 100ms.
            const agora = Date.now();
            if (agora - ultimoRelato < 100 && n < candidatos.length) return;
            ultimoRelato = agora;
            const pct = Math.min(99, Math.floor((n / Math.max(1, totalFiles)) * 100));
            const atual = this.activeScans.get(id);
            this.updateScan(id, {
              progress: Math.max(atual?.progress ?? 0, pct),
              filesInEngineBatch: candidatos.length,
            });
          };

          if (perfEnabled) {
            console.log(
              `[ScanPerf] prefetch start id=${id} candidates=${candidatos.length} target=${String(type)}:${String(targetPath)}`,
            );
          }

          let outcome: { spawned: boolean; error?: string; files?: number };
          try {
            outcome = await this.engine.prefetchClamav(candidatos, id, relatar);
          } finally {
            // SEMPRE, mesmo em cancelamento ou excepção: um contador que fica
            // a dizer "20 ficheiros" quando nada está a correr é pior que
            // não o ter.
            this.updateScan(id, { filesInEngineBatch: 0 });
          }
          // O `onProgress` conta as linhas `OK`/`FOUND` do clamscan, e pode
          // omitir uma. O batch devolve UM veredicto terminal por ficheiro pedido,
          // por isso `analisadosNoBatch` reconcilia para CIMA — mas só como eixo da
          // ETAPA. Não escreve `filesAnalyzed`: esses veredictos ainda têm de ser
          // aceites pelo loop de resultados, e um cancelamento a meio recusa-os.
          if (outcome.spawned && typeof outcome.files === "number" && outcome.files > analisadosNoBatch) {
            analisadosNoBatch = outcome.files;
          }
          if (perfEnabled) {
            console.log(
              `[ScanPerf] prefetch end id=${id} spawned=${outcome.spawned} elapsed=${Math.round((Date.now() - prefetchStarted) / 1000)}s` +
                (outcome.error ? ` error=${outcome.error}` : ""),
            );
          }
          // O fim do batch, dito com os mesmos nomes do tracing do core. Se
          // isto nunca aparece, o batch nunca regressou ao ScanManager.
          //
          // A decomposicao selecionados -> candidatos e' a resposta ao
          // "728 de 800": selected = candidates + excluded + zip. Os tres
          // numeros juntos somam sempre `totalFiles`; nenhum ficheiro
          // desaparece sem nome.
          scanPerfLog(
            "SCANMANAGER_BATCH_END",
            id,
            `spawned=${outcome.spawned} selected=${totalFiles} candidates=${candidatos.length} excluded=${skippedExcluded} zip=${skippedZip} outcomes=${String(outcome.files ?? "n/a")} analyzedInBatch=${analisadosNoBatch} elapsedMs=${Date.now() - prefetchStarted}` +
              (outcome.error ? ` error=${outcome.error}` : ""),
          );
        }

        // O ficheiro EXTERNO de cada ZIP tambem e verificado pelo ClamAV no
        // `scanArtifact` do loop principal. Verificá-lo num unico batch evita
        // um processo por arquivo (cada cold start carrega ~1 GB de base); o
        // conteudo continua a ser analisado por `scanZipWithSafety`. O cache e'
        // por scanId e faz merge, por isso nao substitui o batch principal.
        if (zipOuterPaths.length > 0 && !this.isCancelled.has(id)) {
          try {
            await this.engine.prefetchClamav?.(zipOuterPaths, id);
          } catch {
            // Sem batch, o loop cai no clamscan unitario do scanArtifact.
          }
        }
      }

      for (let i = 0; i < files.length; i++) {
        if (this.isCancelled.has(id)) break;

        const file = files[i];
        this.archiveCoverageGaps.delete(id);
        // Fixture: verificação imediatamente antes do hand-off ao motor. O
        // objecto tem de continuar a ser, com identidade efectiva, o validado.
        if (snapshotValidado) {
          const deriva = identidadeAindaBate(snapshotValidado, file);
          if (deriva) {
            falhaFixture(`${GATE_CODE}: ${deriva} — análise recusada sem tocar no novo objecto`);
            break;
          }
        }
        try {
          // USB read-only: contencao de caminhos. Um junction/reparse point
          // pode fazer um caminho RELATIVO a raiz apontar para fora dela; o
          // que sai da raiz resolvida nao e' analisado e e' contado como
          // exclusao (nunca como "analisado").
          if (somenteLeitura) {
            const alvoReal = raizReal ? await fs.realpath(file).catch(() => null) : null;
            if (alvoReal === null || !estaContidoNaRaiz(raizReal!, alvoReal)) {
              excluded++;
              scanned++;
              foraDaRaiz++;
              scanPerfLog("USB_READONLY_FORA_DA_RAIZ", id, "entrada fora da raiz resolvida do dispositivo");
              continue;
            }
          }
          // Política de exclusões: um ficheiro excluído não vai aos motores e
          // conta como excluído (nunca como "analisado sem deteções").
          if (this.engine.isExcluded?.(file)) {
            excluded++;
            scanned++;
            // A categoria vem do motor: a UI explica a exclusão com o motivo
            // real (extensão de cache/temporário, nome, pasta interna), nunca
            // com uma lista escrita à mão que a política podia contradizer.
            excludedBy = addExclusionReason(
              excludedBy,
              this.engine.exclusionCategory?.(file) ?? null,
            );
          } else {
            // ZIP files: scan outer file + extract with safety protections
            // and scan the entries (bounded), so nested-archive handling is safe.
            const isZip = path.extname(file).toLowerCase() === ".zip" ||
              (await this.looksLikeZip(file));
            if (snapshotValidado && isZip) {
              falhaFixture(`${GATE_CODE}: arquivos exigem uma lease própria para entradas extraídas — análise recusada`);
              break;
            }
            if (isZip) {
              zipCount++;
              const zipStarted = perfEnabled ? Date.now() : 0;
              const zipThreats = await this.scanZipWithSafety(id, file);
              scanPerfLog("ZIP_PHASE", id, `elapsedMs=${Date.now() - zipStarted} incomplete=${this.archiveCoverageGaps.has(id)}`);
              threats += zipThreats;
            }

            const fileStart = perfEnabled ? Date.now() : 0;
            const result = await this.engine.scanArtifact(file, "system-scanner", {
              skipVirusTotal: true,
              scanId: id,
              readOnly: somenteLeitura,
            });
            if (perfEnabled) engineMs += Date.now() - fileStart;
            const scanResults = result?.results;
            // DEV opt-in + fixture-only: resumo por item SEM PII. Enums validados
            // (ou omitidos). `index` = ordinal do FICHEIRO (`analyzed`, antes do
            // incremento): dois ficheiros nunca partilham indice; dentro do
            // ficheiro, a ordem do array e a ordem dos itens.
            if (
              process.env.CYBERSAFE_DEV_CAPTURE_VERDICT_SUMMARY === "1" &&
              process.env.CYBERSAFE_DEV_ISOLATION === "1" &&
              process.env.NODE_ENV !== "production" &&
              typeof process.env.CYBERSAFE_REALDEV_FIXTURE_ROOT === "string" &&
              process.env.CYBERSAFE_REALDEV_FIXTURE_ROOT.length > 0 &&
              Array.isArray(scanResults)
            ) {
              const devVerdictValues = new Set(["safe", "suspicious", "malicious", "inconclusive"]);
              const devAnalysisStates = new Set(["completed", "excluded", "failed", "engine-unavailable", "inconclusive"]);
              const devSeverities = new Set(["low", "medium", "high", "critical"]);
              const devVerdictSummary = scanResults.map((item) => ({
                index: analyzed,
                verdict: typeof item.verdict === "string" && devVerdictValues.has(item.verdict) ? item.verdict : null,
                analysisState: typeof item.analysisState === "string" && devAnalysisStates.has(item.analysisState) ? item.analysisState : null,
                severity: devSeverities.has(item.severity) ? item.severity : null,
                scanId: id,
              }));
              console.log(`[ScanManager] dev-verdict-summary ${JSON.stringify(devVerdictSummary)}`);
            }
            if (
              !Array.isArray(scanResults) ||
              this.archiveCoverageGaps.has(id) ||
              scanResults.length === 0 ||
              scanResults.some((item) => item.analysisState !== "completed")
            ) {
              filesInconclusive++;
              // O motivo sai do que o motor devolveu, nunca de uma dedução.
              // `no-verdict` = resposta vazia/ausente; os restantes espelham o
              // `analysisState` do resultado que ficou por fechar.
              const motivo: InconclusiveReason =
                !Array.isArray(scanResults) || scanResults.length === 0
                  ? "no-verdict"
                  : scanResults.some((item) => item.analysisState === "engine-unavailable")
                    ? "engine-unavailable"
                    : scanResults.some((item) => item.analysisState === "failed")
                      ? "engine-failed"
                      : "coverage-incomplete";
              inconclusiveByReason = addInconclusiveReason(inconclusiveByReason,
                this.archiveCoverageGaps.has(id) ? "coverage-incomplete" : motivo);
            }
            this.archiveCoverageGaps.delete(id);
            analyzed++;
            scanned++;
            // Contrato único de "ameaca": highRiskCount > 0 OU severity
            // high/critical/medium (mesmo critério que o engine.ts para
            // threat.detected — sem isto o toast chega e o scanner mostra 0).
            if (result && (result.highRiskCount > 0 || result.overallSeverity === "high" || result.overallSeverity === "critical" || result.overallSeverity === "medium")) {
              threats++;
            }
          }
         } catch (error) {
           console.error(`[ScanManager] Error scanning ${file}:`, error);
           scanned++;
           filesFailed++;
           // T4 — regista a causa sem inventar: EACCES/EPERM → permissões,
           // ENOENT → desapareceu, EBUSY → bloqueado, etc. Nunca como ameaça.
           const reason = categorizeFsError(error);
           failedByReason[reason] = (failedByReason[reason] || 0) + 1;
         }

        // Emit progress every 4 files, at least once per second, or on last file
        if (i % 4 === 0 || i === files.length - 1 || Date.now() - lastEmit >= 1000) {
          lastEmit = Date.now();
          const elapsedSec = (Date.now() - startTime) / 1000;
          const filesPerSecond = elapsedSec > 0 ? Math.round((scanned / elapsedSec) * 10) / 10 : 0;
          // Monotónico: um progresso nunca recua dentro do mesmo scan.
          const currentProgress = this.activeScans.get(id)?.progress ?? 0;
          // Eixo GLOBAL do pipeline: `scanned` e' o numero de ficheiros que
          // fecharam o ciclo (analisados, excluidos ou falhados). O veredicto do
          // batch do ClamAV e' UMA etapa e NAO entra aqui: conta-lo aqui prendia
          // a barra em 728/800 durante toda a segunda passagem. O contrato
          // completo (eixo global + eixo da etapa) vive em
          // `packages/app/src/lib/scanSession.ts`.
          const nextProgress = Math.min(100, Math.floor((scanned / totalFiles) * 100));
          // `filesAnalyzed` e' o eixo dos RESULTADOS ACEITES: só conta o que este
          // loop comeu e refechou. O eixo da etapa do motor vive em
          // `filesInEngineBatch`/`analisadosNoBatch` e nunca entra aqui — um batch
          // cancelado produz veredictos que nunca chegaram a resultado.
          const mostradosAnalisados = analyzed;
           this.updateScan(id, {
             progress: Math.max(currentProgress, nextProgress),
             filesScanned: scanned,
             filesProcessed: scanned,
             filesAnalyzed: mostradosAnalisados,
             filesInconclusive,
             inconclusiveByReason: inconclusiveByReason.length > 0 ? inconclusiveByReason : undefined,
             filesExcluded: excluded,
             filesExcludedBy: excludedBy,
             threatsFound: threats,
             filesFailed,
             failedByReason: Object.keys(failedByReason).length > 0 ? failedByReason : undefined,
             filesPerSecond,
             currentFile: path.basename(file),
           });
        }
      }

      if (perfEnabled) {
        const elapsedMs = Date.now() - startTime;
        const perSec = elapsedMs > 0 ? Math.round((analyzed / (elapsedMs / 1000)) * 10) / 10 : 0;
        console.log(`[ScanPerf] type=${type} files=${analyzed} excluded=${excluded} failed=${filesFailed} zip=${zipCount} elapsed=${Math.round(elapsedMs / 1000)}s engine=${Math.round(engineMs / 1000)}s avg=${analyzed > 0 ? Math.round(engineMs / analyzed) : 0}ms/file filesPerSec=${perSec}`);
      }

      const finalState = this.activeScans.get(id)!;
      if (finalState.status === "running") {
        // ── Confirmação terminal OPCIONAL (USB) ────────────────────────────
        // Só o adapter USB fornece este callback. A prova é uma ENUMERAÇÃO
        // FRESCA (o detetor existente) que confirme a MESMA identidade na
        // MESMA raiz — existir o caminho não chega. Ausente / trocado /
        // instável / erro ⇒ o scan NÃO declara `completed`, nem no estado nem
        // no histórico. Um scan normal (sem callback) mantém o terminal igual.
        //
        // O `await` abre uma janela real: revalida-se o estado DEPOIS dele
        // para que um cancelamento que chegue durante a confirmação não seja
        // sobrescrito (um terminal é terminal).
        let recusa: string | null = null;
        if (confirmarTerminal) {
          recusa = await this.confirmarTerminal(id, confirmarTerminal);
        }
        const statusAposConfirmar = this.activeScans.get(id)?.status;
        if (statusAposConfirmar !== "running") {
          scanPerfLog("SCAN_TERMINAL_CONFIRMACAO_PREEMPTADA", id, `status=${statusAposConfirmar}`);
        } else if (recusa !== null) {
          scanPerfLog("SCAN_TERMINAL_NAO_CONFIRMADO", id, `motivo=${recusa}`);
          this.updateScan(id, {
            status: "failed",
            phase: "finalizing",
            error: recusa,
            filesScanned: scanned,
            filesProcessed: scanned,
            filesAnalyzed: analyzed,
            filesInconclusive,
            inconclusiveByReason: inconclusiveByReason.length > 0 ? inconclusiveByReason : undefined,
            filesExcluded: excluded,
            filesExcludedBy: excludedBy,
            threatsFound: threats,
            filesFailed,
            failedByReason: Object.keys(failedByReason).length > 0 ? failedByReason : undefined,
            endTime: new Date().toISOString(),
          });
        } else {
          this.updateScan(id, { phase: "finalizing" });
          // T4 — publica as razões de falha para diagnóstico. Não é um contador
          // adicional: justifica o que `filesFailed` encobre. Nunca contém caminhos.
          scanPerfLog(
            "SCAN_FAILED_BY_REASON",
            id,
            `reasons=${JSON.stringify(failedByReason)} total=${filesFailed}`,
          );
          this.updateScan(id, {
            status: "completed",
            progress: 100,
            filesScanned: scanned,
            filesProcessed: scanned,
            // Global completed: o batch provou os 728, e o loop terminou os 800.
            filesAnalyzed: analyzed,
            filesInconclusive,
            inconclusiveByReason: inconclusiveByReason.length > 0 ? inconclusiveByReason : undefined,
            filesExcluded: excluded,
            filesExcludedBy: excludedBy,
            threatsFound: threats,
            filesFailed,
            failedByReason: Object.keys(failedByReason).length > 0 ? failedByReason : undefined,
            endTime: new Date().toISOString(),
          });
        }
      }

    } catch (error) {
      // P1-4-F — O `catch` exterior também tem de respeitar o estado terminal.
      //
      // MEDIDO: o `await this.engine.prefetchClamav(...)` está dentro de um
      // `try/finally` SEM `catch`, por isso um motor que falha a fechar DEPOIS do
      // utilizador ter cancelado propaga para aqui. Este bloco escrevia
      // `status: "failed"` por cima do `cancelled` — o utilizador cancelava, via
      // "cancelado", e o scan passava a "falhou" com a mensagem do clamscan.
      //
      // O estado PUBLICO nao muda: um `cancelled` e `cancelled`. O erro continua
      // registado no log, com o estado, para diagnostico. A guarda de `updateScan`
      // e a rede de seguranca; aqui a decisao e explicita e legivel no sitio.
      const statusAgora = this.activeScans.get(id)?.status;
      const mensagem = error instanceof Error ? error.message : String(error);
      if (statusAgora === "cancelled") {
        console.error(`[ScanManager] Scan ${id} cancelado: erro tardio registado sem mudar o estado — ${mensagem}`);
      } else {
        console.error(`[ScanManager] Scan ${id} failed:`, error);
        this.updateScan(id, {
          status: "failed",
          phase: "finalizing",
          error: mensagem,
          endTime: new Date().toISOString(),
        });
      }
    } finally {
      // Nenhum passo de limpeza pode saltar os seguintes. MEDIDO (revisão
      // TOCTOU-FINAL): um `clearClamavPrefetch` que rebenta ou um release de
      // locks não confirmado (`CloseHandle`) saltavam heartbeat, mapas,
      // `resolveScan` e `currentScanPromise = null` — o scan ficava
      // PENDURADO e o serviço recusava qualquer scan seguinte para sempre.
      // Cada passo corre isolado; a primeira falha fica registada e é dita.
      let falhaLimpeza: unknown = null;
      const limpar = (passo: string, acao: () => void) => {
        try {
          acao();
        } catch (erro) {
          if (falhaLimpeza === null) falhaLimpeza = erro;
          // Nunca engolido: um lock não libertado continua visível no log.
          console.error(`[ScanManager] Limpeza do scan ${id} falhou em ${passo}:`, erro);
        }
      };
      // O prefetch tem de ser largado SEMPRE — scan concluído, cancelado ou
      // com excepção. Retido, seria um Map com um veredicto por ficheiro de
      // cada scan, a crescer sem fim num serviço de vida longa.
      limpar("clearClamavPrefetch", () => this.engine.clearClamavPrefetch?.(id));
      // A published cancellation is not engine completion. Release only
      // after awaited engine work returns to this finally block.
      limpar("releaseFixtureLease", () => { fixtureLease?.release(); });
      limpar("heartbeat", () => clearInterval(heartbeat));
      limpar("isCancelled", () => { this.isCancelled.delete(id); });
      limpar("archiveCoverageGaps", () => { this.archiveCoverageGaps.delete(id); });
      limpar("scansSomenteLeitura", () => { this.scansSomenteLeitura.delete(id); });
      if (foraDaRaiz > 0) {
        // Honestidade: entradas fora da raiz sao exclusoes com motivo, nao
        // ficheiros "analisados sem detecoes".
        limpar("foraDaRaiz", () => scanPerfLog("USB_READONLY_CONTENCAO", id, `foraDaRaiz=${foraDaRaiz}`));
      }
      // O estado final REAL, lido depois de todos os ramos: e' o unico sitio
      // por onde passa um scan que acaba, cancela ou falha. Sem isto, uma
      // linha do tempo que para a meio nao diz se o scan terminou ou ficou preso.
      const terminalState = this.activeScans.get(id);
      if (terminalState) {
        limpar("terminalLog", () => scanPerfLog(
          "SCAN_TERMINAL",
          id,
          `status=${terminalState.status} phase=${terminalState.phase} progress=${terminalState.progress} scanned=${terminalState.filesScanned} analyzed=${terminalState.filesAnalyzed ?? 0} failed=${terminalState.filesFailed ?? 0} elapsedMs=${terminalState.startTime ? Date.now() - Date.parse(terminalState.startTime) : -1}`,
        ));
      }
      // Incondicionais: nenhuma falha de limpeza pode reter o scan. É este
      // par que liberta o manager para o scan seguinte.
      resolveScan!();
      this.currentScanPromise = null;
      if (falhaLimpeza !== null) {
        // O scan terminou e o resultado mantém-se; o que NÃO se afirma é que
        // ficou tudo limpo — um recurso pode continuar retido até o processo
        // terminar, e isso tem de ficar dito, não silenciado.
        console.error(`[ScanManager] Scan ${id}: limpeza incompleta — o resultado do scan mantém-se, mas um recurso pode continuar retido até o processo terminar.`);
      }
    }
  }

  // ── ZIP safety: extraction with zip-slip / bomb / limit protections ──
  private static readonly ZIP_MAX_ENTRIES = 500;
  private static readonly ZIP_MAX_DEPTH = 3;
  private static readonly ZIP_MAX_NESTING = 3;
  private static readonly ZIP_MAX_EXTRACTED_BYTES = 200 * 1024 * 1024; // 200 MB
  private static readonly ZIP_MAX_COMPRESSION_RATIO = 1000;

  /** Detect ZIP by magic bytes with a read of the first 4 bytes. */
  private async looksLikeZip(filePath: string): Promise<boolean> {
    try {
      const fh = await fs.open(filePath, "r");
      const buf = Buffer.alloc(4);
      await fh.read(buf, 0, 4, 0);
      await fh.close();
      return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
    } catch {
      return false;
    }
  }

  /**
   * Scan a ZIP safely: list entries, enforce limits, extract to a temp dir
   * with zip-slip protection, scan the extracted files, clean up.
   * Returns the number of threats found inside the archive.
   * Entradas internas NÃO contam para filesScanned/filesAnalyzed do scan
   * exterior — o ZIP é um único candidato (o outer file já incrementou
   * scanned/analyzed no loop principal). Contadores de entradas internas
   * são mantidos em variáveis locais apenas para logging/perf.
   *
   * Nesting depth semantics: ZIP_MAX_NESTING is the exclusive upper bound.
   * Valid recursion depths are 0..ZIP_MAX_NESTING-1. A call at depth >= ZIP_MAX_NESTING
   * returns immediately (guard). Recursion is allowed when nestingDepth < ZIP_MAX_NESTING,
   * which is consistent with the guard.
   */
  private async scanZipWithSafety(
    scanId: string,
    zipPath: string,
    nestingDepth = 0
  ): Promise<number> {
    // Guard: depth >= ZIP_MAX_NESTING means we've reached the limit — stop recursion.
    // This is consistent with the recursion condition `nestingDepth < ZIP_MAX_NESTING`
    // below. The old `> ZIP_MAX_NESTING` guard was off-by-one (allowed one extra level).
    if (nestingDepth >= ScanManager.ZIP_MAX_NESTING) {
      this.archiveCoverageGaps.add(scanId); return 0;
    }
    let threats = 0;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-zip-"));
    try {
      // Import AdmZip lazily (keeps it in the same module graph as core).
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();

      // Limit entry count
      if (entries.length > ScanManager.ZIP_MAX_ENTRIES) {
        this.archiveCoverageGaps.add(scanId); return 0;
      }

      // Metadata limits precede allocation; accepted entries inflate once.
      const normalizedPaths = new Set<string>();
      let extractedBytes = 0;

      // Extract eligible regular entries first, then scan them in ONE batch.
      // `scanArtifact` used to be called per entry here; every unit scan loaded
      // the full ClamAV database again (~5-6s measured per process). The entries
      // remain individually analyzed and attributed; only the process startup
      // is shared. Nested archives keep the recursive safety path below.
      const extractedFolder = path.join(tmpRoot, "x");
      await fs.mkdir(extractedFolder, { recursive: true });
      const extractedRegularFiles: string[] = [];
      const nestedArchives: string[] = [];

      for (const entry of entries) {
        if (this.isCancelled.has(scanId)) return threats;
        if (entry.isDirectory) continue;
        const rawEntryName = entry.entryName;
        const safeName = rawEntryName.replace(/\\/g, "/");
        if (safeName.includes("..") || /^[a-zA-Z]:/.test(safeName)) {
          this.archiveCoverageGaps.add(scanId); continue;
        }
        const depth = safeName.split("/").length - 1;
        if (depth > ScanManager.ZIP_MAX_DEPTH) { this.archiveCoverageGaps.add(scanId); continue; }

        const target = path.join(extractedFolder, safeName);
        if (!target.startsWith(extractedFolder + path.sep)) { this.archiveCoverageGaps.add(scanId); continue; }
        const identity = safeName.toLowerCase();
        if (normalizedPaths.has(identity)) { this.archiveCoverageGaps.add(scanId); continue; }
        normalizedPaths.add(identity);
        try {
          const data = readBoundedArchiveEntry(entry, ScanManager.ZIP_MAX_EXTRACTED_BYTES - extractedBytes);
          extractedBytes += data.length;
          await fs.mkdir(path.dirname(target), { recursive: true });
          // Guard extracted size per-file too (compression bomb protection)
          if (data && data.length > (ScanManager.ZIP_MAX_EXTRACTED_BYTES / ScanManager.ZIP_MAX_ENTRIES)) {
            continue;
          }
          await fs.writeFile(target, data);

          // Nested archive: if entry is also an archive and nesting limit allows, recurse.
          // When we recurse, we do NOT also call scanArtifact on this entry — the recursive
          // call covers all its contents. Calling scanArtifact on top would double-count any
          // threat found inside the nested archive.
          const isNestedZip = path.extname(target).toLowerCase() === ".zip" || (await this.looksLikeZip(target));
          if (isNestedZip && nestingDepth < ScanManager.ZIP_MAX_NESTING) {
            // Recurse; all threats from the nested zip's contents are returned.
            // Do NOT call scanArtifact on this entry (would double-count).
            nestedArchives.push(target);
          } else {
            // Regular file (or nested zip at max depth — treated as an opaque
            // file, preserving the previous coverage contract). Collected here
            // and analyzed in a single batch after extraction.
            extractedRegularFiles.push(target);
          }
        } catch {
          this.archiveCoverageGaps.add(scanId);
        }
      }

      // Group every extracted regular entry in one owner-scoped ClamAV batch.
      // The engine merges these outcomes with the outer-scan batch, so regular
      // files and archive entries stay independently covered without one cold
      // process (~5-6s of database load) per entry. If an implementation does
      // not support batching, `scanArtifact` still performs the full checks.
      if (extractedRegularFiles.length > 0) {
        await this.engine.prefetchClamav?.(extractedRegularFiles, scanId);
      }
      for (const extractedFile of extractedRegularFiles) {
        if (this.isCancelled.has(scanId)) return threats;
        // Contrato único de "ameaca": highRiskCount > 0 OU severity
        // high/critical/medium. O engine.ts publica threat.detected para
        // medium (finalSeverity !== "low") — o scan-manager tem de usar a
        // mesma definição, senão o toast chega e o scanner mostra 0.
        // Alguns motores expõem o campo como `severity` (AnalysisResult)
        // e outros como `overallSeverity` (FileScanResponse) — aceitamos os dois.
        const res = await this.engine.scanArtifact(extractedFile, "system-scanner", {
          skipVirusTotal: true,
          scanId,
          readOnly: this.scansSomenteLeitura.has(scanId),
        });
        if (!Array.isArray(res?.results) || res.results.length === 0 ||
            res.results.some(item => item.analysisState !== "completed" || item.verdict === "inconclusive")) {
          this.archiveCoverageGaps.add(scanId);
        }
        const sev = (res as any)?.overallSeverity ?? (res as any)?.severity;
        if (res && (res.highRiskCount > 0 || sev === "high" || sev === "critical" || sev === "medium")) {
          threats++;
        }
      }
      for (const nestedArchive of nestedArchives) {
        if (this.isCancelled.has(scanId)) return threats;
        threats += await this.scanZipWithSafety(scanId, nestedArchive, nestingDepth + 1);
      }
    } catch {
      // Outer bytes can still be scanned, but unreadable contents are not conclusive.
      this.archiveCoverageGaps.add(scanId);
    } finally {
      // Always clean up temp files, even on cancel/error
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
    return threats;
  }

  // ── Quick Scan gather: depth-limited, extension-prioritised ──────────
  private async gatherFilesQuick(
    dir: string,
    filesList: string[],
    scanId: string,
    depth: number,
    maxDepth: number,
    budget: number,
    stats: { failed: number; failedByReason?: Record<FsErrorCategory, number> } = { failed: 0 },
  ): Promise<void> {
    if (this.isCancelled.has(scanId)) return;
    if (filesList.length >= budget) return;
    if (depth > maxDepth) return;

    try {
      const stat = await fs.stat(dir).catch((error) => {
        stats.failed++;
        if (stats.failedByReason) {
          const reason = categorizeFsError(error);
          stats.failedByReason[reason] = (stats.failedByReason[reason] || 0) + 1;
        }
        return null;
      });
      if (!stat) return;

      if (stat.isFile()) {
        filesList.push(dir);
        return;
      }

      if (!stat.isDirectory()) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
        stats.failed++;
        if (stats.failedByReason) {
          const reason = categorizeFsError(error);
          stats.failedByReason[reason] = (stats.failedByReason[reason] || 0) + 1;
        }
        return [];
      });
      // Sort: directories first (for breadth-first feel), then files
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return 0;
      });

      for (const entry of entries) {
        if (this.isCancelled.has(scanId)) return;
        if (filesList.length >= budget) return;

        const fullPath = path.join(dir, entry.name);
        const name = entry.name.toLowerCase();

        // Skip junk and symlinks
        if (name === "node_modules" || name === ".git" || name === ".venv" || name === "__pycache__") continue;
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (name === "windows" || name === "program files" || name === "program files (x86)") continue;
          await this.gatherFilesQuick(fullPath, filesList, scanId, depth + 1, maxDepth, budget, stats);
        } else if (entry.isFile()) {
          // For Quick Scan: only add files with supported extensions or recent files
          const ext = path.extname(name).toLowerCase();
          const isHighRisk = HIGH_RISK_EXTENSIONS.has(ext);
          let isRecent = false;
          try {
            const stat = await fs.stat(fullPath);
            isRecent = (Date.now() - stat.mtimeMs) < QUICK_SCAN_RECENT_MS;
          } catch (error) {
            stats.failed++;
            if (stats.failedByReason) {
              const reason = categorizeFsError(error);
              stats.failedByReason[reason] = (stats.failedByReason[reason] || 0) + 1;
            }
            continue;
          }

          // Include if: high-risk extension OR recent file
          if (isHighRisk || isRecent) {
            filesList.push(fullPath);
          }
        }
      }
    } catch (error) {
      stats.failed++;
      if (stats.failedByReason) {
        const reason = categorizeFsError(error);
        stats.failedByReason[reason] = (stats.failedByReason[reason] || 0) + 1;
      }
    }
  }

  // ── Full Scan gather: recursive, uncapped depth ──────────────────────
  private async gatherFiles(
    dir: string,
    filesList: string[],
    scanId: string,
    maxFiles: number,
    stats: { failed: number; failedByReason?: Record<FsErrorCategory, number> } = { failed: 0 },
  ) {
    if (this.isCancelled.has(scanId)) return;
    if (filesList.length >= maxFiles) return;

    try {
      const stat = await fs.stat(dir).catch((error) => {
        stats.failed++;
        if (stats.failedByReason) {
          const reason = categorizeFsError(error);
          stats.failedByReason[reason] = (stats.failedByReason[reason] || 0) + 1;
        }
        return null;
      });
      if (!stat) return;

      if (stat.isFile()) {
        filesList.push(dir);
        return;
      }

      if (!stat.isDirectory()) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
        stats.failed++;
        if (stats.failedByReason) {
          const reason = categorizeFsError(error);
          stats.failedByReason[reason] = (stats.failedByReason[reason] || 0) + 1;
        }
        return [];
      });
      for (const entry of entries) {
        if (this.isCancelled.has(scanId)) return;
        if (filesList.length >= maxFiles) return;

        const fullPath = path.join(dir, entry.name);
        const name = entry.name.toLowerCase();

        if (name === "node_modules" || name === ".git") continue;
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (name === "windows" || name === "program files" || name === "program files (x86)") continue;
          await this.gatherFiles(fullPath, filesList, scanId, maxFiles, stats);
        } else if (entry.isFile()) {
          filesList.push(fullPath);
        }
      }
    } catch (error) {
      stats.failed++;
      if (stats.failedByReason) {
        const reason = categorizeFsError(error);
        stats.failedByReason[reason] = (stats.failedByReason[reason] || 0) + 1;
      }
    }
  }

  private async resolvePathsForScan(type: ScanType, targetPath?: string): Promise<string[]> {
    const home = os.homedir();
    if (type === "custom" && targetPath) {
      return [targetPath];
    }

    const existingDirs = async (...parts: string[]): Promise<string | null> => {
      const full = path.join(...parts);
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) return null;
        const isDir = await fs.stat(full).then((s) => s.isDirectory()).catch(() => false);
        return isDir ? full : null;
      } catch {
        return null;
      }
    };

    if (type === "quick") {
      const candidates = await Promise.all([
        existingDirs(home, "Downloads"),
        existingDirs(home, "Desktop"),
        existingDirs(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
        existingDirs(home, "Documents"),
        existingDirs(os.tmpdir()),
      ]);
      return candidates.filter((p): p is string => p !== null);
    }

    if (type === "full") {
      return [
        home,
        "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
      ];
    }

    return [];
  }
}
