import { aplicarDesfecho, type OptimizeCartao } from "./optimizeModel";

/** Resultado por componente; distingue verificacao executada de alteracao. */
export interface DefinitionUpdatePresentation {
  status: "updated" | "current" | "partial" | "failed" | "unverified";
  confirmed: boolean;
  message: string;
  details: string;
  updatedAt: string | null;
}

const unknown = (): DefinitionUpdatePresentation => ({
  status: "unverified", confirmed: false, updatedAt: null, details: "Resultado por componente nao confirmado",
  message: "O servico nao confirmou o resultado por componente. A atualizacao nao foi dada como concluida.",
});

const NAMES = ["YARA", "ClamAV", "Hashes"] as const;

function validDate(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function detailsFor(checked: boolean[], updated: boolean[], errors: number, warnings: number): string {
  return NAMES.map((name, i) => {
    const state = updated[i] ? "atualizado" : checked[i] ? "verificado sem novidades" : "não atualizado";
    return `${name}: ${state}`;
  }).concat([`Erros: ${errors}`, `Avisos: ${warnings}`]).join(" · ");
}

export function definitionUpdatePresentation(value: unknown): DefinitionUpdatePresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown();
  const raw = value as Record<string, unknown>;
  if (typeof raw.success !== "boolean") return unknown();
  const flags = ["yaraUpdated", "clamUpdated", "hashesUpdated"] as const;
  const checks = ["yaraChecked", "clamChecked", "hashesChecked"] as const;
  const known = flags.every(key => typeof raw[key] === "boolean") &&
    Array.isArray(raw.errors) && raw.errors.every(x => typeof x === "string") &&
    Array.isArray(raw.warnings) && raw.warnings.every(x => typeof x === "string");
  if (!known) return raw.success === false ? {
    status: "failed", confirmed: false, updatedAt: null, details: "Sem confirmacao por componente",
    message: "O servico nao confirmou a atualizacao. Nada foi dado como feito.",
  } : unknown();

  const updated = flags.map(key => raw[key] === true);
  const checked = checks.map((key, i) => typeof raw[key] === "boolean" ? raw[key] === true : updated[i]);
  const checkedReported = checks.every(key => typeof raw[key] === "boolean");
  const errors = raw.errors as string[];
  const warnings = raw.warnings as string[];
  const updatedAt = validDate(raw.updatedAt);
  const details = detailsFor(checked, updated, errors.length, warnings.length);
  const clean = errors.length === 0 && warnings.length === 0;

  // Contrato antigo: so ha prova do que foi atualizado. Uma chamada sem
  // alteracoes nao pode ser convertida em sucesso por inferencia.
  if (!checkedReported) {
    if (raw.success && updated.every(Boolean) && clean) {
      return { status: "updated", confirmed: true, updatedAt, details,
        message: "Definições atualizadas nos três componentes. Isto não comprova a cobertura ou a eficácia dos motores." };
    }
    if (updated.some(Boolean) && (!updated.every(Boolean) || !clean)) {
      return { status: "partial", confirmed: false, updatedAt, details,
        message: "Atualizacao parcial ou com avisos. Nem todos os componentes tem uma atualizacao confirmada sem limitacoes." };
    }
    return { status: "failed", confirmed: false, updatedAt: null, details,
      message: "A atualizacao nao foi confirmada. Consulte o estado dos motores antes de repetir." };
  }

  if (!checked.every(Boolean)) {
    return { status: updated.some(Boolean) ? "partial" : "failed", confirmed: false, updatedAt, details,
      message: updated.some(Boolean)
        ? "Verificacao parcial: nem todos os componentes responderam. Consulte o estado por fonte antes de repetir."
        : "Nao foi possivel verificar todos os componentes. As assinaturas anteriormente carregadas continuam disponiveis; consulte o estado por fonte." };
  }

  if (!clean) {
    return { status: updated.some(Boolean) ? "partial" : "failed", confirmed: false, updatedAt, details,
      message: updated.some(Boolean)
        ? "Foram encontradas atualizacoes, mas a operacao terminou com erros ou avisos. Consulte o detalhe."
        : "A verificacao terminou com erros ou avisos. Nada foi dado como atualizado." };
  }

  if (updated.every(Boolean)) {
    return { status: "updated", confirmed: true, updatedAt, details,
      message: "Definicoes atualizadas nos tres componentes. Isto nao comprova a cobertura ou a eficacia dos motores." };
  }

  if (!updated.some(Boolean)) {
    return { status: "current", confirmed: true, updatedAt: null, details,
      message: "Definições verificadas. Não foram encontradas atualizações disponíveis." };
  }

  return { status: "partial", confirmed: false, updatedAt, details,
    message: "Verificacao concluida: alguns componentes foram atualizados e outros ja estavam atualizados." };
}

/** O mesmo mapeamento e usado pelo clique real da pagina e pelos testes. */
export function definitionUpdateCard(cartao: OptimizeCartao, value: unknown): OptimizeCartao {
  const outcome = definitionUpdatePresentation(value);
  const evidencia = outcome.details + (outcome.updatedAt ? ` · ${new Date(outcome.updatedAt).toLocaleString("pt-PT")}` : "");
  if (outcome.status === "current") return {
    ...cartao, estado: "verificado", resultado: "sem-problema", severidade: null, evidencia, mensagem: outcome.message,
  };
  if (outcome.status === "partial" || outcome.status === "unverified") return {
    ...cartao, estado: "verificado", resultado: null, severidade: "atencao", evidencia, mensagem: outcome.message,
  };
  return aplicarDesfecho(cartao, "correcao", { ok: outcome.confirmed, evidencia, mensagem: outcome.message });
}
