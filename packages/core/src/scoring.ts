import type {
  AnalysisVerdict,
  EngineHealth,
  HeuristicRuleId,
  PcStateLevel,
  ProtectionStatus,
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
  high_entropy: 5, // Reduzido drasticamente (era 20)
  process_injection_indicator: 30,
  suspicious_location: 15,
  persistence_attempt: 30,
  known_bad_hash: 95,
  // Canário dev-only: banda "medium" (41–70) — gera deteção/teste real sem
  // quarentena nem bloqueio; nunca em NODE_ENV=production.
  dev_canary_signature: 55,
  yara_match: 85,
  known_malware: 95,
  allowlisted_hash: -60,
  trusted_publisher: -30, // Aumentado (era -20)
  trusted_system_path: -25, // Aumentado (era -15)
  unsigned_binary: 10, // Reduzido (era 15)
  office_child_process: 20,
  script_spawns_binary: 20,
  rapid_process_fanout: 20,
  blocked_reexecution: 95,
};

/**
 * Evidência FORTE: identifica o binário. Só isto, ou uma combinação
 * deliberadamente reforçada de heurísticas, pode chamar "malware" a algo.
 *
 * Tudo o resto — estar numa pasta Temperada, ter entropia alta, ser um arquivo
 * que contém um .exe, não ter signer — é SINAL HEURÍSTICO. Um VSIX legítimo
 * do Visual Studio podia reunir três deles e era anunciado como ameaça.
 */
