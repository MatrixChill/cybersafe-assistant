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
import { wfpHealth } from "@cybersafe/shared-types";
import { DEFAULT_SETTINGS, scoreToStatus, trustReduction } from "./definitions.js";

export interface ScoringInput {
  signatureMatch: boolean;
  yaraMatches: number;
  /** Only rules explicitly classified as strong by the definition author. */
  strongYaraMatches?: number;
  signatureStatus?: AuthenticodeStatus;
  rulesTriggered: HeuristicRuleId[];
  trustDecision: TrustDecision;
}

/** invalid/tampered require cryptographic evidence, not a verification error. */
export type AuthenticodeStatus = "verified" | "trusted" | "unsigned" | "unavailable" | "UnknownError" | "invalid" | "tampered";

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
  high_entropy: 5, // Pode ocorrer em executáveis legítimos comprimidos/empacotados.
  process_injection_indicator: 30,
  suspicious_location: 15,
  persistence_attempt: 30,
  known_bad_hash: 95,
  // Canário dev-only: banda "medium" (41–70) — gera deteção/teste real sem
  // quarentena nem bloqueio; nunca em NODE_ENV=production.
  dev_canary_signature: 55,
  yara_match: 20,
  known_malware: 95,
  allowlisted_hash: -60,
  trusted_publisher: -30, // Aumentado (era -20)
  trusted_system_path: -25, // Aumentado (era -15)
  unsigned_binary: 0,
  office_child_process: 20,
  script_spawns_binary: 20,
  rapid_process_fanout: 20,
  blocked_reexecution: 95,
  // Peso ZERO de propósito, e é a decisão mais importante desta tabela.
  //
  // "Não conseguimos avaliar" não é evidência de perigo. Somar-lhe pontos
  // seria fabricar uma ameaça que não existe; subtrair-lhe seria fabricar uma
  // garantia que também não existe. O que faz é CONTINUAR VISÍVEL: a regra
  // entra em `rulesTriggered` e no `summary` que o utilizador lê, para que
  // "limpo" nunca seja uma palavra que o produto disse sem ter analisado.
  scan_inconclusive: 0,
};

/**
 * ROTULOS DOS FACTOS — PT-PT, e a unica coisa que este `id` faz no ecra.
 *
 * `factors[].label` nao e um campo interno: o servico junta os labels num
 * `summary` e publica-o no evento `artifact.analyzed`
 * (packages/service/src/engine.ts:1082), e esse summary chega ao toast e ao
 * relatorio. O label e a unica explicacao que o produto da de porque
 * classificou o ficheiro, e o utilizador le-o em portugues.
 *
 * Antes disto o rotulo era `rule.replaceAll("_", " ")` — a chave tecnica com
 * os underscores virados em espacos, em ingles. Nao e um detalhe de estilo: o
 * score e correcto, mas o utilizador lia "dangerous file extension" no meio de
 * uma frase portuguesa e nao sabia o que aquilo queria dizer.
 *
 * `id` e `weight` NAO mudam. O `id` e a chave de dados — varios testes e
 * consumidores filtram por ele (`f.id === "yara_match"`) — e mudar a copy nunca
 * justifica mudar a chave. O `label` e que e自由度 de traducao.
 *
 * O fallback nunca mostra a forma crua. Uma regra nova que nao entre aqui
 * mostra o identificador com os underscores virados em palavras, capitalizado:
 * legivel e honesto ("Regra desconhecida"), nunca "regra_desconhecida" nem uma
 * frase inventada. Um factor com nome mau e melhor do que um factor sem nome.
 * Guard: packages/core/test/factor-labels-ptpt.test.js.
 */
const RULE_LABELS: Partial<Record<HeuristicRuleId, string>> = {
  dangerous_file_extension: "Extensão de ficheiro perigosa",
  social_engineering_filename_pattern: "Nome de ficheiro com padrão de engenharia social",
  suspicious_download_type: "Tipo de transferências suspeito",
  double_extension: "Extensão dupla",
  executable_signature: "Assinatura de executável",
  archive_with_exe: "Ficheiro comprimido que contém um executável",
  magic_number_mismatch: "Cabeçalho do ficheiro não corresponde ao formato",
  high_entropy: "Conteúdo com entropia elevada",
  process_injection_indicator: "Indício de injeção de processos",
  suspicious_location: "Localização suspeita",
  persistence_attempt: "Tentativa de persistência",
  known_bad_hash: "Hash conhecido como malicioso",
  dev_canary_signature: "Assinatura de canário de teste",
  yara_match: "Correspondência de regra YARA",
  known_malware: "Malware conhecido",
  allowlisted_hash: "Hash na lista de permissões",
  trusted_publisher: "Editor de confiança",
  trusted_system_path: "Caminho de sistema confiável",
  unsigned_binary: "Executável sem assinatura",
  office_child_process: "Processo filho de uma aplicação do Office",
  script_spawns_binary: "Script que lança um executável",
  rapid_process_fanout: "Processos abertos em sequência rápida",
  blocked_reexecution: "Tentativa de voltar a executar depois de bloqueado",
  scan_inconclusive: "Análise não concluída — o motor não conseguiu avaliar o ficheiro",
};

