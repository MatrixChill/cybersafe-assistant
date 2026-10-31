import type {
  EngineHealth,
  EngineSubsystemHealth,
  EngineSubsystemStatus,
  ProtectionState,
} from "@cybersafe/shared-types";
import { wfpHealth } from "@cybersafe/shared-types";

/**
 * ── CONTRATO DE ESTADOS DE CARREGAMENTO ──────────────────────────────────────
 *
 * A aplicação tem de distinguir CINCO situações, e nunca as confundir:
 *
 *   INITIALIZING  Ainda a obter dados. A única altura em que se diz «a carregar».
 *   READY         O serviço respondeu e não há componentes em falta. É o único
 *                 estado VERDE — e só existe DEPOIS de uma leitura confirmada.
 *   DEGRADED      Dados confirmados, mas um componente está limitado (ex.: YARA
 *                 degradado, módulo WFP indisponível). NUNCA é «a carregar».
 *   UNAVAILABLE   Não há comunicação com o serviço, ou o serviço reporta que o
 *                 motor não corre. É um FACTO, não uma espera.
 *   ERROR         O serviço respondeu mas um componente reporta erro, ou a
 *                 sincronização falhou. Também é um estado confirmado.
 *
 * REGRAS DE HONESTIDADE (as que interessam na UI):
 *   · Sem vermelho prematuro: enquanto não há leitura, o tom é neutro.
 *   · Sem verde antes de confirmação: READY exige `protection` presente.
 *   · Sem percentagens inventadas: este módulo não produz números de progresso.
 *   · Não mascarar como «a carregar» um estado JÁ confirmado pelo serviço —
 *     um YARA `degraded` ou um WFP `unavailable` chegam a `DEGRADED`, não a
 *     `INITIALIZING`.
 *   · Após o timeout há um MOTIVO escrito e, quando a repetição é suportada,
 *     `canRetry = true`. Nunca «A carregar» sem fim.
 *
 * Este módulo é PURO e determinístico: testável sem renderer, e a única fonte
 * de verdade das frases. A UI lê daqui, não inventa copy própria.
 */

export type LoadingStateName =
  | "INITIALIZING"
  | "READY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "ERROR"
  /**
   * O serviço está ligado e RESPONDEU, mas recusou deliberadamente rotinas fora
   * do âmbito da sessão (o gate de fixture DEV). Não é espera (`INITIALIZING`) —
   * não há nada a carregar — nem avaria (`ERROR` / `UNAVAILABLE`) — o pipe está
   * bom. E não é `READY`: sem leitura nenhuma, não se afirma proteção nenhuma.
   */
  | "REFUSED";

/** Porque é que o recurso está no estado em que está (motivo legível). */
export type LoadingReason =
  | "waiting"
  | "timeout"
  | "degraded"
  | "unavailable"
  | "error"
  | "refused";

/** Tom visual. `neutral` no arranque: nada de vermelho nem de verde prematuros. */
export type LoadingTone = "neutral" | "ok" | "warn";

export interface LoadingInput {
  /** true enquanto o arranque (BootScreen) ainda não fechou. */
  booting: boolean;
  /** null = ainda sem leitura; false = o serviço confirmou a queda; true = ligado. */
  serviceConnected: boolean | null;
  /** Última leitura de proteção CONFIRMADA, ou null se ainda não houve nenhuma. */
  protection: ProtectionState | null;
  /** Erro de sincronização já traduzido para o utilizador (nunca um segredo). */
  syncError?: string;
  /**
   * Quantas leituras o serviço RECUSOU por política desta sessão (gate de
   * fixture). É uma contagem medida pelo ciclo de sync — nunca um palpite — e só
   * produz estado quando não há falha real nem leitura confirmada.
   */
  syncRecusas?: number;
  /** Tempo decorrido desde o início do arranque/pedido, em ms. */
  elapsedMs?: number;
  /** Teto do arranque. Acima disto, o estado ganha o motivo `timeout`. */
  timeoutMs?: number;
}

