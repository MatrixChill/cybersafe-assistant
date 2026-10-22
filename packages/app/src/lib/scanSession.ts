import type {
  ExclusionReasonCount,
  ScanPhase,
  ScanState,
  ScanStatus,
  ScanType,
} from "@cybersafe/shared-types";

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
  // "Considerados" = candidatos selecionados pelo scan. NÃO é "verificados":
  // este número inclui os ficheiros ignorados pelas exclusões, que nunca
  // chegaram a motor nenhum. Chamar-lhe "verificados" era a mentira que fazia
  // o utilizador perguntar "se são 800, o que aconteceu aos outros 137?".
  filesConsidered: "Ficheiros considerados",
  // "Analisados pelos motores" = o que passou efetivamente pelos motores.
  filesAnalyzed: "Analisados pelos motores",
  // Factual por construção: conta ficheiros SEM deteção; nunca promete
  // "sem ameaças" quando o scan não terminou ou a base não é conhecida.
  filesWithoutDetections: "Ficheiros sem deteções",
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

/**
 * Normaliza o motivo das exclusões vindo do serviço.
 *
 * Defensivo de propósito: um payload de versão antiga (sem o campo), uma lista
 * com entradas inválidas ou contagens não finitas não podem rebentar a
 * apresentação — sem dados, o cartão mostra o número de excluídos e não inventa
 * o motivo. Um `reason` desconhecido é descartado (nunca vira texto livre na
 * UI, que poderia injetar conteúdo arbitrário no ecrã).
 */
