import type { HardwareSnapshot, PcState, ProtectionState } from "@cybersafe/shared-types";
import { LOADING_COPY, type LoadingStateName } from "./loadingStates";

/**
 * ── PRONTIDÃO DO ARRANQUE ────────────────────────────────────────────────────
 *
 * `lib/loadingStates` responde «que estado é este?». Este módulo responde a uma
 * pergunta diferente e mais estreita: **a moldura pode abrir, e com que facto?**
 *
 * Regras (todas testáveis sem renderer):
 *   · READY exige serviço confirmado E as três leituras obrigatórias recebidas
 *     (proteção, estado do computador, hardware). Um snapshot recebido NÃO é
 *     prova de que todos os sensores opcionais existam nem de que a proteção
 *     esteja ativa — por isso o modelo nunca afirma «proteção ativa».
 *   · O TEMPO nunca produz prontidão. Esgotado o orçamento de apresentação sem
 *     confirmação, o estado é UNKNOWN: sem spinner, sem verde, sem abrir a
 *     moldura sozinho. A entrada em modo limitado é um clique explícito.
 *   · Um facto já confirmado pelo serviço (queda, erro real, recusa) abre a
 *     moldura — é lá que o aviso honesto vive — e nunca espera pelo relógio.
 *   · Proteção desligada não impede a moldura de abrir; também não a torna
 *     «protegida». O estado real fica no painel.
 *
 * Este ficheiro é PURO: não lê relógio, não chama IPC, não guarda estado.
 */

export type BootReadinessName =
  | "INITIALIZING"
  | "READY"
  /** Orçamento de apresentação esgotado sem confirmação. Nunca é prontidão. */
  | "UNKNOWN"
  | "UNAVAILABLE"
  | "ERROR"
  /** O serviço respondeu e recusou rotinas por política (gate de fixture). */
  | "RESTRICTED";

export type BootTone = "neutral" | "ok" | "warn";

/** Que leituras obrigatórias já chegaram. Facto medido, não expectativa. */
export interface BootConfirmed {
  service: boolean;
  protection: boolean;
  pcState: boolean;
  hardware: boolean;
}

export interface BootReadinessInput {
  /** null = ainda sem leitura; false = o serviço confirmou a queda. */
  serviceConnected: boolean | null;
  protection: ProtectionState | null;
  pcState: PcState | null;
  hardware: HardwareSnapshot | null;
  /** Estado já derivado por `deriveLoadingState` — a honestidade não se repete. */
  loadingState: LoadingStateName;
  /** Erro de sincronização já traduzido (nunca um segredo). */
  syncError?: string;
  /** Leituras recusadas por política na última sincronização. */
  syncRecusas?: number;
  /** true quando o orçamento de apresentação esgotou (relógio do App). */
  pastDeadline?: boolean;
}

export interface BootReadiness {
  state: BootReadinessName;
  /** A moldura pode ser desenhada por um facto confirmado. */
  opensShell: boolean;
  /** Só READY afirma prontidão. Nenhum outro estado o faz. */
  claimsReady: boolean;
  /** Indicador de actividade APENAS enquanto se espera sem facto que a desminta. */
  busy: boolean;
  tone: BootTone;
  text: string;
  detail: string;
  /** Limitação que tem de ficar visível na moldura. null = nenhuma. */
  limitation: string | null;
  confirmed: BootConfirmed;
  /** Só UNKNOWN: abrir a moldura é um clique explícito, não um efeito do tempo. */
  canEnterLimited: boolean;
}

