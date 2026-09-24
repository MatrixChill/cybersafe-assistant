import type { EngineHealth, ProtectionStatus } from "@cybersafe/shared-types";

/**
 * Níveis apresentados no Dashboard.
 * O backend continua a ser a única fonte de verdade: o status (ProtectionStatus)
 * já é calculado com scoreToStatus(riskScore, degraded) + effectiveRiskScore().
 * Aqui apenas mapeamos para o nome visual e defendemos contra estados
 * contraditórios (ex.: "safe" com motores degradados).
 */
export type ProtectionLevel = "protected" | "attention" | "degraded" | "critical";

export function deriveProtectionLevel(
  status: ProtectionStatus,
  engine?: EngineHealth,
): ProtectionLevel {
  if (engine && !engine.serviceRunning) return "critical";
  const hasEngineError = engine
    && [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, engine.firewall]
      .some((e) => e && e.status === "error");
  if (hasEngineError) return "critical";
  const unhealthy = engine?.anyEngineDegraded === true;

  if (status === "safe") return unhealthy ? "degraded" : "protected";
  if (status === "attention") return unhealthy ? "degraded" : "attention";
  if (status === "critical") return "critical";
  return "degraded";
}

export interface ProtectionLevelMeta {
  /** Texto longo no chip do Dashboard. */
  label: string;
  /** Texto curto junto ao gauge. */
  shortLabel: string;
  /** Texto simples para o banner / utilizador comum. */
  summary: string;
  /** Mensagem técnica curta para o modo técnico. */
  techSummary: string;
  /** Classes tokens semânticos (sucesso/aviso/perigo) do projeto. */
  dotClass: string;
  chipClass: string;
  textClass: string;
  bannerBadgeClass: string;
}

export const PROTECTION_LEVEL_META: Record<ProtectionLevel, ProtectionLevelMeta> = {
  protected: {
    label: "Sistema Protegido",
    shortLabel: "Protegido",
    summary: "Todos os componentes de proteção estão ativos e o teu sistema está bem.",
    techSummary: "Todos os motores reportam ACTIVE.",
    dotClass: "bg-success",
    chipClass: "border bg-success/10 border-success/30",
    textClass: "text-success",
    bannerBadgeClass: "bg-success/10 border-success/30 text-success",
  },
  attention: {
    label: "Atenção Necessária",
    shortLabel: "Atenção",
    summary: "Proteção parcialmente disponível. Alguns componentes estão limitados, mas o sistema continua monitorizado.",
    techSummary: "Pelo menos um motor não está totalmente ativo.",
    dotClass: "bg-warning",
    chipClass: "border bg-warning/10 border-warning/30",
    textClass: "text-warning",
    bannerBadgeClass: "bg-warning/10 border-warning/30 text-warning",
  },
  degraded: {
    label: "Proteção Degradada",
    shortLabel: "Degradado",
    summary: "Alguns componentes de proteção não estão disponíveis neste computador.",
    techSummary: "Motores IMPORTANTES indisponíveis — a confiança nas deteções está reduzida.",
    dotClass: "bg-danger",
    chipClass: "border bg-danger/10 border-danger/30",
    textClass: "text-danger",
    bannerBadgeClass: "bg-danger/10 border-danger/30 text-danger",
  },
  critical: {
    label: "Estado Crítico",
    shortLabel: "Crítico",
    summary: "Proteção essencial indisponível ou ameaça crítica detetada. Revisão imediata recomendada.",
    techSummary: "Motor essencial em ERROR ou serviço parado.",
    dotClass: "bg-danger",
    chipClass: "border bg-danger/10 border-danger/40",
    textClass: "text-danger",
    bannerBadgeClass: "bg-danger/10 border-danger/30 text-danger",
  },
};

export function levelMeta(level: ProtectionLevel): ProtectionLevelMeta {
  return PROTECTION_LEVEL_META[level];
}

/**
 * Explicação determinística da pontuação com os pesos REAIS do backend.
 * Espelha `effectiveRiskScore()` (@cybersafe/core): o risco efetivo é o máximo
 * entre as ameaças recentes e um piso por motores de análise ativos
 * (0 ativos → 75; 1–2 → 45; 3–4 com algum degradado → 20; senão 0).
 * A pontuação apresentada é 100 − risco efetivo.
 */
export const SCORE_WEIGHTS = {
  floorAllUnavailable: 75,
  floorAtMostTwoActive: 45,
  floorDegraded: 20,
} as const;

export function explainProtectionScore(
  score: number,
  engine?: EngineHealth,
): { activeEngines: number; totalEngines: number; maxPossible: number; threatPenalty: number } {
  const subEngines = [engine?.yara, engine?.hashDb, engine?.clamav, engine?.nativeEngine]
    .filter((e): e is NonNullable<typeof e> => !!e);
  const active = subEngines.filter((e) => e.status === "active").length;
  const total = subEngines.length > 0 ? subEngines.length : 4;
  const hasDegraded = subEngines.some((e) => e.status === "degraded");
  const floor = active === 0
    ? SCORE_WEIGHTS.floorAllUnavailable
    : active <= 2
      ? SCORE_WEIGHTS.floorAtMostTwoActive
      : hasDegraded
        ? SCORE_WEIGHTS.floorDegraded
        : 0;
  const maxPossible = Math.max(0, 100 - floor);
  const threatPenalty = Math.max(0, maxPossible - Math.max(0, Math.min(100, score)));
  return { activeEngines: active, totalEngines: total, maxPossible, threatPenalty };
}

/** Garante que nunca degradamos para texto de "proteção absoluta". */
export const PROTECTED_ONLY_CLAIMS = new Set(["Sistema Protegido", "Protegido"]);