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

/**
 * Categoria factual de um erro de filesystem. Usado para agrupar ficheiros
 * inacessíveis por motivo (nunca expõe o caminho ou a mensagem original).
 *
 * As categorias correspondem a causas observáveis no Windows:
 *   - "permissions_denied": EPERM/EACCES (acesso negado pelo SO)
 *   - "not_found": ENOENT (o ficheiro desapareceu entre o readdir e o open)
 *   - "path_too_long": ENAMETOOLONG (limite de 260/32767 chars no Windows)
 *   - "locked_or_busy": EBUSY (ficheiro bloqueado por outro processo)
 *   - "other": qualquer outro código — não é silenciado, é agrupado como "outro"
 */
export type FsErrorCategory =
  | "permissions_denied"
  | "not_found"
  | "path_too_long"
  | "locked_or_busy"
  | "other";

export function categorizeFsError(error: unknown): FsErrorCategory {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permissions_denied";
    case "ENOENT":
      return "not_found";
    case "ENAMETOOLONG":
      return "path_too_long";
    case "EBUSY":
      return "locked_or_busy";
    default:
      return "other";
  }
}

/** Janela de agregação para logs de erros transitórios de scan (ms). */
export const TRANSIENT_SCAN_ERROR_WINDOW_MS = 60_000;
