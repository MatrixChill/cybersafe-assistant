import type { ProtectionStatus, TrustDecision } from "@cybersafe/shared-types";
export interface RiskThresholds {
    safeMax: number;
    monitorMax: number;
    alertMax: number;
}
export interface ProtectionSettings {
    thresholds: RiskThresholds;
    /**
     * @deprecated Sem consumers. Não ativar — quarentena por decisão explícita.
     * Removido de DEFAULT_SETTINGS; mantido opcional para compatibilidade.
     */
    autoQuarantine?: boolean;
    autoKillTree: boolean;
    restrictedAnalysis: boolean;
    scanTimeoutMs: number;
}
export declare const PIPE_NAME = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
export declare const DEFAULT_THRESHOLDS: RiskThresholds;
export declare const DEFAULT_SETTINGS: ProtectionSettings;
export declare function scoreToStatus(score: number, degraded?: boolean): ProtectionStatus;
export declare function trustReduction(decision: TrustDecision): number;
