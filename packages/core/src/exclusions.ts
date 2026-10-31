import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Fronteira de segmento para exclusões por caminho (D7).
 *
 * Um `startsWith` cru excluía irmãos com o mesmo prefixo textual
 * ("C:\\foo" excluía "C:\\foobar"). Aqui o alvo tem de SER o caminho excluído
 * ou um descendente seu, com a fronteira a cair num separador de caminho.
 * Recebe o caminho já normalizado e em minúsculas; a exclusão é normalizada aqui.
 */
export function matchesPathBoundary(lowerPath: string, exclusion: string): boolean {
  if (!exclusion) return false;
  const normalizedEx = path.normalize(exclusion).toLowerCase();
  if (normalizedEx === "" || normalizedEx === ".") return false;
  if (lowerPath === normalizedEx) return true;
  const withSep = normalizedEx.endsWith(path.sep) ? normalizedEx : normalizedEx + path.sep;
  return lowerPath.startsWith(withSep);
}

/**
 * Categoria de exclusão: PORQUE um ficheiro ficou fora dos motores. Serve para
 * exibir o dado sem expor caminhos do utilizador (`path` não transporta o
 * caminho; `extension`/`filename` transportam só o token).
 */
export interface ExclusionCategory {
  reason: "extension" | "path" | "filename";
  /** Extensão (`.log`) ou nome exato; ausente para exclusões por caminho. */
  detail?: string;
}

export interface ExclusionConfig {
  /** Directories or file paths to exclude. Prefix-match: excluding "C:\foo" also excludes "C:\foo\bar". */
  paths: string[];
  /** File extensions to exclude (with leading dot, e.g. ".tmp"). */
  extensions: string[];
  /** Exact file basenames to exclude (case-insensitive). */
  files: string[];
}

/**
 * Decides whether a file should be skipped BEFORE it reaches any analysis engine.
 *
 * Design principle: exclusion is for files that are UNINTERESTING or UNSAFE to scan
 * (temp caches, build artifacts, the service's own files). High-risk extensions like
 * .exe, .dll, .zip, .lnk, .ps1 etc. must NEVER be excluded here — they reach the
 * engines which decide per-engine applicability.
 */
export class ExclusionManager {
  private config: ExclusionConfig;

  constructor(config?: Partial<ExclusionConfig>) {
    const home = os.homedir();
    const cybersafeDir = path.join(home, ".cybersafe-service");

    this.config = {
      paths: config?.paths || [
        // CyberSafe internal runtime — avoid scanning our own files
        cybersafeDir,
      ],
      extensions: config?.extensions || [".tmp", ".log", ".cache", ".bak", ".dat"],
      files: config?.files || [],
    };
  }

  /**
   * Returns true when the file must NOT reach any analysis engine.
   */
  public isExcluded(filePath: string): boolean {
    if (!filePath) return true;

    const normalizedPath = path.normalize(filePath);
    const lowerPath = normalizedPath.toLowerCase();
    const ext = path.extname(lowerPath);
    const fileName = path.basename(lowerPath);

    // 1. Path prefix exclusions (directories / exact files)
    if (this.config.paths.some(ex => matchesPathBoundary(lowerPath, ex))) {
      return true;
    }

    // 2. Extension exclusions (temp / cache files only)
    if (this.config.extensions.includes(ext)) {
      return true;
    }

    // 3. Exact filename exclusions
    if (this.config.files.includes(fileName)) {
      return true;
    }

    return false;
  }

  /**
   * Returns a human-readable reason why the file is excluded, or null if not excluded.
   */
  public exclusionReason(filePath: string): string | null {
    if (!filePath) return "empty path";

    const normalizedPath = path.normalize(filePath);
    const lowerPath = normalizedPath.toLowerCase();
    const ext = path.extname(lowerPath);
    const fileName = path.basename(lowerPath);

    for (const ex of this.config.paths) {
      if (matchesPathBoundary(lowerPath, ex)) {
        return `path matches exclusion: ${ex}`;
      }
    }
    if (this.config.extensions.includes(ext)) {
      return `extension excluded: ${ext}`;
    }
    if (this.config.files.includes(fileName)) {
      return `filename excluded: ${fileName}`;
    }
    return null;
  }

  /**
   * A MESMA decisão de `isExcluded`, mas com a categoria que a explica.
   *
   * A ORDEM das regras é a de `isExcluded` (caminho → extensão → nome) e não
   * pode divergir: um ficheiro que case duas regras tem de ser classificado pela
   * primeira que o excluiu, senão a explicação contradiz a contagem. Há um
   * teste que confronta as duas funções numa matriz de entradas.
   */
  public exclusionCategory(filePath: string): ExclusionCategory | null {
    if (!filePath) return { reason: "path" };

    const lowerPath = path.normalize(filePath).toLowerCase();
    if (this.config.paths.some(ex => matchesPathBoundary(lowerPath, ex))) {
      return { reason: "path" };
    }
    const ext = path.extname(lowerPath);
    if (this.config.extensions.includes(ext)) {
      return { reason: "extension", detail: ext };
    }
    const fileName = path.basename(lowerPath);
    if (this.config.files.includes(fileName)) {
      return { reason: "filename", detail: fileName };
    }
    return null;
  }

  public updateConfig(newConfig: Partial<ExclusionConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  public getConfig(): ExclusionConfig {
    return { ...this.config };
  }
}
