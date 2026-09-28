import type { ScanPhase, ScanState, ScanStatus, ScanType } from "@cybersafe/shared-types";

/**
 * UI-facing scan status. It is a superset of the backend `ScanStatus`: the
 * running status is split by phase (preparing / gathering / scanning /
 * finalizing) so the UI never shows a bare spinner without explaining why.
 */
export type ScanUiStatus =
  | "idle"
  | "preparing"
  | "gathering"
  | "scanning"
  | "finalizing"
  | "completed"
  | "cancelled"
  | "failed";

/** What the renderer should do with an incoming scan event. */
export type ScanEventDecision = "accept" | "buffer" | "ignore";

/**
 * Silêncio máximo (ms) sem qualquer mensagem do motor antes de a UI assumir
 * que perdeu contacto. O serviço publica um heartbeat a cada segundo enquanto o
 * scan trabalha, por isso 20s de silêncio significam mesmo um problema.
 */
export const SCAN_STALL_MS = 20_000;

/** O que está a ser analisado — determina todo o texto mostrado ao utilizador. */
export type ScanScope = "computer" | "file" | "folder";

/** Intenção escolhida pelo utilizador (o que ele clicou/largou). */
export type ScanIntentKind = "quick" | "full" | "file" | "folder";

export interface ScanActionCard {
  kind: ScanIntentKind;
  title: string;
  description: string;
}

/**
 * As quatro análises reais suportadas pelo módulo. Os nomes e descrições são
 * deliberadamente explícitos: "Análise Rápida" analisa o COMPUTADOR em zonas
 * prioritárias, não um ficheiro.
 */
export const SCAN_ACTION_CARDS: ScanActionCard[] = [
  {
    kind: "quick",
    title: "Análise Rápida do Computador",
    description: "Analisa rapidamente as áreas mais importantes e de maior risco do computador.",
  },
  {
    kind: "full",
    title: "Análise Profunda do Computador",
    // Scope real do serviço: pastas do utilizador + arranques automáticos.
    // Windows e Program Files são deliberadamente ignorados — não prometemos
    // "todo o sistema" porque isso não corresponde ao que o motor faz.
    description: "Verifica de forma abrangente as pastas do seu utilizador e os arranques automáticos (Windows e Program Files ficam de fora). Pode demorar mais tempo.",
  },
  {
    kind: "file",
    title: "Analisar um Ficheiro",
    description: "Verifica um ficheiro específico escolhido por si.",
  },
  {
    kind: "folder",
    title: "Analisar uma Pasta",
    description: "Verifica todos os ficheiros dentro da pasta escolhida.",
  },
];

/** Nota técnica mostrada na UI (é verdadeira: o ZIP é inspecionado por conteúdo). */
export const ZIP_CONTENT_NOTE = "Ficheiros ZIP são inspecionados pelo conteúdo, não apenas pelo nome.";

/**
 * Rótulos do resultado final. "Sem ameaças detetadas" substitui o antigo
 * "Ficheiros Seguros": nenhuma deteção NÃO é uma garantia absoluta de
 * segurança, e a UI não pode afirmar o contrário.
 */
export const SCAN_RESULT_LABELS = {
  analysisType: "Tipo de Análise",
  filesChecked: "Ficheiros Verificados",
  noThreatsDetected: "Sem ameaças detetadas",
  threatsFound: "Ameaças Encontradas",
} as const;

/** Aviso de responsabilidade mostrado junto ao resultado. */
export const NO_DETECTIONS_NOTE =
  "Não terem sido encontradas ameaças não garante que o conteúdo esteja isento de risco.";