export interface LoadingState {
  state: LoadingStateName;
  /** Frase curta PT-PT para o ecrã. */
  text: string;
  /** Uma frase que explica o motivo. Nunca inclui segredos nem percentagens. */
  detail: string;
  /** true se faz sentido mostrar um indicador de atividade. */
  busy: boolean;
  /** true se existe uma ação de repetição SUPORTADA (não só desejável). */
  canRetry: boolean;
  tone: LoadingTone;
  reason: LoadingReason;
}

/** Teto do arranque, alinhado com o timer do App.tsx (20 s). */
export const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;

/**
 * Copy ÚNICA do arranque. O BootScreen lia uma string solta; passa a ler daqui
 * para não haver duas versões da mesma frase.
 */
export const BOOT_BODY_COPY = "A preparar o seu centro de segurança...";

export const LOADING_COPY = {
  initializing: "A preparar o motor...",
  initializingDetail: "A obter o estado da proteção e do sistema.",
  stillInitializing: "Ainda a preparar o motor...",
  stillInitializingDetail:
    "Está a demorar mais do que o habitual. O arranque continua; se não concluir, verifica se o serviço de fundo está a correr.",
  unavailable: "Serviço de proteção indisponível.",
  unavailableDetail:
    "Não há comunicação com o serviço de fundo. A aplicação volta a ligar-se sozinha quando ele estiver disponível.",
  unavailableDetailEngineStopped:
    "O serviço respondeu, mas reporta que o motor não está em execução.",
  ready: "Proteção disponível.",
  readyDetail: "O serviço respondeu e não há componentes em falta.",
  degraded: "Proteção disponível, com componentes limitados.",
  errorSubsystem: "Um componente da proteção reporta um erro.",
  errorSync: "Não foi possível sincronizar com o serviço.",
  refused: "Rotinas fora do âmbito desta sessão.",
  refusedDetail:
    "O serviço está ligado e respondeu — foram recusas por política desta sessão de teste, " +
    "não uma avaria de comunicação. Sem leitura confirmada nada é afirmado sobre a proteção, " +
    "e repetir a sincronização não altera o âmbito da sessão.",
} as const;

/** Rótulos PT-PT, iguais aos usados nos detalhes da proteção. */
const CORE_SUBSYSTEMS: { key: keyof EngineHealth; label: string }[] = [
  { key: "yara", label: "YARA" },
  { key: "hashDb", label: "Hash DB" },
  { key: "clamav", label: "ClamAV" },
  { key: "nativeEngine", label: "Motor nativo" },
];

const WFP_LABEL = "Filtro WFP (CyberSafe)";

function subsystemEntries(
  engine: EngineHealth | undefined,
): { label: string; status: EngineSubsystemStatus }[] {
  const entries: { label: string; status: EngineSubsystemStatus }[] = [];
  for (const { key, label } of CORE_SUBSYSTEMS) {
    const sub = engine?.[key] as EngineSubsystemHealth | undefined;
    if (sub) entries.push({ label, status: sub.status });
  }
  const wfp = wfpHealth(engine);
  if (wfp) entries.push({ label: WFP_LABEL, status: wfp.status });
  return entries;
}

function describeSubsystems(
  engine: EngineHealth | undefined,
  statuses: EngineSubsystemStatus[],
): string[] {
  return subsystemEntries(engine)
    .filter((entry) => statuses.includes(entry.status))
    .map((entry) => {
      const palavra =
        entry.status === "degraded" ? "degradado"
          : entry.status === "error" ? "em erro"
            : "indisponível";
      return `${entry.label} (${palavra})`;
    });
}

/**
 * Deriva o estado de carregamento a partir dos factos do runtime. A ordem das
 * verificações é a ordem de honestidade: uma indisponibilidade confirmada nunca
 * pode ser rebaixada a «a carregar».
 */