export const BOOT_COPY = {
  /** Entrada em modo limitado: fica dito o que NÃO está confirmado. */
  limitedEntry: "Continuar para o painel",
  limitedEntryDetail: "Sem confirmação do serviço. O painel abre em modo limitado.",
  limitedBannerTitle: "Modo limitado — arranque sem confirmação",
  limitedBannerDetail:
    "Continuaste sem confirmação do serviço de proteção. Os dados podem estar incompletos e nada aqui afirma que a proteção esteja a funcionar.",
  ready: "Arranque concluído.",
  readyDetail: "O serviço respondeu e as leituras necessárias chegaram.",
  protectionOff: "A proteção está desligada — o arranque não a ativa; o estado real está no painel.",
  degraded: "O serviço respondeu com componentes limitados; o detalhe está no painel.",
  unknown: "Prontidão ainda não confirmada.",
  unknownDetail:
    "O tempo de espera terminou sem confirmar as leituras necessárias. Não há garantia de que a proteção esteja a funcionar; podes continuar em modo limitado, com esta limitação visível.",
  unknownPending: "Por confirmar",
  unknownLimitation: "Modo limitado — prontidão não confirmada. Nada aqui afirma que a proteção esteja a funcionar.",
  unavailableLimitation: "Sem serviço confirmado, nenhum estado de proteção é afirmado.",
  errorLimitation: "Houve uma falha real de sincronização: o que está no painel pode estar incompleto.",
  refusedLimitation: "As rotinas desta sessão foram recusadas por política; nada é afirmado sobre a proteção.",
} as const;

/** Nome legível de cada leitura obrigatória em falta — o ecrã diz QUAL falta. */
const READING_LABELS: Record<keyof BootConfirmed, string> = {
  service: "ligação ao serviço",
  protection: "estado da proteção",
  pcState: "estado do computador",
  hardware: "sensores",
};

function pendingReadings(confirmed: BootConfirmed): string {
  const nomes = (Object.keys(READING_LABELS) as (keyof BootConfirmed)[])
    .filter((chave) => !confirmed[chave])
    .map((chave) => READING_LABELS[chave]);
  return nomes.length === 0 ? "nenhuma leitura em falta" : nomes.join(", ");
}

