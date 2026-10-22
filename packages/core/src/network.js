import { analyzeUrlRisk } from "@cybersafe/shared-types";
export function evaluateDomain(domain) {
    const analysis = analyzeUrlRisk(`https://${domain}`);
    return {
        severity: analysis.severity,
        reasons: analysis.rulesTriggered,
    };
}
export function summarizeConnections(connections) {
    return connections.slice().sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}
