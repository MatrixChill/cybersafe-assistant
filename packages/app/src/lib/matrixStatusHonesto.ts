/**
 * TP-AUTO-02 · rótulo HONESTO do estado da MATRIX (configuração observada).
 *
 * `/api/ai/status` (packages/api/src/index.ts:841) devolve
 * `{ enabled, provider, model, streaming, consentDescriptor }`, mas `enabled`
 * vem de `checkAiAvailability()` — uma sonda ao fornecedor que esta vista NÃO
 * faz. `mode === "online"` em `AIAssistant` significa apenas «o fornecedor
 * respondeu uma vez nesta sessão», nunca «fornecedor verificado».
 */

export type MatrixConfigMode = "online" | "local" | "a-verificar";

/**
 * Configuração observada ≠ verificação do fornecedor. Sem sonda própria, esta
 * app não afirma "verificado"; o máximo que pode dizer é quem respondeu.
 */
export function matrixConfigLabelHonesto(mode: MatrixConfigMode): string {
  if (mode === "online") return "Fornecedor respondeu nesta sessão";
  if (mode === "local") return "Modo local — ligação não confirmada";
  return "A verificar o fornecedor";
}

/** Constante explícita: nenhuma sonda de fornecedor é feita nesta vista. */
export const MATRIX_FORNECEDOR_VERIFICADO = false;

export const VERSAO_MATRIX_STATUS = "matrix-status-honesto-v1";