/**
 * Rotulo legivel para um factor. Uma regra sem traducao propria nao fica com
 * underscores no ecra: `id.replaceAll("_", " ")` com a primeira letra maiuscula
 * e' o piso de honestidade — mostra a identificacao real em vez de a esconder.
 */
function rotuloDeRegra(rule: HeuristicRuleId): string {
  const proprio = RULE_LABELS[rule];
  if (proprio) return proprio;
  const legivel = rule.replaceAll("_", " ");
  return legivel.charAt(0).toUpperCase() + legivel.slice(1);
}

/**
 * Evidência forte autoriza a classificação crítica. Localização, entropia e
 * estrutura do ficheiro são heurísticas; ausência de assinatura é neutra.
 * YARA só é forte com classificação explícita da definição.
 */
const STRONG_RULES = new Set<HeuristicRuleId>([
  "known_bad_hash",
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

  const hasKnownHash = input.signatureMatch || input.rulesTriggered.includes("known_bad_hash");
  const hasYara = input.yaraMatches > 0 || input.rulesTriggered.includes("yara_match");
  const hasStrongYara = input.yaraMatches > 0 && (input.strongYaraMatches ?? 0) > 0;
  const hasStrongEvidence = hasKnownHash || hasStrongYara || input.rulesTriggered.some(r => STRONG_RULES.has(r));

  if (hasKnownHash) {
    score += 95;
    factors.push({
      id: "known-bad-hash",
      label: "Hash conhecido como malicioso",
      weight: 95,
      category: "signature",
    });
  }

  if (hasYara) {
    // Match count is not independent corroboration: rules can share strings.
    const weight = hasStrongYara ? 95 : 20;
    score += weight;
    if (!hasStrongYara) heuristicScore += weight;
    factors.push({
      id: "yara-match",
      label: hasStrongYara ? "YARA: evidência forte" : "YARA: heurística genérica sem corroboração",
      weight,
      category: "yara",
    });
  }

  for (const rule of new Set(input.rulesTriggered)) {
    if (rule === "yara_match" || rule === "known_bad_hash") continue;
    const weight = RULE_WEIGHTS[rule] ?? 10;
    score += weight;
    if (!STRONG_RULES.has(rule) && weight > 0) heuristicScore += weight;
    factors.push({
      id: rule,
      label: rotuloDeRegra(rule),
      weight,
      category: weight < 0 ? "trust" : STRONG_RULES.has(rule) ? "signature" : "heuristic",
    });
  }

  const signatureWeight = input.signatureStatus === "verified" || input.signatureStatus === "trusted"
    ? -20
    : input.signatureStatus === "invalid" || input.signatureStatus === "tampered" ? 25 : 0;
  if (signatureWeight !== 0) {
    score += signatureWeight;
    if (signatureWeight > 0) heuristicScore += signatureWeight;
    factors.push({ id: "authenticode", label: `Authenticode: ${input.signatureStatus}`, weight: signatureWeight, category: signatureWeight < 0 ? "trust" : "heuristic" });
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

  // Trust cannot cancel a known detection; weak evidence cannot authorize
  // destructive action, even when many correlated heuristics accumulate.
  const boundedScore = hasStrongEvidence ? Math.max(95, Math.min(100, Math.round(score)))
    : Math.max(0, Math.min(DEFAULT_SETTINGS.thresholds.alertMax, Math.round(score)));
  if (boundedScore !== score) {
    const label = hasStrongEvidence && score < 95 ? "Mínimo por evidência forte"
      : !hasStrongEvidence && score > DEFAULT_SETTINGS.thresholds.alertMax ? "Limite de risco sem evidência forte"
      : "Normalização do risco para 0–100";
    factors.push({ id: "evidence-bound", label, weight: boundedScore - score, category: hasStrongEvidence ? "signature" : "heuristic" });
    score = boundedScore;
  }
  const recommendedAction = actionFromScore(score);

  // ── A DECISÃO ────────────────────────────────────────────────────────────
  // O score sozinho nunca diz "isto é malware": uma soma de sinais fracos
  // alcanca 50 só porque o ficheiro está em \Temp\, tem entropia alta e é um
  // ZIP com um .exe lá dentro. Esses sinais também ocorrem em software legítimo.
  //
  //  · evidência forte (hash DB, YARA classificado, ClamAV, reexecução bloqueada)
  //    mantém o nível crítico, mesmo com fatores de confiança;
  //  · sem evidência forte, as heurísticas só promovem a "suspicious" quando
  //    estão REFORÇADAS entre si (atingem monitorMax) — aí é finding de
  //    atenção, não malware;
  //  · heurísticas isoladas ou fracas ficam "safe" e "low": continuam listadas
  //    como FINDING (fatores + ação recommended/logged), mas o serviço deixa de
  //    as anunciar como "Threat detected", porque isso exige severity != low.
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
    [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, wfpHealth(engine)]
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