function asExcludedBy(value: unknown): ExclusionReasonCount[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasons = new Set<ExclusionReasonCount["reason"]>(["extension", "path", "filename"]);
  const cleaned: ExclusionReasonCount[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const reason = raw.reason as ExclusionReasonCount["reason"];
    if (!reasons.has(reason)) continue;
    const count = asOptionalNumber(raw.count);
    if (typeof count !== "number" || count <= 0) continue;
    // O detalhe de uma exclusão por caminho nunca atravessa o IPC.
    const detail = reason === "path" ? undefined : asOptionalString(raw.detail);
    cleaned.push({ reason, detail, count: Math.round(count) });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Extended scan state for UI use. Mirrors the service-side `ExtendedScanState`
 * pattern: `failedByReason` is a diagnostic that rides along at runtime but is
 * NOT part of the shared-types contract. Defined locally so the UI can extract
 * it without adding diagnostic filesystem details to `ScanState`.
 */
export type FsErrorCategory =
  | "permissions_denied"
  | "not_found"
  | "path_too_long"
  | "locked_or_busy"
  | "other";

/** Reason label in PT-PT para cada categoria de erro de filesystem. */
const FS_ERROR_REASON_LABEL: Record<FsErrorCategory, string> = {
  permissions_denied: "permissões",
  not_found: "não encontrado",
  path_too_long: "caminho demasiado longo",
  locked_or_busy: "bloqueado ou ocupado",
  other: "outro",
};

export interface ScanStateExtended extends ScanState {
  failedByReason?: Record<FsErrorCategory, number>;
}

function asFailedByReason(value: unknown): Record<FsErrorCategory, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record: Record<FsErrorCategory, number> = {} as Record<FsErrorCategory, number>;
  let hasValid = false;
  const validReasons: FsErrorCategory[] = [
    "permissions_denied",
    "not_found",
    "path_too_long",
    "locked_or_busy",
    "other",
  ];
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!validReasons.includes(key as FsErrorCategory)) continue;
    const count = typeof val === "number" && Number.isFinite(val) && val > 0 ? Math.round(val) : 0;
    if (count > 0) {
      record[key as FsErrorCategory] = count;
      hasValid = true;
    }
  }
  return hasValid ? record : undefined;
}
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
export function normalizeScanState(raw: unknown): ScanState & Partial<ScanStateExtended> | null {
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
    filesInconclusive: asOptionalNumber(source.filesInconclusive),
    filesInEngineBatch: asOptionalNumber((source as { filesInEngineBatch?: unknown }).filesInEngineBatch),
    filesExcluded: asOptionalNumber(source.filesExcluded),
    filesExcludedBy: asExcludedBy(source.filesExcludedBy),
    filesFailed: asOptionalNumber(source.filesFailed),
    failedByReason: asFailedByReason(source.failedByReason),
    revision: asOptionalNumber(source.revision),
    sessionSequence: asOptionalNumber(source.sessionSequence),
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
 * Junta os contadores de falhas por razão. Um evento atrasado não pode
 * diminuir a contagem — mantém-se o total maior de cada categoria.
 */
export function mergeFailedByReason(
  current: Record<FsErrorCategory, number> | undefined,
  next: Record<FsErrorCategory, number> | undefined,
): Record<FsErrorCategory, number> | undefined {
  if (!next || Object.keys(next).length === 0) return current;
  if (!current || Object.keys(current).length === 0) return next;
  const merged: Record<FsErrorCategory, number> = { ...current };
  for (const [reason, count] of Object.entries(next)) {
    merged[reason as FsErrorCategory] = (merged[reason as FsErrorCategory] ?? 0) + count;
  }
  return merged;
}

/**
 * Contadores são monotónicos dentro do mesmo scan: um evento/snapshot atrasado
 * nunca pode fazer um contador recuar.
 */
export function mergeScanState(
  current: (ScanState & Partial<ScanStateExtended>) | null,
  next: ScanState & Partial<ScanStateExtended>,
): ScanState & Partial<ScanStateExtended> {
  if (!current || current.id !== next.id) return next;
  const keepMax = (a?: number, b?: number) => Math.max(a ?? 0, b ?? 0);
  return {
    ...next,
    filesScanned: keepMax(current.filesScanned, next.filesScanned),
    filesProcessed: keepMax(current.filesProcessed, next.filesProcessed) || undefined,
    filesAnalyzed: keepMax(current.filesAnalyzed, next.filesAnalyzed) || undefined,
    filesExcluded: keepMax(current.filesExcluded, next.filesExcluded) || undefined,
    // O motivo acompanha o contador: enquanto o total cresce, a lista do evento
    // mais recente é a mais completa. Quando o total não muda, mantém-se a que
    // já existe (um evento sem o campo não pode apagar a explicação).
    filesExcludedBy:
      (next.filesExcludedBy?.length ?? 0) > 0
        ? next.filesExcludedBy
        : keepMax(current.filesExcluded, next.filesExcluded) > 0
          ? current.filesExcludedBy
          : undefined,
    filesFailed: current.filesFailed === undefined && next.filesFailed === undefined ? undefined : keepMax(current.filesFailed, next.filesFailed),
    failedByReason: mergeFailedByReason(current?.failedByReason, next.failedByReason),
    filesDiscovered: keepMax(current.filesDiscovered, next.filesDiscovered) || undefined,
    // NÃO é keepMax: o batch tem começos e fins. Sobe para N e volta a 0, e um
    // `keepMax` deixaria a UI presa em "20 ficheiros" para sempre — a mentira
    // que este campo existe para evitar. O snapshot mais recente manda.
    filesInEngineBatch: next.filesInEngineBatch,
    threatsFound: keepMax(current.threatsFound, next.threatsFound),
  };
}

/**
 * Quantos ficheiros a UI pode afirmar que foram analisados.
 *
 * O batch do ClamAV é UMA invocação para N ficheiros e o serviço só escreve
 * `filesScanned` no ciclo ficheiro-a-ficheiro, que ainda não começou
 * (scan-manager.ts:476). Durante o batch o motor vai contando as linhas do
 * clamscan em `filesAnalyzed` (scan-manager.ts:399) — 512 ficheiros já
 * analisados com `filesScanned` a 0. Mostrar esse 0 nega trabalho que o motor
 * já fez; usar `filesAnalyzed` a solo negaria os excluídos que o scan sempre
 * contou em `filesScanned`. O MAIOR dos dois é verdade nos dois casos, e nunca
 * é a soma: o batch é um prefetch dos mesmos ficheiros, somá-los contaria
 * cada um duas vezes.
 *
 * É projeção de apresentação, não estado: `normalizeScanState` /
 * `mergeScanState` continuam a guardar os contadores brutos do contrato.
 *
 * ATENÇÃO — este número é COBERTURA DE MOTORES, não conclusão de pipeline, e
 * por isso NÃO pode alimentar a barra: com `filesAnalyzed` a 728 vindo do batch
 * e `filesScanned` a crescer de 0, o maior dos dois fica preso em 728 durante
 * toda a segunda passagem (MEDIDO: a barra parada em 728/800). A barra usa o
 * eixo global (`scanProgressPercent`); a etapa de assinaturas tem eixo próprio
 * (`scanAnalysisStage`).
 */
export function projectedAnalyzedCount(
  state: Pick<ScanState, "filesScanned"> & Pick<ScanState, "filesAnalyzed">,
): number {
  return Math.max(state.filesScanned, state.filesAnalyzed ?? 0);
}

/**
 * Progresso da ETAPA de assinaturas (o batch do ClamAV), num eixo SEPARADO do
 * pipeline global.
 *
 * O batch carrega ~1 GB de base e devolve N veredictos de uma vez: enquanto
 * decorre, `filesInEngineBatch` é a dimensão da etapa e `filesAnalyzed` é o que
 * o clamscan já reportou. É trabalho real e tem de ser visível — mas NÃO é
 * progresso do pipeline: nenhum desses ficheiros completou ainda os restantes
 * motores, e apresentá-lo na barra global era exactamente o que a fazia parecer
 * concluída e ficar presa durante a segunda passagem.
 *
 * `done` é limitado a `total`: uma linha de progresso perdida ou um
 * `filesAnalyzed` de outro eixo nunca podem produzir uma etapa acima de 100%.
 */
export type ScanAnalysisStage = {
  active: boolean;
  done: number;
  total: number;
  percent: number | null;
};

export function scanAnalysisStage(state: ScanState | null): ScanAnalysisStage {
  const total = state?.filesInEngineBatch ?? 0;
  if (!Number.isFinite(total) || total <= 0) {
    return { active: false, done: 0, total: 0, percent: null };
  }
  const done = Math.min(Math.max(state?.filesAnalyzed ?? 0, 0), total);
  return { active: true, done, total, percent: Math.floor((done / total) * 100) };
}

/**
 * Percentagem a mostrar na barra: CONCLUSÃO DO PIPELINE GLOBAL, isto é
 * ficheiros com resultado terminal (analisados, excluídos ou falhados).
 *
 * Usa o total REAL de candidatos congelado pelo serviço; se ainda não existir
 * (fase gathering), devolve null para a UI mostrar barra indeterminada em vez
 * de uma percentagem inventada.
 *
 * Um veredicto do batch do ClamAV é UMA etapa e NÃO conta aqui: marcar 728
 * ficheiros como pipeline-concluídos só porque o motor de assinaturas acabou
 * seria apresentar conclusão prematura e prendia a barra em 728/800 durante
 * toda a segunda passagem. Ver `scanAnalysisStage`.
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
 * Percentagem a mostrar na BARRA PRINCIPAL — UMA só, contínua e monotónica.
 *
 * CORREÇÃO P0 UX (15/10, teste humano da C3): a versão anterior deixava a
 * barra seguir a etapa de assinaturas (97%) e depois o pipeline global (17%)
 — a barra RECUA e parece reiniciar entre fases. Fica proibido por
 * construção: a barra só mostra o eixo GLOBAL (ficheiros com ciclo fechado,
 * `filesScanned/filesTotal`), que só cresce. O progresso da etapa é dito em
 * TEXTO separado (`activeScanDetail`: "Fase de assinaturas: N de M"), nunca
 * como percentagem global. Sem total conhecido → indeterminada, nunca %.
 * `source` declara de onde vem o número mostrado.
 */
export function scanPrimaryBar(state: ScanState | null): { percent: number | null; source: "pipeline" | "nenhum" } {
  const pipeline = scanProgressPercent(state);
  if (pipeline === null) return { percent: null, source: "nenhum" };
  if (pipeline > 0) return { percent: pipeline, source: "pipeline" };
  // pipeline a 0 fora do terminal: barra indeterminada honesta (a fase e o
  // progresso dela vivem em texto proprio; ver activeScanDetail/scanAnalysisStage).
  if (state && isTerminalScanStatus(state.status)) return { percent: 0, source: "pipeline" };
  return { percent: null, source: "nenhum" };
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
 * Segundos reais passados desde o início do scan. Conta tempo de relógio —
 * inclui por isso os ~7,6 s de carga da base do ClamAV, em que
 * `filesAnalyzed` é 0. É exatamente por isso que a velocidade se mostra
 * como "—" (ver `scanRateLabel`): o tempo avança, a análise ainda não.
 */
export function scanElapsedSeconds(state: ScanState | null, now: number = Date.now()): number {
  if (!state?.startTime) return 0;
  const started = Date.parse(state.startTime);
  if (!Number.isFinite(started)) return 0;
  const end = state.endTime ? Date.parse(state.endTime) : now;
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - started) / 1000));
}