const STRONG_RULES = new Set<HeuristicRuleId>([
  "known_bad_hash",
  "yara_match",
  "known_malware",
  "blocked_reexecution",
]);

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
  /** Soma só das heurísticas (sem evidência forte, sem confiança negativa). */
  let heuristicScore = 0;

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
    if (!STRONG_RULES.has(rule) && weight > 0) heuristicScore += weight;
    factors.push({
      id: rule,
      label: rule.replaceAll("_", " "),
      weight,
      category: weight < 0 ? "trust" : STRONG_RULES.has(rule) ? "signature" : "heuristic",
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
  const recommendedAction = actionFromScore(score);

  // ── A DECISÃO ────────────────────────────────────────────────────────────
  // O score sozinho nunca diz "isto é malware": uma soma de sinais fracos
  // alcanca 50 só porque o ficheiro está em \Temp\, tem entropia alta e é um
  // ZIP com um .exe lá dentro — e isso descreve metade do software instalado
  // neste pc. O que separa uma deteção de um palpite é a EVIDÊNCIA.
  //
  //  · evidência forte (hash DB, YARA-X, ClamAV, reexecução bloqueada) decide
  //    pelo score, como sempre;
  //  · sem evidência forte, as heurísticas só promovem a "suspicious" quando
  //    estão REFORÇADAS entre si (atingem monitorMax) — aí é finding de
  //    atenção, não malware;
  //  · heurísticas isoladas ou fracas ficam "safe" e "low": continuam listadas
  //    como FINDING (fatores + ação recommended/logged), mas o serviço deixa de
  //    as anunciar como "Threat detected", porque isso exige severity != low.
  const hasStrongEvidence =
    input.signatureMatch || input.yaraMatches > 0 || input.rulesTriggered.some((r) => STRONG_RULES.has(r));

  let verdict: AnalysisVerdict;
  let severity: ScoreResult["severity"];
  if (hasStrongEvidence) {
    verdict = score > DEFAULT_SETTINGS.thresholds.alertMax ? "malicious" : "suspicious";
    severity = severityFromScore(score);
  } else if (heuristicScore >= DEFAULT_SETTINGS.thresholds.monitorMax) {
    verdict = "suspicious";
    severity = "medium";
  } else {
    verdict = "safe";
    severity = "low";
  }

  return { riskScore: score, verdict, severity, recommendedAction, factors };
}

export { scoreToStatus };

// ─────────────────────────────────────────────────────────────────────────────
// Relatório interno — fontes centrais, ZERO score paralelo
// ─────────────────────────────────────────────────────────────────────────────
// O relatório NÃO pode ter opinião própria. Tudo o que ele afirma tem de vir
// de uma fonte central já existente:
//   • ProtectionState.status + ProtectionState.engine  (telemetria do serviço)
//   • ProtectionState.stats.riskScore                 (o único score mostrado)
//   • PcState.overall / PcState.security|performance|… (PC Center)
//   • findings / ameaças / quarentena / eventos já carregados pela app
//
// Invariantes de honestidade garantidos aqui:
//   1. "protected" (Seguro/Protegido) exige fontes REAIS. Sem fontes ⇒ unknown.
//   2. "degraded" nunca é colapsado em "safe"/"protected".
//   3. Dados ausentes são `null`/indisponíveis — NUNCA 0 (0 seria "saudável").

export type ReportVerdict = "protected" | "attention" | "degraded" | "critical" | "unknown";
export type ReportTone = "green" | "amber" | "red" | "unknown";

/** Subconjunto das fontes centrais que o relatório pode consumir. */
export interface ReportCentralSources {
  /** ProtectionState.status — a verdade do serviço. */
  protectionStatus?: ProtectionStatus | null;
  /** ProtectionState.engine — telemetria real dos subsistemas. */
  engine?: EngineHealth | null;
  /** PcState.overall — estado consolidado do PC Center. */
  pcStateOverall?: PcStateLevel | null;
  /** ProtectionState.stats.riskScore — o ÚNICO score apresentado. */
  riskScore?: number | null;
}

export interface ReportHealth {
  verdict: ReportVerdict;
  tone: ReportTone;
  /** true apenas com fontes reais disponíveis; sem fontes é sempre false. */
  canClaimProtected: boolean;
  /** Score real do serviço, ou null = indisponível (nunca 0 por omissão). */
  score: number | null;
  /** Houve pelo menos uma fonte central? Se não, tudo é "desconhecido". */
  dataAvailable: boolean;
  /** Texto curto de diagnóstico, derivado da fonte (sem opinião). */
  reason: string;
}

const VERDICT_RANK: Record<ReportVerdict, number> = {
  unknown: 0,
  protected: 1,
  attention: 2,
  degraded: 3,
  critical: 4,
};

const TONE_BY_VERDICT: Record<ReportVerdict, ReportTone> = {
  protected: "green",
  attention: "amber",
  degraded: "amber",
  critical: "red",
  unknown: "unknown",
};

/** Pior-veredicto-ganha: nunca deixamos um "attention"ser engolido por "protected". */
function worst(a: ReportVerdict, b: ReportVerdict): ReportVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/**
 * Nível de proteção derivado da telemetria do serviço. Espelha as regras
 * centrais já aplicadas no backend e no painel (status + AnyEngineDegraded +
 * subsistemas em ERROR + serviço parado) e trata "degraded" como degradado.
 */
function protectionVerdict(
  status: ProtectionStatus | null | undefined,
  engine: EngineHealth | null | undefined,
): ReportVerdict {
  if (engine && engine.serviceRunning === false) return "critical";
  if (
    engine &&
    [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, engine.firewall]
      .some((sub) => sub && sub.status === "error")
  ) {
    return "critical";
  }
  const unhealthy = engine?.anyEngineDegraded === true;

  switch (status) {
    case "critical":
      return "critical";
    case "attention":
      return unhealthy ? "degraded" : "attention";
    case "safe":
      return unhealthy ? "degraded" : "protected";
    case "degraded":
      // Uma base degradada é degradada — nunca "safe" só porque não houve deteção.
      return "degraded";
    default:
      return "unknown";
  }
}

function pcStateVerdict(level: PcStateLevel | null | undefined): ReportVerdict {
  switch (level) {
    case "good":
      return "protected";
    case "attention":
      return "attention";
    case "critical":
      return "critical";
    default:
      // "unknown" e ausente = sem opinião, NÃO é saudável.
      return "unknown";
  }
}

/** Score real do serviço; qualquer valor ausente/inválido ⇒ null (indisponível). */
function realRiskScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Consolida as fontes centrais num único veredicto honesto para o relatório.
 * NÃO calcula score: devolve exatamente o riskScore do serviço (ou null).
 */
export function reportHealthFromCentralSources(sources: ReportCentralSources): ReportHealth {
  const protection = protectionVerdict(sources.protectionStatus, sources.engine);
  const pcState = pcStateVerdict(sources.pcStateOverall);
  const dataAvailable = protection !== "unknown" || pcState !== "unknown";
  let verdict: ReportVerdict = dataAvailable ? worst(protection, pcState) : "unknown";
  // Sem ProtectionState (status + telemetria) NÃO se pode afirmar que a
  // proteção está ativa: um PcState "good" só diz que o PC Center não tem
  // queixas. "Bom" sem estado de proteção = desconhecido, nunca "Protegido".
  if (protection === "unknown" && (pcState === "protected" || pcState === "unknown")) {
    verdict = "unknown";
  }
  const score = realRiskScore(sources.riskScore);

  const reasons: string[] = [];
  if (protection === "unknown" && pcState === "unknown") {
    reasons.push("sem estado de proteção nem PcState disponíveis");
  } else {
    if (protection !== "unknown") reasons.push(`proteção: ${protection}`);
    if (pcState !== "unknown") reasons.push(`PC: ${pcState}`);
    if (protection === "unknown") reasons.push("estado de proteção indisponível");
  }
  if (score === null) reasons.push("riskScore indisponível");

  return {
    verdict,
    tone: TONE_BY_VERDICT[verdict],
    // Sem fontes reais nunca se pode afirmar "Protegido".
    canClaimProtected: verdict === "protected" && dataAvailable,
    score,
    dataAvailable,
    reason: reasons.join(" · "),
  };
}

export interface ReportCategory {
  key: "security" | "performance" | "system" | "privacy";
  label: string;
  verdict: ReportVerdict;
  tone: ReportTone;
  available: boolean;
}

const PC_STATE_CATEGORY_LABELS: Record<ReportCategory["key"], string> = {
  security: "Segurança",
  performance: "Desempenho",
  system: "Sistema",
  privacy: "Privacidade",
};

/**
 * Linhas da secção "Categorias" do relatório — derivadas do PcState.
 * Sem PcState cada linha é `available: false` (indisponível), nunca "Ok".
 */
export function reportCategoriesFromPcState(
  pcState: Partial<Record<ReportCategory["key"], PcStateLevel>> | null | undefined,
): ReportCategory[] {
  return (Object.keys(PC_STATE_CATEGORY_LABELS) as ReportCategory["key"][]).map((key) => {
    const level = pcState ? pcState[key] : undefined;
    const available = level === "good" || level === "attention" || level === "critical";
    const verdict = available ? pcStateVerdict(level) : "unknown";
    return {
      key,
      label: PC_STATE_CATEGORY_LABELS[key],
      verdict,
      tone: available ? TONE_BY_VERDICT[verdict] : "unknown",
      available,
    };
  });
}
