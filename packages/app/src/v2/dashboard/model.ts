import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";
import {
  deriveProtectionLevel,
  type RealtimeProtectionInfo,
} from "@/lib/protectionHealth";
import type { V2Tone } from "../ui";
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
    let state: VisualState =
      raw === "active"
        ? "ACTIVE"
        : raw === "degraded"
          ? "DEGRADED"
          : raw === "error"
            ? "ERROR"
            : "UNAVAILABLE";
    if (state === "ACTIVE" && report?.coverage === "limited")
      state = "DEGRADED";
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
export function dashboardVerdict(
  d: DashboardSummary,
  realtime: RealtimeProtectionInfo | undefined,
  connected: boolean | null | undefined,
): { title: string; description: string; tone: V2Tone } {
  if (connected !== true)
    return {
      title: "Ligação não confirmada",
      description:
        "Sem leitura atual do serviço. Não é possível confirmar o estado de proteção.",
      tone: "na",
    };
  const level = deriveProtectionLevel(d.systemStatus, d.engineHealth, realtime);
  if (level === "critical")
    return {
      title: "Proteção com limitações",
      description:
        "O relatório recebido contém erros ou sinais críticos. Consulta o estado de cada motor.",
      tone: "crit",
    };
  if (realtime?.pausedUntil)
    return {
      title: "Monitorização em pausa",
      description:
        "O serviço reportou uma pausa. Os motores mantêm estados independentes.",
      tone: "warn",
    };
  if (realtime?.enabled === false)
    return {
      title: "Monitorização desligada",
      description:
        "A análise contínua está desligada. As análises manuais continuam disponíveis.",
      tone: "warn",
    };
  if (realtime?.enabled !== true)
    return {
      title: "Monitorização não verificada",
      description:
        "O serviço ainda não confirmou se a análise contínua está ligada.",
      tone: "warn",
    };
  if (level !== "protected")
    return {
      title: "Proteção com limitações",
      description:
        "Consulta a cobertura e os limites reportados antes de interpretar os resultados.",
      tone: "warn",
    };
  return {
    title: "Monitorização ligada",
    description:
      "Estado reportado pelo serviço. Não confirma cobertura integral do Windows.",
    tone: "ok",
  };
}