export function deriveBootReadiness(input: BootReadinessInput): BootReadiness {
  const confirmed: BootConfirmed = {
    service: input.serviceConnected === true,
    protection: input.protection !== null,
    pcState: input.pcState !== null,
    hardware: input.hardware !== null,
  };
  const recusas =
    typeof input.syncRecusas === "number" && Number.isFinite(input.syncRecusas)
      ? Math.max(0, Math.floor(input.syncRecusas))
      : 0;
  /** Leitura completa = as três leituras obrigatórias + serviço confirmado. */
  const completo = confirmed.service && confirmed.protection && confirmed.pcState && confirmed.hardware;
  /**
   * Erro de sincronização NORMALIZADO aqui, não herdado só do estado vizinho.
   * `deriveLoadingState` devolve READY/DEGRADED quando a proteção existe — o
   * `syncError` só é consultado no ramo sem leitura. Consequência real: com os
   * snapshots completos e um erro pendente, o estado vizinho diria READY. A
   * prontidão do arranque não pode herdar essa cegueira: erro pendente não é
   * pronto, seja qual for o `loadingState` que chega.
   */
  const erroSync = typeof input.syncError === "string" ? input.syncError.trim() : "";

  // 1. Queda confirmada, ou motor parado segundo o serviço. É um facto: abrir a
  //    moldura mostra o aviso real e não deixa um spinner a fingir trabalho.
  if (input.loadingState === "UNAVAILABLE") {
    return {
      state: "UNAVAILABLE",
      opensShell: true,
      claimsReady: false,
      busy: false,
      tone: "warn",
      text: LOADING_COPY.unavailable,
      detail: confirmed.protection
        ? LOADING_COPY.unavailableDetailEngineStopped
        : LOADING_COPY.unavailableDetail,
      limitation: BOOT_COPY.unavailableLimitation,
      confirmed,
      canEnterLimited: false,
    };
  }

  // 2. Falha real de sincronização PENDENTE, mesmo que o estado vizinho já
  //    tenha proteção e diga READY/DEGRADED. Isto vem depois da queda (regra 1)
  //    — uma queda confirmada domina — e antes de qualquer prontidão.
  if (erroSync) {
    return {
      state: "ERROR",
      opensShell: true,
      claimsReady: false,
      busy: false,
      tone: "warn",
      text: LOADING_COPY.errorSync,
      detail: `${erroSync} O painel abre com o aviso visível.`,
      limitation: BOOT_COPY.errorLimitation,
      confirmed,
      canEnterLimited: false,
    };
  }

  // 3. Falha real de sincronização já classificada pelo estado vizinho (ex.:
  //    subsistema em erro, sem `syncError` de sync). A repetição já existe no
  //    painel; aqui não se inventa um botão novo nem se fica a girar.
  if (input.loadingState === "ERROR") {
    return {
      state: "ERROR",
      opensShell: true,
      claimsReady: false,
      busy: false,
      tone: "warn",
      text: LOADING_COPY.errorSync,
      detail: LOADING_COPY.errorSync,
      limitation: BOOT_COPY.errorLimitation,
      confirmed,
      canEnterLimited: false,
    };
  }

  // 4. Recusa por política. O serviço respondeu: não é espera nem avaria. Sem a
  //    leitura completa também não é prontidão — mas a moldura abre, porque o
  //    aviso da recusa vive lá e ficar a girar seria falso trabalho.
  if (input.loadingState === "REFUSED" || (recusas > 0 && !completo)) {
    return {
      state: "RESTRICTED",
      opensShell: true,
      claimsReady: false,
      busy: false,
      tone: "neutral",
      text: LOADING_COPY.refused,
      detail: `${recusas === 1 ? "1 leitura recusou" : `${recusas} leituras recusaram`} por política desta sessão. ${LOADING_COPY.refusedDetail}`,
      limitation: BOOT_COPY.refusedLimitation,
      confirmed,
      canEnterLimited: false,
    };
  }

  // 5. Todas as leituras obrigatórias chegaram, sem erro pendente. Único
  //    caminho para READY — e nenhum relógio participa nesta decisão.
  if (completo) {
    const limitation =
      input.protection?.protectionEnabled === false
        ? BOOT_COPY.protectionOff
        : input.loadingState === "DEGRADED"
          ? BOOT_COPY.degraded
          : null;
    return {
      state: "READY",
      opensShell: true,
      claimsReady: true,
      busy: false,
      tone: "ok",
      text: BOOT_COPY.ready,
      detail: BOOT_COPY.readyDetail,
      limitation,
      confirmed,
      canEnterLimited: false,
    };
  }

  // 6. Orçamento esgotado SEM confirmação. O tempo não promove nada a READY:
  //    passa a UNKNOWN, sem spinner e sem abrir a moldura sozinho. A copy diz
  //    o que falta em concreto — se só faltam sensores, não se afirma que a
  //    ligação ao serviço está ausente.
  if (input.pastDeadline === true) {
    const emFalta = pendingReadings(confirmed);
    return {
      state: "UNKNOWN",
      opensShell: false,
      claimsReady: false,
      busy: false,
      tone: "neutral",
      text: BOOT_COPY.unknown,
      detail: `${BOOT_COPY.unknownDetail} ${BOOT_COPY.unknownPending}: ${emFalta}.`,
      limitation: `${BOOT_COPY.unknownLimitation} ${BOOT_COPY.unknownPending}: ${emFalta}.`,
      confirmed,
      canEnterLimited: true,
    };
  }

  // 6. À espera, dentro do orçamento e sem facto que desminta a espera.
  return {
    state: "INITIALIZING",
    opensShell: false,
    claimsReady: false,
    busy: true,
    tone: "neutral",
    text: LOADING_COPY.initializing,
    detail: LOADING_COPY.initializingDetail,
    limitation: null,
    confirmed,
    canEnterLimited: false,
  };
}
