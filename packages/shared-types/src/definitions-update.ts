/** Resultado da atualização de definições, distinto do atualizador da aplicação. */
export interface DefinitionsUpdateResult {
  /** Só true quando os três componentes confirmaram atualização sem erros/avisos. */
  success: boolean;
  updatedAt: string | null;
  checkedAt: string;
  yaraUpdated: boolean;
  clamUpdated: boolean;
  hashesUpdated: boolean;
  errors: string[];
  warnings: string[];
}