const SCAN_STATUSES: ScanStatus[] = ["idle", "queued", "running", "completed", "cancelled", "failed"];
const SCAN_PHASES: ScanPhase[] = ["preparing", "gathering", "scanning", "finalizing"];

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Só o nome do ficheiro: caminhos completos expõem o utilizador sem necessidade. */
export function basename(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

export function normalizeScanType(value: unknown): ScanType {
  return value === "quick" || value === "full" || value === "custom" ? value : "custom";
}

/**
 * Normaliza um payload vindo do motor (evento `scan.progress` ou snapshot de
 * ressincronização) para o contrato canónico `ScanState`.
 *
 * Regras deliberadas:
 * - `id` é o campo canónico; aceita-se `scanId` como fallback defensivo para
 *   que uma divergência de contrato nunca deixe a UI presa sem dados.
 * - Payloads sem id/estado válidos devolvem `null` (ex.: o evento legacy
 *   `runFullSystemScan()` que publica `{ progress }` sem id) — são ignorados,
 *   nunca aplicados a meio scan.
 * - `currentFile` é reduzido ao basename.
 */
export function normalizeScanState(raw: unknown): ScanState | null {
  if (!raw || typeof raw !== "object") return null;

  const value = raw as Record<string, unknown>;
  // Algumas variantes embrulham o estado: { state: {...} } / { scanState: {...} }.
  const wrapped = value.state ?? value.scanState;
  const source = (wrapped && typeof wrapped === "object" ? wrapped : value) as Record<string, unknown>;

  const id = typeof source.id === "string" && source.id.length > 0
    ? source.id
    : typeof source.scanId === "string" && source.scanId.length > 0
      ? source.scanId
      : null;
  if (!id) return null;

  const status = typeof source.status === "string" ? source.status : null;
  if (!status || !SCAN_STATUSES.includes(status as ScanStatus)) return null;

  const rawPhase = typeof source.phase === "string" ? source.phase : undefined;
  const phase = rawPhase && SCAN_PHASES.includes(rawPhase as ScanPhase) ? (rawPhase as ScanPhase) : undefined;

  return {
    id,
    type: normalizeScanType(source.type),
    status: status as ScanStatus,
    progress: Math.max(0, Math.min(100, Math.round(asNumber(source.progress)))),
    filesScanned: Math.max(0, Math.round(asNumber(source.filesScanned ?? source.analyzed))),
    threatsFound: Math.max(0, Math.round(asNumber(source.threatsFound))),
    filesDiscovered: asOptionalNumber(source.filesDiscovered),
    filesTotal: asOptionalNumber(source.filesTotal),
    filesProcessed: asOptionalNumber(source.filesProcessed),
    filesAnalyzed: asOptionalNumber(source.filesAnalyzed),
    filesExcluded: asOptionalNumber(source.filesExcluded),
    filesFailed: asOptionalNumber(source.filesFailed),
    revision: asOptionalNumber(source.revision),
    updatedAt: asOptionalString(source.updatedAt),
    targetKind: source.targetKind === "file" || source.targetKind === "directory" ? source.targetKind : undefined,
    phase,
    filesPerSecond: asOptionalNumber(source.filesPerSecond),
    currentFile: typeof source.currentFile === "string" ? basename(source.currentFile) : undefined,
    startTime: asOptionalString(source.startTime),
    endTime: asOptionalString(source.endTime),
    targetPath: asOptionalString(source.targetPath),
    error: asOptionalString(source.error),
  };
}

/**
 * Aceita um estado novo? Rejeita estados atrasados do MESMO scan (revisão
 * inferior), evitando que os contadores recuem, e nunca reabre um scan terminal.
 * Estados de outro scan devem ser filtrados antes (decideScanEvent).
 */
export function shouldAcceptScanState(current: ScanState | null, next: ScanState): boolean {
  if (!current || current.id !== next.id) return true;
  if (typeof current.revision === "number" && typeof next.revision === "number" && next.revision < current.revision) {
    return false;
  }
  if (isTerminalScanStatus(current.status) && !isTerminalScanStatus(next.status)) return false;
  return true;
}

/**
 * Contadores são monotónicos dentro do mesmo scan: um evento/snapshot atrasado
 * nunca pode fazer um contador recuar.
 */
export function mergeScanState(current: ScanState | null, next: ScanState): ScanState {
  if (!current || current.id !== next.id) return next;
  const keepMax = (a?: number, b?: number) => Math.max(a ?? 0, b ?? 0);
  return {
    ...next,
    filesScanned: keepMax(current.filesScanned, next.filesScanned),
    filesProcessed: keepMax(current.filesProcessed, next.filesProcessed) || undefined,
    filesAnalyzed: keepMax(current.filesAnalyzed, next.filesAnalyzed) || undefined,
    filesExcluded: keepMax(current.filesExcluded, next.filesExcluded) || undefined,
    filesFailed: keepMax(current.filesFailed, next.filesFailed) || undefined,
    filesDiscovered: keepMax(current.filesDiscovered, next.filesDiscovered) || undefined,
    threatsFound: keepMax(current.threatsFound, next.threatsFound),
  };
}

/**
 * Percentagem a mostrar. Usa o total REAL de candidatos congelado pelo serviço;
 * se ainda não existir (fase gathering), devolve null para a UI mostrar barra
 * indeterminada em vez de uma percentagem inventada.
 */
export function scanProgressPercent(state: ScanState | null): number | null {
  if (!state) return null;
  if (!isTerminalScanStatus(state.status) && (state.phase === "gathering" || state.phase === "preparing")) {
    return null;
  }
  if (typeof state.filesTotal === "number" && state.filesTotal > 0) {
    return Math.max(0, Math.min(100, Math.floor((state.filesScanned / state.filesTotal) * 100)));
  }
  if (isTerminalScanStatus(state.status)) return state.progress;
  return null;
}

/**
 * ETA aproximado em segundos, apenas quando a velocidade já é minimamente
 * estável (número suficiente de ficheiros analisados). Nunca fingimos precisão.
 */
export function scanEtaSeconds(state: ScanState | null): number | null {
  if (!state) return null;
  if (isTerminalScanStatus(state.status)) return null;
  const total = state.filesTotal;
  const fps = state.filesPerSecond;
  if (typeof total !== "number" || total <= 0) return null;
  if (typeof fps !== "number" || fps <= 0) return null;
  if (state.filesScanned < 10) return null;
  const remaining = total - state.filesScanned;
  if (remaining <= 0) return 0;
  return Math.round(remaining / fps);
}

/** Formata um ETA curto e honesto. */
export function formatEta(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds <= 1) return "menos de 1 segundo restante";
  if (seconds < 60) return `~${seconds}s restantes`;
  const minutes = Math.round(seconds / 60);
  return `~${minutes} min restantes`;
}

