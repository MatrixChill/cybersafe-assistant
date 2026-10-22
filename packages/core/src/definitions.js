export const PIPE_NAME = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
export const DEFAULT_THRESHOLDS = {
    safeMax: 40,
    monitorMax: 70,
    alertMax: 90,
};
export const DEFAULT_SETTINGS = {
    thresholds: DEFAULT_THRESHOLDS,
    autoKillTree: true,
    autoKillTree: true,
    restrictedAnalysis: true,
    scanTimeoutMs: 8_000,
};
export function scoreToStatus(score, degraded = false) {
    if (degraded)
        return "degraded";
    if (score > DEFAULT_THRESHOLDS.alertMax)
        return "critical";
    if (score > DEFAULT_THRESHOLDS.safeMax)
        return "attention";
    return "safe";
}
export function trustReduction(decision) {
    if (decision === "trusted")
        return -20;
    if (decision === "untrusted")
        return 15;
    return 0;
}
