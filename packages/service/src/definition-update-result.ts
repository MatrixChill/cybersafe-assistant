import type { UpdateResult } from "./updater.js";

/** A chamada terminar não prova que os três conjuntos de definições mudaram. */
export function createDefinitionsUpdateResult(result: UpdateResult, previousUpdatedAt: string | null, checkedAt: string) {
  const yaraUpdated = result.yaraUpdated === true;
  const clamUpdated = result.clamUpdated === true;
  const hashesUpdated = result.hashesUpdated === true;
  // Compatibilidade com fixtures antigos: se a verificação não for reportada,
  // uma atualização confirmada é a única prova de que o componente foi lido.
  const yaraChecked = result.yaraChecked ?? yaraUpdated;
  const clamChecked = result.clamChecked ?? clamUpdated;
  const hashesChecked = result.hashesChecked ?? hashesUpdated;
  const errors = result.errors.slice();
  const warnings = result.warnings.slice();
  const anyUpdated = yaraUpdated || clamUpdated || hashesUpdated;
  return {
    success: yaraChecked && clamChecked && hashesChecked && errors.length === 0 && warnings.length === 0,
    updatedAt: anyUpdated ? checkedAt : previousUpdatedAt,
    checkedAt, yaraUpdated, clamUpdated, hashesUpdated, yaraChecked, clamChecked, hashesChecked, errors, warnings,
  };
}
