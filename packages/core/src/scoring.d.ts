import type { AnalysisVerdict, HeuristicRuleId, ThreatAction, ThreatFactor, TrustDecision } from "@cybersafe/shared-types";
import { scoreToStatus } from "./definitions.js";
export interface ScoringInput {
    signatureMatch: boolean;
    yaraMatches: number;
    rulesTriggered: HeuristicRuleId[];
    trustDecision: TrustDecision;
}
export interface ScoreResult {
    riskScore: number;
    verdict: AnalysisVerdict;
    severity: "low" | "medium" | "high" | "critical";
    recommendedAction: ThreatAction;
    factors: ThreatFactor[];
}
export declare function scoreThreat(input: ScoringInput): ScoreResult;
export { scoreToStatus };
