import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ExclusionRule } from "@cybersafe/shared-types";

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
  private rules: ExclusionRule[] = [];
  private configPath?: string;
  private protectedPaths: string[] = [];
  private readError?: string;
  private pending: Promise<unknown> = Promise.resolve();

  async init(configPath: string, protectedPaths: string[] = []): Promise<void> {
    this.configPath = path.resolve(configPath);
    this.protectedPaths = [path.dirname(this.configPath), ...protectedPaths].map(value => path.resolve(value));
    this.readError = undefined;
    try {
      const stat = await fsp.lstat(this.configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000 || stat.nlink !== 1) throw new Error("invalid");
      const document = JSON.parse(await fsp.readFile(this.configPath, "utf8"));
      if (document?.version !== 1) throw new Error("version");
      this.rules = await this.parseRules(document.rules);
      this.readError = undefined;
    } catch (error) {
      this.rules = [];
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.readError = "Não foi possível ler as exclusões guardadas. Regras do utilizador não aplicadas; política interna mantida.";
      }
    }
  }

  private async parseRules(input: unknown): Promise<ExclusionRule[]> {
    if (!Array.isArray(input) || input.length > 128) throw new Error("Máximo de 128 regras de exclusão.");
    const ids = new Set<string>();
    const targets = new Set<string>();
    const result: ExclusionRule[] = [];
    const highRisk = new Set([".exe", ".dll", ".sys", ".msi", ".com", ".scr", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".lnk", ".jar", ".zip", ".7z", ".rar"]);
    for (const item of input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Regra de exclusão inválida.");
      const rule = item as Record<string, unknown>;
      if (Object.keys(rule).some(key => !["id", "type", "value", "enabled", "createdAt", "reason"].includes(key)) ||
          typeof rule.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(rule.id) || ids.has(rule.id) ||
          (rule.type !== "file" && rule.type !== "folder" && rule.type !== "extension") || typeof rule.enabled !== "boolean" ||
          typeof rule.value !== "string" || !rule.value.trim() || rule.value.length > 1024 ||
          typeof rule.createdAt !== "string" || rule.createdAt.length > 40 || !Number.isFinite(Date.parse(rule.createdAt)) ||
          (rule.reason !== undefined && (typeof rule.reason !== "string" || rule.reason.length > 240 || /[\x00-\x1f]/.test(rule.reason)))) {
        throw new Error("Regra de exclusão inválida ou identificador repetido.");
      }
      let value = rule.value.trim();
      if (rule.type === "extension") {
        value = value.toLowerCase();
        if (!/^\.[a-z0-9]{1,16}$/.test(value) || highRisk.has(value)) {
          throw new Error("Extensão inválida ou de risco elevado; não pode ser excluída globalmente.");
        }
      } else {
        if (!path.isAbsolute(value) || /[\x00-\x1f*?]/.test(value) ||
            (process.platform === "win32" && (!(/^[a-zA-Z]:/.test(value) && ["/", "\\"].includes(value[2])) || value.slice(2).includes(":")))) {
          throw new Error("Indique um caminho local absoluto, sem padrões nem caminhos de dispositivo.");
        }
        value = path.resolve(value);
        const lower = value.toLowerCase();
        const broadPaths = [path.parse(value).root, os.homedir(), process.env.USERPROFILE, process.env.SystemRoot, process.env.ProgramFiles, process.env.ProgramData].filter((entry): entry is string => Boolean(entry));
        if (broadPaths.some(entry => path.resolve(entry).toLowerCase() === lower) ||
            this.protectedPaths.some(entry => matchesPathBoundary(entry.toLowerCase(), value) || matchesPathBoundary(lower, entry))) {
          throw new Error("Exclusão demasiado ampla ou sobre dados internos da aplicação.");
        }
        // Não aceitar aliases (junctions/symlinks), nem um alias num antepassado.
        let current = value;
        let targetStat: fs.Stats | undefined;
        while (true) {
          try {
            const stat = await fsp.lstat(current);
            if (stat.isSymbolicLink()) throw new Error("Ligações simbólicas e junctions não podem ser excluídas.");
            if (current === value) targetStat = stat;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
        if (targetStat && (rule.type === "file" ? !targetStat.isFile() : !targetStat.isDirectory())) {
          throw new Error("O tipo da regra não corresponde ao alvo.");
        }
      }
      const key = `${rule.type}:${value.toLowerCase()}`;
      if (targets.has(key)) throw new Error("Já existe uma regra para este alvo.");
      ids.add(rule.id); targets.add(key);
      result.push({ id: rule.id, type: rule.type, value,
        enabled: rule.enabled, createdAt: rule.createdAt,
        ...(typeof rule.reason === "string" && rule.reason.trim() ? { reason: rule.reason.trim() } : {}) });
    }
    return result;
  }

  /** A política interna não é editável pelo IPC. Só publica regras após rename confirmado. */
  updateRules(input: unknown): Promise<{ success: boolean; error?: string }> {
    const operation = this.pending.then(async () => {
      let temporary: string | undefined;
      try {
        if (!this.configPath) return { success: false, error: "Exclusões ainda não inicializadas." };
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            Object.keys(input).length !== 1 || !("rules" in input)) {
          return { success: false, error: "Pedido de exclusões inválido." };
        }
        const rules = await this.parseRules((input as { rules: unknown }).rules);
        const parent = await fsp.lstat(path.dirname(this.configPath));
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("invalid-parent");
        try {
          const stat = await fsp.lstat(this.configPath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid-config");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const document = JSON.stringify({ version: 1, rules });
        if (Buffer.byteLength(document, "utf8") > 512_000) throw new Error("config-too-large");
        temporary = `${this.configPath}.${randomUUID()}.tmp`;
        const handle = await fsp.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(document, "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        await fsp.rename(temporary, this.configPath);
        temporary = undefined;
        this.rules = rules;
        this.readError = undefined;
        return { success: true };
      } catch {
        return { success: false, error: "Não foi possível validar ou guardar as exclusões. A configuração anterior foi mantida; verifique o caminho, o tipo e os limites da regra." };
      } finally {
        if (temporary) await fsp.rm(temporary, { force: true }).catch(() => {
          console.warn("[Exclusions] Não foi possível remover um temporário de configuração.");
        });
      }
    });
    this.pending = operation;
    return operation;
  }

  /** A API de decisão é síncrona; resolver só quando uma regra por caminho casa. */
  private pathWithoutAlias(target: string): boolean {
    let current = target;
    while (true) {
      try { return fs.realpathSync.native(current).toLowerCase() === current.toLowerCase(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
      }
    }
  }

  private userCategory(filePath: string): ExclusionCategory | null {
    const target = path.resolve(filePath).toLowerCase();
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.type === "extension" && path.extname(target) === rule.value) return { reason: "extension", detail: rule.value };
      if (rule.type === "file" && target === rule.value.toLowerCase() && this.pathWithoutAlias(target)) return { reason: "path" };
      if (rule.type === "folder" && matchesPathBoundary(target, rule.value) && this.pathWithoutAlias(target)) return { reason: "path" };
    }
    return null;
  }

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

    if (this.userCategory(filePath)) return true;

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
    if (this.userCategory(filePath)) return "Exclusão do utilizador; ficheiro não analisado.";

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
    const user = this.userCategory(filePath);
    if (user) return user;

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

  public getConfig(): ExclusionConfig & {rules: ExclusionRule[]; error?: string} {
    return { paths: [...this.config.paths], extensions: [...this.config.extensions], files: [...this.config.files],
      rules: this.rules.map(rule => ({...rule})), ...(this.readError ? {error: this.readError} : {}) };
  }
}