/**
 * Decide o que fazer com um evento. Sem scan esperado, o evento é guardado
 * num buffer: o serviço emite o primeiro progresso ANTES de a resposta de
 * `startScan` chegar ao renderer (start → evento → resposta).
 */
export function decideScanEvent(state: ScanState, expectedScanId: string | null): ScanEventDecision {
  if (!expectedScanId) return "buffer";
  return state.id === expectedScanId ? "accept" : "ignore";
}

export function isTerminalScanStatus(status: ScanStatus | string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export function isTerminalUiStatus(status: ScanUiStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export function isActiveUiStatus(status: ScanUiStatus): boolean {
  return status === "preparing" || status === "gathering" || status === "scanning" || status === "finalizing";
}

/**
 * Cópia do ecrã de recuperação. Só aparece quando já existe uma sessão viva
 * comprovada (ver `shouldShowHydration`), por isso a promessa é verdadeira.
 */
export const SCAN_HYDRATING_TITLE = "A recuperar análise em curso...";
export const SCAN_HYDRATING_DETAIL = "A consultar o motor de análise local.";

/**
 * Velocidade a mostrar, ou "—" quando ainda não há velocidade nenhuma.
 *
 * MEDIDO (probe real contra o serviço vivo, 2.º arranque, motores quentes):
 *   REQUEST -> scanId .............. 1 984 ms
 *   scanId -> primeiro progress ..... 1 984 ms
 *   fase `gathering` -> `scanning` .. 90 653 ms   <- 87,7 s só a enumerar
 * Nesse intervalo o serviço conta ficheiros encontrados (filesDiscovered foi de 0
 * a 800) mas filesScanned fica a 0 e o serviço SÓ calcula filesPerSecond dentro
 * do ciclo de análise (scan-manager.ts, no ramo de `scanning`).
 *
 * Portanto, durante a preparação e a enumeração, escrever "0 f/s" afirma que o
 * motor parou — e está a fazer trabalho real. "—" afirma só o que é verdade:
 * ainda não foi medida nenhuma velocidade. Mostrar 0 seria inventar uma
 * paragem que não existe.
 */
export function scanRateLabel(state: ScanState | null): string {
  if (!state) return "—";
  if (isTerminalScanStatus(state.status)) {
    const done = state.filesPerSecond;
    return typeof done === "number" && Number.isFinite(done) ? `${done} f/s` : "—";
  }
  if (state.status !== "running" && state.status !== "queued") return "—";
  // Sem um único ficheiro analisado não há velocidade de análise por mostrar.
  if ((state.filesScanned ?? 0) <= 0) return "—";
  const fps = state.filesPerSecond;
  if (typeof fps !== "number" || !Number.isFinite(fps)) return "—";
  return `${fps} f/s`;
}

/**
 * Deve mostrar o ecrã de recuperação em vez do estado inicial?
 *
 * A tela deixa de ser uma espera cega e passa a exigir PROVA: sem uma sessão
 * viva já encontrada, o scanner abre em IDLE. Um ecrã que promete "a recuperar
 * uma análise" quando o motor não tem análise nenhuma era a mentira que abria
 * o CyberSafe sem qualquer análise em curso — e durava tanto quanto o
 * `getActiveScan` demorasse a responder (o cliente do serviço espera até 30
 * tentativas de ligação antes de sequer enviar o pedido).
 */
export function shouldShowHydration(
  hydrating: boolean,
  status: ScanUiStatus,
  hasRecoverableScan: boolean,
): boolean {
  return hydrating && status === "idle" && hasRecoverableScan;
}

/**
 * Uma sessão é retomável? As três portas do contrato, nesta ordem:
 * 1. identidade real — um id não vazio;
 * 2. sessão VIVA — `queued`/`running`. `idle` não é terminal mas também não é
 *    vida: tratá-lo como ativo era abrir a recuperação sem análise nenhuma;
 * 3. dados para retomar — sem fase nem total conhecido não há progresso
 *    honesto a mostrar, e mostrar um anel vazio seria inventar dados;
 * 4. o motor continua a falar — `updatedAt` presente, parseável e dentro de
 *    `SCAN_STALL_MS`, o mesmo limite que o watchdog do produto já usa para
 *    declarar que o motor emudeceu. Sem carimbo válido, não há prova.
 *
 * `completed`/`cancelled`/`failed` caem na porta 2: nunca são retomáveis.
 */
export function isResumableScanSession(snapshot: ScanState): boolean {
  if (typeof snapshot.id !== "string" || snapshot.id.length === 0) return false;
  if (snapshot.status !== "queued" && snapshot.status !== "running") return false;
  const hasTotal = typeof snapshot.filesTotal === "number" && snapshot.filesTotal > 0;
  if (snapshot.phase === undefined && !hasTotal) return false;
  // Porta 4 — o motor continua a falar? O serviço carimba `updatedAt` em cada
  // `updateScan` e mantem um heartbeat de 1 s enquanto o scan trabalha, mesmo
  // durante o `gathering` (scan-manager.ts:93 e :155-163), e o watchdog do
  // produto já usa SCAN_STALL_MS para declarar que o motor emudeceu. Uma sessão
  // cujo carimbo já passou esse limite está parada pelo critério do próprio
  // produto: oferecê-la seria a mesma mentira do arranque a frio, agora com o
  // motor calado. Margem de 20 s contra 1 s de cadencia — cortar aqui nunca
  // apanha uma sessão a correr.
  // Porta 4, ao pe da letra: o carimbo tem de EXISTIR, ser PARSEAVEL e estar
  // dentro de SCAN_STALL_MS. Ausente, ilegível ou velho, a sessão não é
  // retomável. Se o snapshot não tem um timestamp válido, não há prova
  // suficiente para oferecer Recuperar analise — e sem prova, o scanner abre em
  // IDLE. É o mesmo princípio das portas 1 a 3: o que não está provado não se
  // apresenta. O serviço carimba `updatedAt` de 1 em 1 s (scan-manager.ts:93 e o
  // heartbeat em :155-163), por isso qualquer sessão a correr tem carimbo.
  const lastBeat = Date.parse(snapshot.updatedAt ?? "");
  if (!Number.isFinite(lastBeat)) return false;
  if (Date.now() - lastBeat > SCAN_STALL_MS) return false;
  return true;
}

/**
 * A DECISÃO: o que recovered de um payload do motor, se alguma coisa.
 *
 * `null` significa "não há nada a recuperar" e é o resultado normal de abrir o
 * CyberSafe sem uma análise em curso. Um snapshot terminal, um `idle`, ou um
 * registo sem dados suficientes devolvem `null` — nunca uma tela de recuperação.
 */
export function decideScanRecovery(raw: unknown): ScanState | null {
  const snapshot = normalizeScanState(raw);
  if (!snapshot) return null;
  return isResumableScanSession(snapshot) ? snapshot : null;
}

/** Mapeia estado do backend (+ fase) para a fase que a UI mostra. */
export function uiStatusForState(state: ScanState): ScanUiStatus {
  switch (state.status) {
    case "completed":
    case "cancelled":
    case "failed":
      return state.status;
    case "queued":
      return "preparing";
    case "idle":
      return "idle";
    case "running":
    default:
      switch (state.phase) {
        case "scanning":
          return "scanning";
        case "finalizing":
          return "finalizing";
        case "preparing":
          return "preparing";
        case "gathering":
        default:
          // Fase em falta (contrato antigo) = ainda a recolher ficheiros.
          return "gathering";
      }
  }
}

// ── Naming / apresentação ─────────────────────────────────────────────

export function scopeFromIntent(kind: ScanIntentKind): ScanScope {
  if (kind === "quick" || kind === "full") return "computer";
  return kind === "folder" ? "folder" : "file";
}

/**
 * Âmbito do scan. Precedência: o tipo real do alvo reportado pelo serviço
 * (também correto após ressincronizar), depois a intenção do utilizador, depois
 * o tipo de scan. Assim uma pasta largada por engano como "ficheiro" acaba
 * apresentada como pasta, porque o serviço confirma o que o alvo é.
 */
export function scanScopeFor(
  state: Pick<ScanState, "type" | "targetKind">,
  intentKind?: ScanIntentKind,
): ScanScope {
  if (state.targetKind === "directory") return "folder";
  if (state.targetKind === "file") return "file";
  if (intentKind) return scopeFromIntent(intentKind);
  return state.type === "quick" || state.type === "full" ? "computer" : "file";
}

/** Nome completo da análise, como o utilizador a vê. */
export function scopeTitle(scope: ScanScope, type: ScanType): string {
  if (scope === "computer") {
    return type === "full" ? "Análise Profunda do Computador" : "Análise Rápida do Computador";
  }
  return scope === "folder" ? "Analisar uma Pasta" : "Analisar um Ficheiro";
}

/** Título do painel durante a análise, por tipo de alvo e por fase. */
export function activeScanTitle(scope: ScanScope, ui: ScanUiStatus): string {
  if (scope === "file") {
    if (ui === "preparing") return "A preparar a análise do ficheiro...";
    if (ui === "gathering") return "A verificar o ficheiro selecionado...";
    if (ui === "finalizing") return "A concluir a análise do ficheiro...";
    return "A analisar o ficheiro...";
  }
  if (scope === "folder") {
    if (ui === "preparing") return "A preparar a análise da pasta...";
    if (ui === "gathering") return "A identificar os ficheiros da pasta...";
    if (ui === "finalizing") return "A concluir a análise da pasta...";
    return "A analisar os ficheiros da pasta...";
  }
  if (ui === "preparing") return "A preparar a análise do computador...";
  if (ui === "gathering") return "A identificar ficheiros a analisar...";
  if (ui === "finalizing") return "A concluir a análise...";
  return "Análise em execução";
}

/**
 * Linha de detalhe do que está a acontecer. Reflete apenas trabalho real do
 * serviço (contacto IPC, enumeração, análise, fecho) — nada de fases inventadas.
 */
export function activeScanDetail(
  scope: ScanScope,
  type: ScanType,
  ui: ScanUiStatus,
  targetName?: string,
): string {
  switch (ui) {
    case "preparing":
      return "A contactar o motor de análise local.";
    case "gathering":
      if (scope === "file") return "A localizar o ficheiro selecionado.";
      if (scope === "folder") {
        return targetName ? `A listar os ficheiros dentro de «${targetName}».` : "A listar os ficheiros da pasta.";
      }
      return type === "full"
        ? "A percorrer as pastas do seu utilizador e os arranques automáticos."
        : "A percorrer as áreas prioritárias (Downloads, Desktop, Documentos, Arranque/Temporários).";
    case "scanning":
      if (scope === "file") return "A carregar e verificar o conteúdo do ficheiro.";
      if (scope === "folder") return "A verificar os ficheiros encontrados na pasta.";
      return "A verificar os ficheiros encontrados.";
    case "finalizing":
      return "A recolher o resultado da análise.";
    default:
      return "Análise concluída.";
  }
}

export interface ScanResultInput {
  scope: ScanScope;
  type: ScanType;
  status: ScanStatus;
  filesScanned: number;
  threatsFound: number;
  filesFailed?: number;
  /** Ficheiros que chegaram aos motores aplicáveis (para "sem deteções"). */
  filesAnalyzed?: number;
  /** Ficheiros ignorados pela política de exclusões (não analisados). */
  filesExcluded?: number;
  /** Nome do ficheiro ou da pasta alvo (nunca o caminho completo). */
  targetName?: string;
  error?: string;
}

function verifiedSentence(count: number): string {
  return count === 1 ? "Foi verificado 1 ficheiro" : `Foram verificados ${count} ficheiros`;
}

function threatSentence(count: number): string {
  if (count === 0) return "não foram encontradas ameaças";
  return count === 1 ? "foi encontrada 1 ameaça" : `foram encontradas ${count} ameaças`;
}

/** Frase-resumo explícita mostrada no fim de cada análise. */
export function buildResultSummary(input: ScanResultInput): string {
  const { scope, type, status, filesScanned, threatsFound, filesFailed = 0, filesExcluded = 0, targetName, error } = input;

  if (status === "failed") {
    return error ? `Não foi possível concluir a análise: ${error}` : "Não foi possível concluir a análise.";
  }
  if (status === "cancelled") {
    return `Análise cancelada depois de verificar ${filesScanned} ${filesScanned === 1 ? "ficheiro" : "ficheiros"}.`;
  }

  if (filesScanned === 0) {
    if (scope === "file") {
      return "O ficheiro selecionado não pôde ser verificado — não foi encontrado nenhum ficheiro nesse caminho.";
    }
    if (scope === "folder") {
      return `Não foram encontrados ficheiros para verificar na pasta${
        targetName ? ` «${targetName}»` : ""
      }. A pasta pode estar vazia ou conter apenas ficheiros excluídos.`;
    }
    return "Não foram encontrados ficheiros para verificar nas áreas analisadas.";
  }

  const tailParts: string[] = [];
  if (filesFailed > 0) {
    tailParts.push(`${filesFailed} ${filesFailed === 1 ? "ficheiro não pôde" : "ficheiros não puderam"} ser analisado(s).`);
  }
  if (filesExcluded && filesExcluded > 0) {
    tailParts.push(`${filesExcluded} ${filesExcluded === 1 ? "ficheiro foi ignorado" : "ficheiros foram ignorados"} pelas exclusões e não ${filesExcluded === 1 ? "passou" : "passaram"} pelos motores de análise.`);
  }
  const tail = tailParts.length > 0 ? ` ${tailParts.join(" ")}` : "";

  if (scope === "file") {
    return `A análise do ficheiro${targetName ? ` «${targetName}»` : ""} foi concluída: ${
      filesScanned === 1 ? "1 ficheiro verificado" : `${filesScanned} ficheiros verificados`
    } e ${threatSentence(threatsFound)}.${tail}`;
  }
  if (scope === "folder") {
    return `A análise da pasta${targetName ? ` «${targetName}»` : ""} foi concluída: ${
      filesScanned === 1 ? "1 ficheiro verificado" : `${filesScanned} ficheiros verificados`
    } dentro da pasta e ${threatSentence(threatsFound)}.${tail}`;
  }
  if (type === "full") {
    return `A análise profunda do computador foi concluída. ${verifiedSentence(filesScanned)} nas pastas do seu utilizador e nos arranques automáticos e ${threatSentence(threatsFound)}.${tail}`;
  }
  return `A análise rápida do computador foi concluída. ${verifiedSentence(filesScanned)} em áreas prioritárias do sistema e ${threatSentence(threatsFound)}.${tail}`;
}