export function deriveLoadingState(input: LoadingInput): LoadingState {
  const timeoutMs = input.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const elapsedMs = input.elapsedMs ?? 0;

  // 1. O serviço confirmou que caiu. É um facto, não uma espera. A reconexão é
  //    automática (subscrição de estado), por isso não se promete um botão.
  if (input.serviceConnected === false) {
    return {
      state: "UNAVAILABLE",
      reason: "unavailable",
      busy: false,
      canRetry: false,
      tone: "warn",
      text: LOADING_COPY.unavailable,
      detail: LOADING_COPY.unavailableDetail,
    };
  }

  // 2. Há uma leitura de proteção confirmada. A partir daqui NUNCA é
  //    INITIALIZING: ou está tudo bem (READY), ou há componentes limitados
  //    (DEGRADED) ou em erro (ERROR). É aqui que se cumpre a regra de não
  //    mascarar YARA degradado nem WFP indisponível como «a carregar».
  const protection = input.protection;
  if (protection) {
    const engine = protection.engine;

    if (engine && engine.serviceRunning === false) {
      return {
        state: "UNAVAILABLE",
        reason: "unavailable",
        busy: false,
        canRetry: false,
        tone: "warn",
        text: LOADING_COPY.unavailable,
        detail: LOADING_COPY.unavailableDetailEngineStopped,
      };
    }

    const emErro = describeSubsystems(engine, ["error"]);
    if (emErro.length > 0) {
      return {
        state: "ERROR",
        reason: "error",
        busy: false,
        canRetry: true,
        tone: "warn",
        text: LOADING_COPY.errorSubsystem,
        detail: `Confirmado pelo serviço: ${emErro.join(", ")}. Isto é um estado confirmado, não uma espera.`,
      };
    }

    const limitados = describeSubsystems(engine, ["degraded", "unavailable"]);
    if (limitados.length > 0) {
      return {
        state: "DEGRADED",
        reason: "degraded",
        busy: false,
        canRetry: false,
        tone: "warn",
        text: LOADING_COPY.degraded,
        detail: `Confirmado pelo serviço: ${limitados.join(", ")}.`,
      };
    }

    return {
      state: "READY",
      reason: "waiting",
      busy: false,
      canRetry: false,
      tone: "ok",
      text: LOADING_COPY.ready,
      detail: LOADING_COPY.readyDetail,
    };
  }

  // 3. Sem leitura, mas houve um erro de sincronização com o serviço ligado.
  //    A repetição é suportada (nova leitura), por isso `canRetry`.
  const syncError = typeof input.syncError === "string" ? input.syncError.trim() : "";
  if (syncError) {
    return {
      state: "ERROR",
      reason: "error",
      busy: false,
      canRetry: true,
      tone: "warn",
      text: LOADING_COPY.errorSync,
      detail: `${syncError} Podes repetir a sincronização.`,
    };
  }

  // 3.5 O serviço respondeu com recusas deliberadas e não há leitura nenhuma.
  //     Depois do erro real (regra 3) para que uma avaria nunca se esconda
  //     detrás de uma recusa, e antes da inicialização (regra 4) para que a
  //     recusa não virasse um spinner sem fim.
  const recusas = typeof input.syncRecusas === "number" && Number.isFinite(input.syncRecusas)
    ? Math.max(0, Math.floor(input.syncRecusas))
    : 0;
  if (recusas > 0) {
    return {
      state: "REFUSED",
      reason: "refused",
      busy: false,
      canRetry: false,
      tone: "neutral",
      text: LOADING_COPY.refused,
      detail: `${recusas} ${recusas === 1 ? "leitura recusou" : "leituras recusaram"} por política desta sessão. ${LOADING_COPY.refusedDetail}`,
    };
  }

  // 4. Sem leitura e sem erro: inicialização. Este é o único estado em que se
  //    mostra um indicador de atividade. Nada de vermelho, nada de verde, nada
  //    de percentagens.
  if (elapsedMs >= timeoutMs) {
    return {
      state: "INITIALIZING",
      reason: "timeout",
      busy: true,
      canRetry: false,
      tone: "neutral",
      text: LOADING_COPY.stillInitializing,
      detail: LOADING_COPY.stillInitializingDetail,
    };
  }

  return {
    state: "INITIALIZING",
    reason: "waiting",
    busy: true,
    canRetry: false,
    tone: "neutral",
    text: LOADING_COPY.initializing,
    detail: LOADING_COPY.initializingDetail,
  };
}