/**
 * Duração final legível a partir dos carimbos do motor. Sem os dois
 * carimbos devolve null — o rodapé mostra então o tempo decorrido medido,
 * mas nunca inventa uma duração que o motor não carimbou.
 */
export function formatScanDurationLabel(state: Pick<ScanState, "startTime" | "endTime">): string | null {
  if (!state.startTime || !state.endTime) return null;
  const started = Date.parse(state.startTime);
  const ended = Date.parse(state.endTime);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  const ms = ended - started;
  if (ms < 0) return null;
  if (ms < 1000) return "menos de 1 segundo";
  const seconds = Math.floor(ms / 1000);
  return seconds === 1 ? "1 segundo" : `${seconds} segundos`;
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
 * O botão de cancelar só oferece o que pode acontecer:
 * - sem scan id (preparing antes da resposta do serviço) não há o que cancelar;
 * - depois do pedido e antes do evento terminal do motor, o pedido já foi
 *   feito — insistir seria enviar o mesmo cancelamento repetidas vezes;
 * - em estado terminal (incluindo durante um batch que já acabou) não há scan.
 */
export function cancelButtonState(
  ui: ScanUiStatus,
  hasScanId: boolean,
  cancelRequested: boolean,
): { enabled: boolean; label: string } {
  if (!isActiveUiStatus(ui) || !hasScanId) return { enabled: false, label: "Cancelar" };
  if (cancelRequested) return { enabled: false, label: "Cancelamento pedido..." };
  return { enabled: true, label: "Cancelar" };
}

/**
 * A frase do cartão em curso enquanto o pedido de cancelamento JÁ foi enviado
 * e o motor ainda não confirmou o terminal. Diz o que se sabe: pediu-se, e o
 * fim depende da confirmação do motor — nunca "cancelado" antes de ser verdade.
 *
 * P0 UX (15/10): esta frase vivia numa strip escura (o "registo" da página)
 * que passava a análise toda vazia — era o segundo bloco escuro sem função no
 * cartão. Passou para uma linha visível, ao lado do progresso.
 */
export const SCAN_CANCEL_REQUESTED_NOTE =
  "Cancelamento pedido ao motor. A análise só termina quando o motor confirmar.";

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
  filesInEngineBatch = 0,
  filesVerifiedInBatch = 0,
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
      // O batch do ClamAV é UMA invocação para N ficheiros e demora ~7,6 s a
      // carregar a base antes de devolver qualquer coisa. Dizer "A verificar os
      // ficheiros encontrados" durante esse tempo descreve trabalho que ainda
      // não começou. Dizer a verdade é melhor que dizer nada de diferente.
      if (filesInEngineBatch > 0) {
        const done = filesVerifiedInBatch ?? 0;
        if (filesInEngineBatch === 1) {
          return "O motor de assinaturas está a verificar 1 ficheiro de uma vez.";
        }
        return done > 0
          ? `Fase de assinaturas: ${done} de ${filesInEngineBatch} verificados pelo motor.`
          : `O motor de assinaturas está a verificar ${filesInEngineBatch} ficheiros de uma só vez.`;
      }
      if (scope === "file") return "A carregar e verificar o conteúdo do ficheiro.";
      if (scope === "folder") return "A verificar os ficheiros encontrados na pasta.";
      return "A verificar os ficheiros encontrados.";
    case "finalizing":
      return "A recolher o resultado da análise.";
    default:
      return "Análise concluída.";
  }
}

/**
 * Identidade do ALVO, para a linha que fica por cima da barra de progresso.
 *
 * Devolve `null` quando nao ha alvo a nomear: uma analise do computador nao tem
 * um, e uma pasta cujo nome ainda nao chegou ao renderer tambem nao. O que este
 * sitio NUNCA pode fazer e repetir a frase de fase do titulo do painel
 * (`activeScanTitle`) — era isso que punha «A analisar os ficheiros da pasta...»
 * duas vezes no mesmo cartao, uma no titulo e outra na linha do alvo (defeito
 * reportado no teste humano de 15/10).
 */
