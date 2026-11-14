import type { DashboardSummary, EngineHealth, EngineSubsystemHealth } from "@cybersafe/shared-types";
import { ENGINE_DISPLAY_NAME, engineContextCopy, engineUserReason, engineUserSummary } from "@cybersafe/shared-types";
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
      // «Não instalado» / «Erro ao executar» vêm da normalização partilhada;
      // o detalhe técnico fica no diagnóstico completo.
      label:
        report && engineUserReason(e.key, report) && raw !== "active"
          ? engineContextCopy(e.key, report).estado
          : raw === "unavailable" ? "Indisponível" : STATE_LABEL[state],
      friendly: report ? engineContextCopy(e.key, report) : null,
      coverage:
        report?.coverage === "limited"
          ? "Cobertura limitada"
          : report?.coverage === "normal" && raw === "active"
            ? "Cobertura reportada: normal"
            : !report ? "Sem leitura de cobertura"
              : report.coverage === undefined ? "Sem métrica de cobertura"
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
/**
 * O serviço publica as razões dos motores como `«Nome»: «status» — «detail»`
 * (ex.: `ClamAV: unavailable — clamscan not found or failed: spawn clamscan
 * ENOENT`). O hero mostra a frase curta da normalização partilhada; o texto
 * técnico completo continua em ProtectionDetails (diagnóstico).
 */
const ENGINE_REASON = /^(.+?): (active|degraded|unavailable|error) — /;
const ENGINE_KEYS = ["yara", "hashDb", "clamav", "nativeEngine"] as const;
export function friendlyEngineReason(reason: string, engine?: EngineHealth): string {
  const m = ENGINE_REASON.exec(reason);
  if (!m) return reason;
  const key = ENGINE_KEYS.find((k) => ENGINE_DISPLAY_NAME[k] === m[1]);
  if (!key) return reason;
  const sub: EngineSubsystemHealth = engine?.[key] ?? { status: m[2] as EngineSubsystemHealth["status"], detail: reason.slice(m[0].length) };
  // Só se reescreve o que a normalização reconhece (não instalado, sem bases,
  // erro ao executar, a verificar); o resto mantém a razão do serviço.
  return engineUserReason(key, sub) ? engineUserSummary(key, sub) : reason;
}

export function dashboardLimitationSummary(engine?: EngineHealth): string | null {
  const reasons = (engine?.degradedReasons ?? [])
    .map((reason) => friendlyEngineReason(reason.trim(), engine))
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
