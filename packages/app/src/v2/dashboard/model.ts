import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";
import type { RealtimeProtectionInfo } from "@/lib/protectionHealth";
import type { V2Tone } from "../ui";
import { protectionOverview, type ProtectionOverview } from "@/lib/protectionOverview";
export type VisualState =
  | "ACTIVE"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "LOADING"
  | "ERROR";
export const ENGINES = [
  { key: "yara", name: "YARA", symbol: "Y", kind: "Regras de deteção" },
  {
    key: "hashDb",
    name: "HashDB",
    symbol: "#",
    kind: "Assinaturas de ficheiros",
  },
  { key: "clamav", name: "ClamAV", symbol: "C", kind: "Análise antivírus" },
  {
    key: "nativeEngine",
    name: "Native C++",
    symbol: "N",
    kind: "Análise nativa",
  },
] as const;
export const STATE_LABEL: Record<VisualState, string> = {
  ACTIVE: "Ativo",
  DEGRADED: "Degradado",
  UNAVAILABLE: "Sem leitura",
  LOADING: "A consultar",
  ERROR: "Erro",
};
/** Validate the fields consumed by the last-scan presentation, not a new API schema. */
export function isHistoryEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    x.id.length > 0 &&
    ["custom", "quick", "full"].includes(String(x.type)) &&
    ["completed", "cancelled", "failed"].includes(String(x.status)) &&
    typeof x.endedAt === "string" &&
    Number.isFinite(Date.parse(x.endedAt)) &&
    typeof x.filesAnalyzed === "number" &&
    Number.isFinite(x.filesAnalyzed) &&
    x.filesAnalyzed >= 0 &&
    (x.engineLimitations === undefined ||
      (Array.isArray(x.engineLimitations) &&
        x.engineLimitations.every((v) => typeof v === "string")))
  );
}
export function engineCards(
  health: EngineHealth | undefined,
  connected: boolean | null | undefined,
) {
  return ENGINES.map((e) => {
    const report = connected === true ? health?.[e.key] : undefined;
    const raw = report?.status;
    const state: VisualState =
      raw === "active"
        ? "ACTIVE"
        : raw === "degraded"
          ? "DEGRADED"
          : raw === "error"
            ? "ERROR"
            : "UNAVAILABLE";
    return {
      ...e,
      state,
      label: raw === "unavailable" ? "Indisponível" : STATE_LABEL[state],
      coverage:
        report?.coverage === "limited"
          ? "Cobertura limitada"
          : report?.coverage === "normal" && raw === "active"
            ? "Cobertura reportada: normal"
            : "Cobertura não confirmada",
      report,
    };
  });
}
/**
 * Limitações que o SERVIÇO reportou, prontas para o hero. Não se deduz uma
 * limitação a partir de um motor "active": a lista é a `degradedReasons`
 * recebida, e a UI só a mostra quando existe. Sem lista, o hero mantém a frase
 * genérica — não inventa uma causa.
 */
export function dashboardLimitationSummary(engine?: EngineHealth): string | null {
  const reasons = (engine?.degradedReasons ?? [])
    .map((reason) => reason.trim())
    .filter((reason) => reason !== "");
  if (reasons.length === 0) return null;
  // Duas causas chegam para identificar o problema; o diagnóstico completo
  // continua disponível em ProtectionDetails.
  return reasons.slice(0, 2).join(" · ");
}

export function dashboardVerdict(
  d: DashboardSummary,
  realtime: RealtimeProtectionInfo | undefined,
  connected: boolean | null | undefined,
): { title: string; description: string; tone: V2Tone; overview: ProtectionOverview } {
  // Uma unica decisao. O titulo e APRESENTACAO: nenhum consumidor pode
  // inferir o estado comparando esta string (era essa a origem da
  // contradicao entre o Dashboard e a janela de detalhes).
  const overview = protectionOverview(d, realtime, connected);
  return {
    title: overview.title,
    description: overview.description,
    tone: overview.tone,
    overview,
  };
}