export function activeScanTarget(
  scope: ScanScope,
  currentFile?: string,
  targetName?: string,
): string | null {
  if (scope === "file") {
    const name = currentFile || targetName;
    return name ? `Ficheiro: ${name}` : null;
  }
  if (scope === "folder") return targetName ? `Pasta: ${targetName}` : null;
  return null;
}

/**
 * Leitura do contador da linha do alvo — e a UNICA percentagem que a barra pode
 * desenhar.
 *
 * Regra (P1-B, teste humano de 15/10): a barra mostra a fase e o contador que
 * chegam do estado, e so desenha proporcao quando existe um denominador REAL
 * (`scanProgressPercent` devolve `null` sem total selecionado). Sem dados a
 * barra fica INDETERMINADA — nunca uma percentagem inventada, e nunca uma barra
 * parada a fingir quando o motor ja reporta um numero.
 *
 * Fora da fase `scanning` nao se afirma um numero nenhum: `finalizing` fecha a
 * analise, nao mede progresso.
 */
export function scanProgressReadout(input: {
  scope: ScanScope;
  ui: ScanUiStatus;
  percent: number | null;
  discovered: number;
  hasFileActivity?: boolean;
}): { label: string; percent: number | null } {
  const { scope, ui, percent, discovered, hasFileActivity = false } = input;
  if (ui === "gathering") {
    return { label: `${discovered} ${discovered === 1 ? "ficheiro" : "ficheiros"}`, percent: null };
  }
  if (ui === "scanning") {
    if (scope === "file") {
      return hasFileActivity
        ? { label: "100%", percent: 100 }
        : { label: "a verificar", percent: null };
    }
    return percent !== null
      ? { label: `${percent}%`, percent }
      : { label: "a analisar", percent: null };
  }
  if (ui === "finalizing") return { label: "a concluir", percent: null };
  // `preparing`: ainda nao ha nada medido — as reticencias sao a verdade.
  return { label: "…", percent: null };
}

export interface ScanResultInput {
  scope: ScanScope;
  type: ScanType;
  status: ScanStatus;
  /**
   * Candidatos selecionados pelo scan. Era `filesScanned` e a frase chamava-lhe
   * "verificados" — incluía os excluídos, que nunca foram verificados por motor
   * nenhum. O nome mudou para não voltar a mentir por descuido.
   */
  filesConsidered: number;
  threatsFound: number;
  filesFailed?: number;
  /** Ficheiros analisados sem resultado conclusivo dos motores aplicáveis. */
  filesInconclusive?: number;
  /** Ficheiros que chegaram aos motores aplicáveis (para "sem deteções"). */
  filesAnalyzed?: number;
  /** Ficheiros ignorados pela política de exclusões (não analisados). */
  filesExcluded?: number;
  /** Nome do ficheiro ou da pasta alvo (nunca o caminho completo). */
  targetName?: string;
  error?: string;
}

/** "Analisados" (motores) — o número que pode ser afirmado como verificação. */
function analyzedSentence(analyzed: number, considered: number): string {
  if (considered > analyzed) {
    return analyzed === 1
      ? `Foi analisado 1 de ${considered} ficheiros considerados`
      : `Foram analisados ${analyzed} de ${considered} ficheiros considerados`;
  }
  return analyzed === 1 ? "Foi analisado 1 ficheiro" : `Foram analisados ${analyzed} ficheiros`;
}

function threatSentence(count: number): string {
  if (count === 0) return "não foram encontradas ameaças";
  return count === 1 ? "foi encontrada 1 ameaça" : `foram encontradas ${count} ameaças`;
}

/**
 * Nota de follow-up sob o resumo de uma análise CONCLUÍDA com ameaças.
 * VERIFICADO 15/10 (GUI-TEST-01): a política efetiva de quarentena é `warn`
 * (ficheiro `protection-policy.json` ausente → loader devolve `warn`), pelo que
 * o motor NÃO isola nada automaticamente — o texto antigo afirmava quarentena
 * automática ativa, o que era falso. A nota aponta para a ação manual honesta.
 * Quando a política `automatic-high-confidence` for exposta pela UI (item P0-3),
 * esta nota deverá passar a refletir o estado real em vez de uma cópia fixa.
 */
export function resultFollowUpNote(status: ScanStatus | string, threatsFound: number): string | null {
  if (status !== "completed" || threatsFound <= 0) return null;
  return "Nenhum ficheiro foi isolado automaticamente. Revista as ameaças na página Ameaças e coloque-as em quarentena manualmente.";
}

/**
 * Linha terminal do registo visível do Scanner. Vive aqui (e não embrulhada
 * no componente) porque é copy do produto: os Plurais têm de ser os mesmos
 * que o resto da UI — "1 ficheiro analisado", nunca "1 ficheiros".
 */
