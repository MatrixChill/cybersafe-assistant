/**
 * Log persistente mínimo do shell desktop (append-only, rotação única).
 *
 * PORQUE EXISTE: no pacote, o `console.log` do processo principal não vai a
 * lado nenhum — o bug intermitente da saída pela tray (10/10/2026) não deixou
 * UMA linha de evidência. Este ficheiro guarda só os eventos do ciclo de saída
 * e do renderer (o que é preciso para diagnosticar a próxima ocorrência), com
 * teto de tamanho para nunca crescer sem limite. Nada de dados do utilizador:
 * só nomes de eventos e valores técnicos.
 *
 * Nunca lança: falhar a escrever um log não pode afectar o produto.
 */

import fs from "node:fs";
import path from "node:path";

/** Tamanho máximo antes de rodar para `<ficheiro>.1` (256 KiB). */
export const DESKTOP_LOG_MAX_BYTES = 256 * 1024;

export interface DesktopLogDeps {
  fsImpl?: Pick<
    typeof fs,
    "existsSync" | "statSync" | "renameSync" | "rmSync" | "mkdirSync" | "appendFileSync"
  >;
  now?: () => Date;
}

/**
 * Acrescenta uma linha ao log, criando o diretório se preciso. Se o ficheiro
 * exceder o teto, roda para `<ficheiro>.1` (uma geração) antes de escrever.
 * Devolve true quando escreveu.
 */
export function appendDesktopLog(
  filePath: string,
  event: string,
  details: Record<string, unknown> = {},
  deps: DesktopLogDeps = {},
): boolean {
  const f = deps.fsImpl ?? fs;
  try {
    f.mkdirSync(path.dirname(filePath), { recursive: true });
    if (f.existsSync(filePath)) {
      const size = f.statSync(filePath).size;
      if (size > DESKTOP_LOG_MAX_BYTES) {
        const rotated = `${filePath}.1`;
        try {
          if (f.existsSync(rotated)) f.rmSync(rotated, { force: true });
        } catch {
          /* rotação best-effort */
        }
        f.renameSync(filePath, rotated);
      }
    }
    const line = JSON.stringify({
      at: (deps.now?.() ?? new Date()).toISOString(),
      event,
      ...details,
    });
    f.appendFileSync(filePath, `${line}\n`, "utf8");
    return true;
  } catch {
    // Diagnóstico não pode derrubar o produto.
    return false;
  }
}
