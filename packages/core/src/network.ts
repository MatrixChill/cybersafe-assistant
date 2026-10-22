import type { ConnectionSnapshot, Severity } from "@cybersafe/shared-types";
import { analyzeUrlRisk } from "@cybersafe/shared-types";

export interface DomainReputation {
  severity: Severity;
  reasons: string[];
}

export function evaluateDomain(domain: string): DomainReputation {
  const analysis = analyzeUrlRisk(`https://${domain}`);
  return {
    severity: analysis.severity,
    reasons: analysis.rulesTriggered,
  };
}

export function summarizeConnections(connections: ConnectionSnapshot[]): ConnectionSnapshot[] {
  return connections.slice().sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}
