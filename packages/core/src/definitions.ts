import type { ProtectionStatus, TrustDecision } from "@cybersafe/shared-types";

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

export const PIPE_NAME = "\\\\.\\pipe\\cybersafe-protection-v1";

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

export function trustReduction(decision: TrustDecision): number {
  if (decision === "trusted") return -20;
  if (decision === "untrusted") return 15;
  return 0;
}
