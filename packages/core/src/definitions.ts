import type {
  EngineHealth,
  ProtectionStatus,
  TrustDecision,
} from "@cybersafe/shared-types";

export interface RiskThresholds {
  safeMax: number;
  monitorMax: number;
  alertMax: number;
}

export interface ProtectionSettings {
  thresholds: RiskThresholds;
  autoQuarantine: boolean;
  autoKillTree: boolean;
  restrictedAnalysis: boolean;
  scanTimeoutMs: number;
}

export const PIPE_NAME = "\\\\.\\pipe\\cybersafe-protection-dev-v2";

export const DEFAULT_THRESHOLDS: RiskThresholds = {
  safeMax: 40,
  monitorMax: 70,
  alertMax: 90,
};

export const DEFAULT_SETTINGS: ProtectionSettings = {
  thresholds: DEFAULT_THRESHOLDS,
  autoQuarantine: true,
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
  const subEngines = [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, engine.firewall];
  return subEngines.some((e) => e && e.status !== "active");
}

export function activeEngineCount(engine?: EngineHealth): number {
  if (!engine) return 0;
  const subEngines = [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, engine.firewall];
  return subEngines.filter((e): boolean => e?.status === "active").length;
}

export function trustReduction(decision: TrustDecision): number {
  if (decision === "trusted") return -20;
  if (decision === "untrusted") return 15;
  return 0;
}
