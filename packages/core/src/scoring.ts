import type {
  AnalysisVerdict,
  HeuristicRuleId,
  ThreatAction,
  ThreatFactor,
  TrustDecision,
} from "@cybersafe/shared-types";
import { DEFAULT_SETTINGS, scoreToStatus, trustReduction } from "./definitions.js";

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

const RULE_WEIGHTS: Partial<Record<HeuristicRuleId, number>> = {
  dangerous_file_extension: 15,
  social_engineering_filename_pattern: 20,
  suspicious_download_type: 20,
  double_extension: 25,
  executable_signature: 25,
  archive_with_exe: 30,
  magic_number_mismatch: 30,
  high_entropy: 20,
  process_injection_indicator: 30,
  suspicious_location: 15,
  persistence_attempt: 30,
  known_bad_hash: 95,
  yara_match: 85,
  allowlisted_hash: -60,
  trusted_publisher: -20,
  trusted_system_path: -15,
  unsigned_binary: 15,
  office_child_process: 20,
  script_spawns_binary: 20,
  rapid_process_fanout: 20,
  blocked_reexecution: 95,
};

function severityFromScore(score: number): "low" | "medium" | "high" | "critical" {
  if (score > DEFAULT_SETTINGS.thresholds.alertMax) return "critical";
  if (score > DEFAULT_SETTINGS.thresholds.monitorMax) return "high";
  if (score > DEFAULT_SETTINGS.thresholds.safeMax) return "medium";
  return "low";
}

function actionFromScore(score: number): ThreatAction {
  if (score > DEFAULT_SETTINGS.thresholds.alertMax) return "quarantined";
  if (score > DEFAULT_SETTINGS.thresholds.monitorMax) return "alerted";
  if (score > DEFAULT_SETTINGS.thresholds.safeMax) return "logged";
  return "allowed";
}

export function scoreThreat(input: ScoringInput): ScoreResult {
  const factors: ThreatFactor[] = [];
  let score = 0;

  if (input.signatureMatch) {
    score += 95;
    factors.push({
      id: "known-bad-hash",
      label: "Known bad hash",
      weight: 95,
      category: "signature",
    });
  }

  if (input.yaraMatches > 0) {
    const weight = Math.min(95, 75 + input.yaraMatches * 5);
    score += weight;
    factors.push({
      id: "yara-match",
      label: "YARA match",
      weight,
      category: "yara",
    });
  }

  for (const rule of input.rulesTriggered) {
    const weight = RULE_WEIGHTS[rule] ?? 10;
    score += weight;
    factors.push({
      id: rule,
      label: rule.replaceAll("_", " "),
      weight,
      category: weight < 0 ? "trust" : "heuristic",
    });
  }

  const trustWeight = trustReduction(input.trustDecision);
  if (trustWeight !== 0) {
    score += trustWeight;
    factors.push({
      id: "trust-decision",
      label: `Trust: ${input.trustDecision}`,
      weight: trustWeight,
      category: "trust",
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const severity = severityFromScore(score);
  const recommendedAction = actionFromScore(score);
  const verdict: AnalysisVerdict = score > DEFAULT_SETTINGS.thresholds.alertMax
    ? "malicious"
    : score > DEFAULT_SETTINGS.thresholds.safeMax
      ? "suspicious"
      : "safe";

  return { riskScore: score, verdict, severity, recommendedAction, factors };
}

export { scoreToStatus };
