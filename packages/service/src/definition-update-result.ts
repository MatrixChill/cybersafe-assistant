import type { UpdateResult } from "./updater.js";

/** A chamada terminar não prova que os três conjuntos de definições mudaram. */
export function createDefinitionsUpdateResult(result: UpdateResult, previousUpdatedAt: string | null, checkedAt: string) {
  const yaraUpdated = result.yaraUpdated === true;
  const clamUpdated = result.clamUpdated === true;
  const hashesUpdated = result.hashesUpdated === true;
  const errors = result.errors.slice();
  const warnings = result.warnings.slice();
  const anyUpdated = yaraUpdated || clamUpdated || hashesUpdated;
  return {
    success: yaraUpdated && clamUpdated && hashesUpdated && errors.length === 0 && warnings.length === 0,
    updatedAt: anyUpdated ? checkedAt : previousUpdatedAt,
    checkedAt, yaraUpdated, clamUpdated, hashesUpdated, errors, warnings,
  };
}
