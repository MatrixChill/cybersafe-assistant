import type {
  EngineHealth,
  ProtectionStatus,
  TrustDecision,
} from "@cybersafe/shared-types";
import { wfpHealth } from "@cybersafe/shared-types";
import { resolvePipeName } from "./dev-isolation.js";

export interface RiskThresholds {
  safeMax: number;
  monitorMax: number;
  alertMax: number;
}

export interface ProtectionSettings {
  thresholds: RiskThresholds;
/**
 * @deprecated Sem consumers desde P0. Não ativar — a quarentena é sempre
 * acionada por decisão explícita da UI/engine. Mantido por compatibilidade
 * de tipo; removido de DEFAULT_SETTINGS para garantir que nunca activa.
 */
autoQuarantine?: boolean;
  autoKillTree: boolean;
  restrictedAnalysis: boolean;
  scanTimeoutMs: number;
}

/**
 * Nome do named pipe de proteção. SEM o otim-in de desenvolvimento ligado, é
 * exatamente o literal histórico (`\\.\pipe\cybersafe-protection-dev-v2`).
 * Com `CYBERSAFE_DEV_ISOLATION=1` e config válida, aponta para um pipe local
 * isolado partilhado por desktop e serviço. Config parcial/inválida falha
 * FECHADO na resolução (antes de qualquer connect), nunca cai no pipe real.
 */
export const PIPE_NAME = resolvePipeName();

export const DEFAULT_THRESHOLDS: RiskThresholds = {
  safeMax: 40,
  monitorMax: 70,
  alertMax: 90,
};

export const DEFAULT_SETTINGS: ProtectionSettings = {
  thresholds: DEFAULT_THRESHOLDS,
  autoKillTree: true,
  restrictedAnalysis: true,
  scanTimeoutMs: 8_000,
};

export function scoreToStatus(score: number, degraded = false): ProtectionStatus {
  if (degraded) return "degraded";
  if (score > DEFAULT_THRESHOLDS.alertMax) return "critical";
  if (score > DEFAULT_THRESHOLDS.safeMax) return "attention";
  return "safe";
}

/**
 * Estado da proteção para o utilizador, a partir do facto on/off e do score.
 *
 * `scoreToStatus` sozinho responde a "como estão as ameaças?", não a "a
 * proteção está a correr?". Com zero ameaças dava "safe" mesmo com a proteção
 * desligada — Protected por ausência de notícias. Esta função fecha isso:
 * só `protectionEnabled === true` pode chegar a "safe".
 *
 * `protectionEnabled` tem de ser o facto lido do motor. `undefined`/`null`
 * significa "não lido" e NUNCA dá "safe": desconhecido não é protegido.
 *
 * Desligada é `critical`, não `degraded`: `degraded` é parte dos motores a
 * falhar, e a máquina ainda é parcialmente vigiada. Desligada é não vigiada.
 */
export function deriveProtectionStatus(
  protectionEnabled: boolean | null | undefined,
  riskScore: number,
  degraded = false,
): ProtectionStatus {
  if (protectionEnabled !== true) return "critical";
  return scoreToStatus(riskScore, degraded);
}

/**
 * Quando a proteção está degradada (motores indisponíveis), o risco efetivo
 * nunca desce abaixo de um piso que reflita a perda de confiança nas deteções.
 * Sem motores ativos, nunca mostramos "safe".
 */
export function effectiveRiskScore(maxRisk: number, engine?: EngineHealth): number {
  if (!engine) return maxRisk;
  const subEngines = [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine];
  const active = subEngines.filter(
    (e): e is NonNullable<typeof e> => e?.status === "active",
  ).length;
  const degraded = subEngines.some(
    (e) => e?.status === "degraded",
  );

  let floor = 0;
  if (active === 0) floor = 75;
  else if (active <= 2) floor = 45;
  else if (degraded) floor = 20;

  return Math.max(maxRisk, floor);
}

export function engineIsDegraded(engine?: EngineHealth): boolean {
  if (!engine) return false;
  // Rejeições de admissão e sinais indeterminados não provam quantos ficheiros
  // ficaram sem análise. Impedem, porém, confirmar cobertura completa.
  const loss = engine.realtimeLoss;
  if ((loss?.queueRejections ?? engine.realtimeDroppedEvents ?? 0) > 0
    || loss?.watcherCallbacksIndeterminate === true
    || (loss?.watcherSignals ?? 0) > 0) return true;
  const subEngines = [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, wfpHealth(engine)];
  return subEngines.some((e) => e && e.status !== "active");
}

export function activeEngineCount(engine?: EngineHealth): number {
  if (!engine) return 0;
  const subEngines = [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, wfpHealth(engine)];
  return subEngines.filter((e): boolean => e?.status === "active").length;
}

export function trustReduction(decision: TrustDecision): number {
  if (decision === "trusted") return -20;
  if (decision === "untrusted") return 15;
  return 0;
}