export function terminalScanLogMessage(
  state: Pick<ScanState, "status" | "filesScanned" | "filesAnalyzed" | "threatsFound" | "error">,
): string {
  // "Analisados" é `filesAnalyzed` (o que passou pelos motores). `filesScanned`
  // é o pipeline concluído e INCLUI os excluídos — usá-lo aqui dizia
  // "800 ficheiros analisados" quando 137 nunca viram um motor.
  //
  // Sem `filesAnalyzed` não se afirma análise nenhuma: diz-se o que se sabe (os
  // considerados). "0 ficheiros analisados" seria concluir de uma ausência.
  const considered = Math.max(0, state.filesScanned ?? 0);
  const hasAnalyzed = typeof state.filesAnalyzed === "number" && Number.isFinite(state.filesAnalyzed);
  const analyzed = hasAnalyzed ? Math.max(0, state.filesAnalyzed as number) : 0;
  const files = !hasAnalyzed
    ? considered === 1
      ? "1 ficheiro considerado"
      : `${considered} ficheiros considerados`
    : considered > analyzed
      // Com exclusões/falhas a frase diz os dois números: sem isso o utilizador
      // vê "800 considerados" no cartão e "663 analisados" e não sabe o resto.
      ? `${analyzed} de ${considered} ficheiros analisados`
      : analyzed === 1
        ? "1 ficheiro analisado"
        : `${analyzed} ficheiros analisados`;
  if (state.status === "completed") {
    const threats =
      state.threatsFound === 0
        ? "sem ameaças encontradas"
        : state.threatsFound === 1
          ? "1 ameaça encontrada"
          : `${state.threatsFound} ameaças encontradas`;
    return `Análise concluída: ${files}, ${threats}`;
  }
  if (state.status === "cancelled") return `Análise cancelada: ${files}`;
  return state.error ? `Análise falhada: ${state.error}` : "Análise falhada";
}

/** Rodapé do resultado — nunca "ficheiro(s)": ou é 1, ou são N. */
export function filesFailedFooterLabel(count: number): string {
  return count === 1 ? "1 ficheiro não pôde ser analisado" : `${count} ficheiros não puderam ser analisados`;
}

/**
 * A frase que explica PORQUÊ ficheiros falharam, a partir de failedByReason.
 * Devolve null quando não há dados de categoria — o rodapé mostra então o
 * número simples (nunca inventa motivos).
 */
export function failureReasonsLabel(
  failedByReason: Record<FsErrorCategory, number> | undefined,
): string | null {
  if (!failedByReason || Object.keys(failedByReason).length === 0) return null;
  const parts: string[] = [];
  for (const [reason, count] of Object.entries(failedByReason)) {
    if (count > 0) {
      parts.push(`${count} ${count === 1 ? "ficheiro" : "ficheiros"} (${FS_ERROR_REASON_LABEL[reason as FsErrorCategory]})`);
    }
  }
  if (parts.length === 0) return null;
  return parts.sort().join(", ");
}

export function filesExcludedFooterLabel(count: number): string {
  return count === 1 ? "1 ficheiro ignorado por exclusões" : `${count} ficheiros ignorados por exclusões`;
}

type NoDetectionsInput = Pick<
  ScanState,
  "status" | "threatsFound" | "filesAnalyzed" | "filesFailed" | "filesInconclusive"
>;

/**
 * A DECOMPOSIÇÃO HONESTA DO RESULTADO — o que responde a "800 vs 663".
 *
 * O serviço conta o pipeline assim (scan-manager.ts, um ficheiro cai sempre num
 * destes ramos):
 *
 *     considerados (filesScanned/filesTotal) = analisados + excluídos + falhados
 *
 * `filesAnalyzed` é o que chegou aos motores; `filesExcluded` são os ignorados
 * pela política de exclusões (nunca viram motor nenhum) e `filesFailed` os que
 * não puderam ser lidos/analisados. Sem esta decomposição à vista, dois números
 * no mesmo cartão pareciam contradizer-se.
 *
 * `reconciled` é a prova aritmética de que a soma fecha. Quando não fecha, a UI
 * diz isso mesmo — nunca inventa a categoria em falta.
 */
export interface ScanResultBreakdown {
  /** Candidatos selecionados pelo scan (denominador real). */
  considered: number;
  /** Ficheiros que chegaram efetivamente aos motores. */
  analyzed: number;
  /** Analisados sem qualquer deteção (só numa análise concluída). */
  withoutDetections: number | null;
  threats: number;
  /** Ignorados pela política de exclusões (não passaram por motor nenhum). */
  excluded: number;
  /** Não foi possível analisar (erro de leitura/motor). */
  failed: number;
  /** Considerados que NÃO foram analisados (= excluídos + falhados). */
  notAnalyzed: number;
  /** `analisados + excluídos + falhados === considerados`. */
  reconciled: boolean;
  /** PORQUÊ os excluídos foram excluídos (agregado pelo serviço). */
  excludedBy: ExclusionReasonCount[];
}

export function scanResultBreakdown(state: ScanState | null): ScanResultBreakdown | null {
  if (!state) return null;
  const considered =
    typeof state.filesTotal === "number" && state.filesTotal > 0 ? state.filesTotal : state.filesScanned;
  if (!Number.isFinite(considered) || considered <= 0) return null;

  const analyzed = Math.max(0, state.filesAnalyzed ?? 0);
  const inconclusive = Math.max(0, state.filesInconclusive ?? 0);
  const excluded = Math.max(0, state.filesExcluded ?? 0);
  const failed = Math.max(0, state.filesFailed ?? 0);
  const threats = Math.max(0, state.threatsFound ?? 0);

  return {
    considered,
    analyzed,
    threats,
    excluded,
    failed,
    notAnalyzed: Math.max(0, considered - analyzed),
    reconciled: analyzed + excluded + failed === considered,
    withoutDetections: state.status === "completed" && typeof state.filesInconclusive === "number"
      ? Math.max(0, analyzed - threats - inconclusive)
      : null,
    excludedBy: state.filesExcludedBy ?? [],
  };
}

/**
 * Explicação simples das exclusões, com o detalhe técnico disponível.
 *
 * As categorias vêm do motor (nunca de uma lista escrita à mão no renderer),
 * por isso a frase continua verdadeira se a política de exclusões mudar. Para
 * exclusões por caminho não há detalhe: o caminho é do utilizador e não
 * atravessa o IPC.
 */
