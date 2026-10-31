import * as path from "node:path";

/**
 * Helpers puros para guardar relatórios em PDF (R7-L3).
 *
 * Sem Electron e sem I/O: `main.ts` é o único que toca o disco, e
 * só depois de `validateReportPath` aceitar o caminho escolhido.
 */

/** Nome sugerido por defeito quando o renderer não envia nenhum. */
export const DEFAULT_REPORT_NAME = "Relatorio-CyberSafe.pdf";

/**
 * Garante a extensão `.pdf` (não duplica quando já existe, em
 * qualquer caixa). Nomes vazios ficam com o nome por defeito.
 */
export function ensurePdfExtension(name: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "") return DEFAULT_REPORT_NAME;
  return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
}

export interface ReportPathValidation {
  ok: boolean;
  /** Razão em PT-PT; presente só quando `ok` é false. */
  error?: string;
}

/**
 * Validação do caminho escolhido, pura (o que se pode afirmar sem
 * tocar no disco): nada de vazios, nulos, relativos ou sem extensão.
 * O destino é o que o utilizador escolheu no diálogo — não se
 * escreve em lado nenhum fora dele.
 */
export function validateReportPath(candidate: string): ReportPathValidation {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return { ok: false, error: "Caminho de destino vazio." };
  }
  if (candidate.includes("\0")) {
    return { ok: false, error: "Caminho de destino inválido." };
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, error: "O destino tem de ser um caminho absoluto." };
  }
  if (!/\.pdf$/i.test(candidate)) {
    return { ok: false, error: "O destino tem de ser um ficheiro PDF." };
  }
  return { ok: true };
}
