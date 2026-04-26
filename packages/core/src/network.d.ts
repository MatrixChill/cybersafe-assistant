import type { ConnectionSnapshot, Severity } from "@cybersafe/shared-types";
export interface DomainReputation {
    severity: Severity;
    reasons: string[];
}
export declare function evaluateDomain(domain: string): DomainReputation;
export declare function summarizeConnections(connections: ConnectionSnapshot[]): ConnectionSnapshot[];
