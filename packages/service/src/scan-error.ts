/**
 * Classificação de erros de filesystem esperados durante uma análise.
 *
 * No Windows, junctions/reparse points (Documents\Meus Vídeos, Minhas Imagens,
 * Minhas Músicas) e ficheiros temporários que desaparecem
 * (Temp\__PSScriptPolicyTest_*.ps1, Temp\WinSAT) produzem EPERM/ENOENT/EACCES/
 * EBUSY/EISDIR. Não são falhas do motor: são alvos que não são ficheiros de
 * leitura válidos. Devem ser tolerados e registados numa única linha agregada,
 * nunca com stack trace — erros inesperados continuam visíveis.
 */
export function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "ENOENT" || code === "EACCES" || code === "EBUSY" || code === "EISDIR";
}

/** Janela de agregação para logs de erros transitórios de scan (ms). */
export const TRANSIENT_SCAN_ERROR_WINDOW_MS = 60_000;
