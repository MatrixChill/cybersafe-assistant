import { aplicarDesfecho, type OptimizeCartao } from "./optimizeModel";

/** A resposta antiga success:true não confirma os componentes da operação. */
export interface DefinitionUpdatePresentation {
  status: "updated" | "partial" | "failed" | "unverified";
  confirmed: boolean;
  message: string;
  details: string;
  updatedAt: string | null;
}
const unknown = (): DefinitionUpdatePresentation => ({
  status: "unverified", confirmed: false, updatedAt: null, details: "Resultado por componente não confirmado",
  message: "O serviço não confirmou o resultado por componente. A atualização não foi dada como concluída.",
});
export function definitionUpdatePresentation(value: unknown): DefinitionUpdatePresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown();
  const raw = value as Record<string, unknown>;
  if (typeof raw.success !== "boolean") return unknown();
  const keys = ["yaraUpdated", "clamUpdated", "hashesUpdated"] as const;
  const known = keys.every(key => typeof raw[key] === "boolean") &&
    Array.isArray(raw.errors) && raw.errors.every(x => typeof x === "string") &&
    Array.isArray(raw.warnings) && raw.warnings.every(x => typeof x === "string");
  if (!known) return raw.success === false ? {
    status: "failed", confirmed: false, updatedAt: null, details: "Sem confirmação por componente",
    message: "O serviço não confirmou a atualização. Nada foi dado como feito.",
  } : unknown();
  const flags = keys.map(key => raw[key] === true);
  const errors = raw.errors as string[];
  const warnings = raw.warnings as string[];
  // Não ecoar mensagens de transporte: podem conter URLs, caminhos ou segredos.
  const details = ["YARA", "ClamAV", "Hashes"].map((name,i) => `${name}: ${flags[i] ? "atualizado" : "não atualizado nesta operação"}`)
    .concat([`Erros: ${errors.length}`, `Avisos: ${warnings.length}`]).join(" · ");
  const updatedAt = typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null;
  if (raw.success && flags.every(Boolean) && errors.length === 0 && warnings.length === 0 && updatedAt) {
    return { status: "updated", confirmed: true, updatedAt, details,
      message: "Definições atualizadas nos três componentes. Isto não comprova a cobertura ou a eficácia dos motores." };
  }
  if (flags.some(Boolean) && (!flags.every(Boolean) || errors.length > 0 || warnings.length > 0)) {
    return { status: "partial", confirmed: false, updatedAt, details,
      message: "Atualização parcial ou com avisos. Nem todos os componentes têm uma atualização confirmada sem limitações." };
  }
  if (!raw.success || errors.length > 0) return {
    status: "failed", confirmed: false, updatedAt: null, details,
    message: "A atualização não foi confirmada. Consulte o estado dos motores antes de repetir.",
  };
  return { ...unknown(), details };
}

/** O mesmo mapeamento é usado pelo clique real da página e pelos testes. */
export function definitionUpdateCard(cartao: OptimizeCartao, value: unknown): OptimizeCartao {
  const outcome = definitionUpdatePresentation(value);
  const evidencia = outcome.details + (outcome.updatedAt ? ` · ${new Date(outcome.updatedAt).toLocaleString("pt-PT")}` : "");
  if (outcome.status === "partial" || outcome.status === "unverified") return {
    ...cartao, estado: "verificado", resultado: null, severidade: "atencao", evidencia, mensagem: outcome.message,
  };
  return aplicarDesfecho(cartao, "correcao", { ok: outcome.confirmed, evidencia, mensagem: outcome.message });
}
