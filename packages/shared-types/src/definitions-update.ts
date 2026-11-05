/** Resultado da atualização de definições, distinto do atualizador da aplicação. */
export interface DefinitionsUpdateResult {
  /** True quando os três componentes foram verificados com resposta válida, sem erros/avisos. */
  success: boolean;
  updatedAt: string | null;
  checkedAt: string;
  yaraUpdated: boolean;
  clamUpdated: boolean;
  hashesUpdated: boolean;
  /** Verificação executada (independente de ter havido alterações). */
  yaraChecked: boolean;
  clamChecked: boolean;
  hashesChecked: boolean;
  errors: string[];
  warnings: string[];
}
