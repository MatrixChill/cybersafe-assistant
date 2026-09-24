import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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
    if (this.config.paths.some(ex => lowerPath.startsWith(ex.toLowerCase()))) {
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
      if (lowerPath.startsWith(ex.toLowerCase())) {
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

  public updateConfig(newConfig: Partial<ExclusionConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  public getConfig(): ExclusionConfig {
    return { ...this.config };
  }
}