export function excludedReasonsLabel(excludedBy: ExclusionReasonCount[]): string | null {
  if (!excludedBy || excludedBy.length === 0) return null;
  const parts: string[] = [];
  const extensions = excludedBy
    .filter((entry) => entry.reason === "extension" && entry.detail)
    .map((entry) => entry.detail as string)
    .sort();
  if (extensions.length > 0) parts.push(`extensões de cache/temporários (${extensions.join(", ")})`);
  const names = excludedBy
    .filter((entry) => entry.reason === "filename" && entry.detail)
    .map((entry) => entry.detail as string)
    .sort();
  if (names.length > 0) parts.push(`nomes excluídos (${names.join(", ")})`);
  if (excludedBy.some((entry) => entry.reason === "path")) parts.push("pastas internas do próprio CyberSafe");
  return parts.length > 0 ? parts.join(", ") : null;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A frase que reconcilia os números do cartão. Devolve null quando não há nada
 * a explicar (todos os considerados foram analisados) ou quando o scan ainda
 * está a correr.
 */
export function scanResultBreakdownNote(
  breakdown: ScanResultBreakdown,
  status: ScanStatus | string,
): string | null {
  if (status !== "completed" && status !== "cancelled" && status !== "failed") return null;

  if (status !== "completed") {
    return `A análise não chegou ao fim: ${countLabel(breakdown.analyzed, "ficheiro foi analisado", "ficheiros foram analisados")} de ${breakdown.considered} considerados.`;
  }

  if (breakdown.notAnalyzed === 0) return null;

  // A soma não fecha (p.ex. o motor de assinaturas reportou um número que o
  // pipeline não fechou): di-lo, não escolhe uma categoria para tapar o buraco.
  if (!breakdown.reconciled) {
    return `A decomposição não fecha: ${breakdown.analyzed} analisados + ${breakdown.excluded} ignorados + ${breakdown.failed} falhados ≠ ${breakdown.considered} considerados. Reporta isto — os números do motor não estão coerentes.`;
  }

  // A copy de cada categoria vive nos helpers já testados (Plurais corretos,
  // nunca "(s)") — a nota só os junta com o motivo real vindo do motor.
  const reasons = excludedReasonsLabel(breakdown.excludedBy);
  const parts: string[] = [];
  if (breakdown.excluded > 0) {
    parts.push(`${filesExcludedFooterLabel(breakdown.excluded)}${reasons ? ` — ${reasons}` : ""}`);
  }
  if (breakdown.failed > 0) {
    parts.push(filesFailedFooterLabel(breakdown.failed));
  }

  return `Dos ${breakdown.considered} ficheiros considerados, ${breakdown.analyzed} foram analisados pelos motores e ${breakdown.notAnalyzed} não: ${parts.join(" e ")}.`;
}

/**
 * Quantos ficheiros chegaram aos motores sem qualquer deteção. Só uma análise
 * CONCLUÍDA tem esse direito; a base é `filesAnalyzed` (os que passaram pelos
 * motores) — nunca `filesScanned`, que inclui os excluídos que ninguém
 * verificou. Sem base conhecida devolve null: a UI mostra "—" e não 0.
 */
export function resultFilesWithoutDetections(state: NoDetectionsInput): number | null {
  if (state.status !== "completed") return null;
  if (typeof state.filesAnalyzed !== "number" || !Number.isFinite(state.filesAnalyzed)) return null;
  if (typeof state.filesInconclusive !== "number" || !Number.isFinite(state.filesInconclusive)) return null;
  return Math.max(0, state.filesAnalyzed - state.threatsFound - state.filesInconclusive);
}

/**
 * A REGRA CRÍTICA do Scanner, num só sítio: a tranquilização "sem ameaças"
 * (cartão verde, avatar de sucesso, nota de ausência de deteções) só é
 * permitida quando a análise TERMINOU a sério, há dados reais e o número de
 * ameaças é zero. Em preparo/análise, cancelada, falhada, com ameaças ou sem
 * estado do motor, nada é afirmado.
 */
export function showNoThreatsReassurance(ui: ScanUiStatus, state: ScanState | null): boolean {
  return ui === "completed" &&
    state !== null &&
    state.threatsFound === 0 &&
    typeof state.filesAnalyzed === "number" &&
    state.filesAnalyzed > 0 &&
    state.filesFailed === 0 &&
    state.filesInconclusive === 0;
}

export type TerminalResultLabels = {
  titulo: string;
  chip: string;
  tom: "green" | "yellow" | "red";
};

/**
 * Título e chip do cartão de RESULTADO FINAL.
 *
 * "Concluída" ≠ "segura": acabar a análise é um facto, não ter ameaças é outro.
 * Com uma ameaça, os dois factos aparecem na frase E na cor — o cartão não fica
 * verde só porque o motor terminou.
 */
export function terminalResultLabels(ui: ScanUiStatus, state: ScanState | null): TerminalResultLabels {
  if (ui === "completed") {
    if ((state?.threatsFound ?? 0) > 0) {
      return { titulo: "Análise concluída — ameaças encontradas", chip: "Ameaças encontradas", tom: "red" };
    }
    if (showNoThreatsReassurance("completed", state)) {
      return { titulo: "Análise concluída", chip: "Concluída", tom: "green" };
    }
    return {
      titulo: "Análise concluída com verificações inconclusivas",
      chip: "Parcial",
      tom: "yellow",
    };
  }
  if (ui === "cancelled") return { titulo: "Análise cancelada", chip: "Cancelada", tom: "yellow" };
  return { titulo: "Análise falhada", chip: "Falhada", tom: "red" };
}

/**
 * O tom do cartão "Ficheiros sem deteções". O verde é EXCLUSIVO de
 * "análise concluída, base conhecida, zero ameaças". Com ameaças, a contagem
 * é real mas não é um veredicto limpo; cancelada/falhada/sem base
 * (inconclusiva) é cinzenta — estado incerto nunca pode parecer "safe".
 */
export function noDetectionsTone(state: NoDetectionsInput): "green" | "neutral" {
  if (
    resultFilesWithoutDetections(state) === null ||
    state.filesAnalyzed === undefined ||
    state.filesAnalyzed <= 0 ||
    state.filesFailed !== 0 ||
    state.filesInconclusive !== 0
  ) return "neutral";
  return state.threatsFound === 0 ? "green" : "neutral";
}

/** Linha por baixo do número: qual a base, ou por que não há contagem fiável. */
export function resultFilesWithoutDetectionsNote(state: NoDetectionsInput): string {
  if (state.status === "completed") {
    if (typeof state.filesAnalyzed === "number" && Number.isFinite(state.filesAnalyzed)) {
      const base = `de ${state.filesAnalyzed} ${state.filesAnalyzed === 1 ? "ficheiro enviado" : "ficheiros enviados"} aos motores`;
      if (typeof state.filesInconclusive !== "number") {
        return `o estado conclusivo dos ${state.filesAnalyzed} ficheiros não foi reportado pelo motor`;
      }
      if (state.filesInconclusive > 0) {
        return `${base}; ${state.filesInconclusive} ${
          state.filesInconclusive === 1 ? "teve um resultado inconclusivo" : "tiveram resultados inconclusivos"
        }`;
      }
      return base;
    }
    return "o motor não reportou quantos ficheiros chegaram aos motores";
  }
  if (state.status === "failed") return "a análise falhou; não há contagem fiável";
  if (state.status === "cancelled") return "a análise não foi concluída; não há contagem fiável";
  return "a análise ainda não terminou";
}

/** Frase-resumo explícita mostrada no fim de cada análise. */
export function buildResultSummary(input: ScanResultInput): string {
  const {
    scope,
    type,
    status,
    filesConsidered,
    threatsFound,
    filesFailed = 0,
    filesExcluded = 0,
    filesInconclusive,
    filesAnalyzed,
    targetName,
    error,
  } = input;
  // Sem `filesAnalyzed` conhecido, o único número afirmável como verificação é
  // o dos considerados — e é esse que a frase usa, nunca um valor inventado.
  //
  // ATENÇÃO: esse fallback é legítimo no resumo de uma análise CONCLUÍDA (o
  // pipeline fechou os considerados) e é precisamente a mentira que o
  // cancelamento não pode herdar — ver o ramo `cancelled` abaixo.
  const analyzedKnown = typeof filesAnalyzed === "number" && Number.isFinite(filesAnalyzed);
  const analyzed = analyzedKnown ? Math.max(0, filesAnalyzed) : filesConsidered;

  if (status === "failed") {
    return error ? `Não foi possível concluir a análise: ${error}` : "Não foi possível concluir a análise.";
  }
  if (status === "cancelled") {
    // A5 — contadores exatos no cancelamento. "Cancelada depois de analisar
    // 2000 ficheiros considerados" dizia que 2000 ficheiros foram analisados
    // quando o motor nunca reportou `filesAnalyzed` (o número vinha do
    // fallback dos considerados), e a mesma frase saía quando TODOS tinham
    // mesmo sido analisados: "desconhecido" e "todos" ficavam indistinguíveis.
    // Aqui considerados e analisados são eixos distintos e o desconhecido é dito
    // como desconhecido. Só texto: nenhum contador, merge ou estado é tocado.
    if (filesConsidered <= 0) {
      return "Análise cancelada antes de haver ficheiros considerados para analisar.";
    }
    if (!analyzedKnown) {
      return filesConsidered === 1
        ? "Análise cancelada: o motor não indicou se o único ficheiro considerado chegou a ser analisado."
        : `Análise cancelada: o motor não indicou quantos dos ${filesConsidered} ficheiros considerados chegaram a ser analisados.`;
    }
    if (analyzed < filesConsidered) {
      // Com dois números, diz os dois: "cancelada depois de verificar 120" não
      // dizia de quantos, e um cancelamento com 680 por analisar parecia completo.
      if (filesConsidered === 1) {
        return "Análise cancelada: o único ficheiro considerado não chegou a ser analisado.";
      }
      return `Análise cancelada: ${analyzed} de ${filesConsidered} ficheiros considerados ${
        analyzed === 1 ? "chegou a ser analisado" : "chegaram a ser analisados"
      }.`;
    }
    return filesConsidered === 1
      ? "Análise cancelada depois de analisar o único ficheiro considerado."
      : `Análise cancelada depois de analisar os ${filesConsidered} ficheiros considerados.`;
  }

  if (filesConsidered === 0) {
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

  const tails: string[] = [];
  if (filesExcluded && filesExcluded > 0) {
    tails.push(
      `${filesExcluded} ${filesExcluded === 1 ? "ficheiro foi ignorado" : "ficheiros foram ignorados"} pelas exclusões e não ${filesExcluded === 1 ? "passou" : "passaram"} pelos motores de análise`,
    );
  }
  if (filesFailed > 0) {
    tails.push(
      `${filesFailed} ${filesFailed === 1 ? "ficheiro não pôde" : "ficheiros não puderam"} ser analisado${filesFailed === 1 ? "" : "s"}`,
    );
  }
  if (typeof filesInconclusive === "number" && filesInconclusive > 0) {
    tails.push(
      filesInconclusive === 1
        ? "1 ficheiro teve um resultado inconclusivo dos motores"
        : `${filesInconclusive} ficheiros tiveram resultados inconclusivos dos motores`,
    );
  } else if (filesInconclusive === undefined && typeof filesAnalyzed === "number") {
    tails.push("não foi possível confirmar se todos os motores concluíram a análise");
  }
  const tail = tails.length > 0 ? ` ${tails.join(" e ")}.` : "";

  if (scope === "file") {
    return `A análise do ficheiro${targetName ? ` «${targetName}»` : ""} foi concluída: ${analyzedSentence(
      analyzed,
      filesConsidered,
    )} e ${threatSentence(threatsFound)}.${tail}`;
  }
  if (scope === "folder") {
    return `A análise da pasta${targetName ? ` «${targetName}»` : ""} foi concluída: ${analyzedSentence(
      analyzed,
      filesConsidered,
    )} dentro da pasta e ${threatSentence(threatsFound)}.${tail}`;
  }
  if (type === "full") {
    return `A análise profunda do computador foi concluída. ${analyzedSentence(
      analyzed,
      filesConsidered,
    )} nas pastas do seu utilizador e nos arranques automáticos e ${threatSentence(threatsFound)}.${tail}`;
  }
  return `A análise rápida do computador foi concluída. ${analyzedSentence(
    analyzed,
    filesConsidered,
  )} em áreas prioritárias do sistema e ${threatSentence(threatsFound)}.${tail}`;
}

/** Resumo de apresentação; preserva os contadores do serviço. */
export function conciseResultSummary(input: ScanResultInput): string {
  if (input.scope !== "computer" || input.type !== "quick" || input.status !== "completed" || input.filesConsidered === 0) return buildResultSummary(input);
  const { filesAnalyzed, threatsFound, filesExcluded = 0, filesFailed = 0, filesInconclusive } = input;
  const known = typeof filesAnalyzed === "number" && Number.isFinite(filesAnalyzed);
  const threats = threatsFound === 1 ? "Foi detetada 1 ameaça" : "Foram detetadas " + threatsFound + " ameaças";
  let summary: string;
  if (!known) {
    summary = (threatsFound > 0 ? threats + ". " : "") + "O resultado não indicou quantos ficheiros foram analisados.";
  } else if (filesAnalyzed <= 0) {
    summary = (threatsFound > 0 ? threats + ". " : "") + "Nenhum ficheiro foi analisado.";
  } else if (filesInconclusive === undefined) {
    summary = (threatsFound > 0 ? threats + ". " : "") + "Não foi possível confirmar se todos os motores concluíram a análise.";
  } else if (filesInconclusive > 0) {
    const conclusivelyAnalyzed = Math.max(0, filesAnalyzed - filesInconclusive);
    if (threatsFound > 0) {
      summary = threats + ".";
    } else if (conclusivelyAnalyzed > 0) {
      summary = conclusivelyAnalyzed === 1
        ? "Não foram detetadas ameaças no ficheiro com resultado conclusivo."
        : `Não foram detetadas ameaças nos ${conclusivelyAnalyzed} ficheiros com resultado conclusivo.`;
    } else {
      summary = "Nenhum ficheiro teve um resultado conclusivo.";
    }
    summary += filesInconclusive === 1
      ? " 1 ficheiro teve um resultado inconclusivo dos motores."
      : ` ${filesInconclusive} ficheiros tiveram resultados inconclusivos dos motores.`;
  } else {
    const base = filesAnalyzed === 1 ? "no ficheiro analisado" : "nos " + filesAnalyzed + " ficheiros analisados";
    summary = (threatsFound > 0 ? threats : "Não foram detetadas ameaças") + " " + base + ".";
  }
  if (filesExcluded > 0) summary += filesExcluded === 1 ? " Outro ficheiro ficou fora da análise pelas regras de exclusão." : " Outros " + filesExcluded + " ficaram fora da análise pelas regras de exclusão.";
  if (filesFailed > 0) summary += " Não foi possível analisar " + filesFailed + (filesFailed === 1 ? " ficheiro." : " ficheiros.");
  return summary;
}


/** Resultado apresentado, distinto de uma sessão viva recuperável. */
export function decideScanAttachment(current: ScanState | null, raw: unknown): ScanState | null {
  const next = normalizeScanState(raw);
  if (!next || next.status === "idle") return null;
  if (!current) return next;
  if (current.id === next.id) {
    if (!shouldAcceptScanState(current, next)) return null;
    if (isTerminalScanStatus(current.status)) return null;
    return mergeScanState(current, next);
  }
  const before = Date.parse(current.startTime ?? "");
  const after = Date.parse(next.startTime ?? "");
  if (!Number.isFinite(before) || !Number.isFinite(after) || after < before) return null;
  if (after === before && (next.sessionSequence ?? 0) <= (current.sessionSequence ?? 0)) return null;
  return next;
}

/** Snapshot vivo prioritário; o resultado terminal usa uma porta separada. */
export async function readScanSnapshot(api: {
  getActiveScan: () => Promise<ScanState | null>;
  getLastScan: (id?: string) => Promise<ScanState | null>;
}, id?: string): Promise<ScanState | null> {
  const active = normalizeScanState(await api.getActiveScan());
  if (active && (active.status === "running" || active.status === "queued") && (!id || active.id === id)) return active;
  const terminal = normalizeScanState(await api.getLastScan(id));
  if (id) return terminal?.id === id && isTerminalScanStatus(terminal.status) ? terminal : null;
  // Uma sessão pode ter começado entre as duas leituras. Nunca sobrepor-lhe o resultado anterior.
  const latestActive = normalizeScanState(await api.getActiveScan());
  if (latestActive && (latestActive.status === "running" || latestActive.status === "queued")) return latestActive;
  return terminal && isTerminalScanStatus(terminal.status) ? terminal : null;
}
