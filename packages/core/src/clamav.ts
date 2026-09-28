import { exec, execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import type { EngineSubsystemHealth } from "@cybersafe/shared-types";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ClamavScanResult {
  detected: boolean;
  status: EngineSubsystemHealth;
}

export interface ClamavBridgeOptions {
  /**
   * Directório da base de assinaturas quando o chamador já o conhece.
   * Tem a prioridade máxima — é o `--datadir` passado ao `clamscan`.
   */
  datadir?: string;
  /** Override do directório de definições gerido pela app (default `<home>/.cybersafe-service/definitions`). */
  definitionsDir?: string;
  /** Envelhecimento máximo aceite nas assinaturas. Default: 7 dias. */
  maxSignatureAgeMs?: number;
}

export type ClamavDbSource = "explicit" | "app-definitions" | "clamconf" | "platform-default";
export type ClamavDbState = "missing" | "unreadable" | "empty" | "ready";

/** Um directório candidato onde a base de assinaturas pode viver. */
export interface ClamavDbCandidate {
  dir: string;
  source: ClamavDbSource;
  /** `missing` = não existe; `unreadable` = existe mas não se lê; `empty` = existe sem assinaturas. */
  state: ClamavDbState;
  signatureFiles: string[];
  /** mtime do ficheiro de assinaturas mais recente; 0 quando desconhecido. */
  newestMtimeMs: number;
  error?: string;
}

export interface ClamavProbeFacts {
  /** stdout de `clamscan --version`; null quando o comando falhou/não existe. */
  versionOutput: string | null;
  versionError?: string;
  /** Database directory resolvido do `clamconf -n` (null = desconhecido). */
  dbDir: string | null;
  /** Ficheiros do diretório; null = ilegível/inexistente. */
  dbFiles: string[] | null;
  /**
   * Candidatos já sondados. Quando presente tem precedência sobre
   * `dbDir`/`dbFiles`, que se mantêm para compatibilidade.
   */
  candidates?: ClamavDbCandidate[];
  /** Instante de referência para a frescura; default Date.now(). */
  now?: number;
  /** Idade máxima aceite das assinaturas. */
  maxSignatureAgeMs?: number;
}

const DB_FILE_PATTERN = /\.(cvd|cld|cuv|cud)$/i;

/** Definições com mais de 7 dias estão mortas na prática (o ClamAV actualiza daily). */
export const SIGNATURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Directório onde a app mantém a SUA base (ver service/src/updater.ts: freshclam --datadir). */
export function appClamavDatabaseDir(definitionsDir?: string): string {
  const base = definitionsDir ?? path.join(os.homedir(), ".cybersafe-service", "definitions");
  return path.join(base, "clamav");
}

/** Localização padrão da plataforma, usada como último recurso. */
export function platformClamavDatabaseDir(): string | null {
  if (process.platform === "win32") {
    const programData = process.env.ProgramData;
    return programData ? path.join(programData, "clamav") : null;
  }
  return "/var/lib/clamav";
}

function ageInDays(ms: number): number {
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function isSignatureFile(name: string): boolean {
  return DB_FILE_PATTERN.test(name);
}

/**
 * Escolhe o directório de assinaturas a usar.
 *
 * Regra de verdade: **sem ficheiros .cvd/.cld/.cuv/.cud não há deteção
 * real** — o binário responder não chega. O primeiro candidato `ready` vence;
 * na falta dele escolhe-se o mais informativo para o diagnóstico
 * (`unreadable` > `empty` > `missing`).
 */
export function selectDatabaseCandidate(candidates: ClamavDbCandidate[]): ClamavDbCandidate | null {
  const ready = candidates.find((c) => c.state === "ready");
  if (ready) return ready;
  const unreadable = candidates.find((c) => c.state === "unreadable");
  if (unreadable) return unreadable;
  const empty = candidates.find((c) => c.state === "empty");
  if (empty) return empty;
  return candidates[0] ?? null;
}

/** Classificação por candidatos — o caminho usado pelo probe real. */
function classifyWithCandidates(facts: ClamavProbeFacts): { available: boolean; health: EngineSubsystemHealth } {
  const now = facts.now ?? Date.now();
  const maxAge = facts.maxSignatureAgeMs ?? SIGNATURE_MAX_AGE_MS;
  const candidates = facts.candidates ?? [];

  if (candidates.length === 0) {
    return {
      available: false,
      health: {
        status: "degraded",
        detail: "ClamAV instalado mas nenhum directório de base de assinaturas pôde ser resolvido",
      },
    };
  }

  const chosen = selectDatabaseCandidate(candidates);
  if (!chosen) {
    return {
      available: false,
      health: { status: "degraded", detail: "ClamAV instalado mas sem directório de base de assinaturas" },
    };
  }

  if (chosen.state === "unreadable") {
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV instalado mas a base de assinaturas não é legível: ${chosen.dir} (${chosen.error ?? "permissões"})`,
      },
    };
  }

  if (chosen.state !== "ready") {
    // `empty` (o directório existe mas está sem assinaturas) ou `missing`.
    const tried = candidates.map((c) => c.dir).join(", ");
    const because = chosen.state === "empty" ? "existe mas está vazio" : "não existe";
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV instalado mas sem base de assinaturas — ${chosen.dir} ${because} (verificados: ${tried}); corre freshclam`,
      },
    };
  }

  // `ready`: só é `active` se houver ficheiros de assinatura E não estiverem
  // envelhecidos. `ready` com zero ficheiros é tratado como `empty` — active
  // exige assinaturas, sempre.
  const count = chosen.signatureFiles.filter(isSignatureFile).length;
  if (count === 0) {
    const tried = candidates.map((c) => c.dir).join(", ");
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV instalado mas sem base de assinaturas — ${chosen.dir} não tem ficheiros .cvd/.cld (verificados: ${tried}); corre freshclam`,
      },
    };
  }
  if (chosen.newestMtimeMs > 0 && now - chosen.newestMtimeMs > maxAge) {
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV com ${count} signature database file(s) em ${chosen.dir} mas as definições têm ${ageInDays(now - chosen.newestMtimeMs)} dia(s) — corra freshclam`,
      },
    };
  }

  return {
    available: true,
    health: { status: "active", detail: `ClamAV binary available (${count} signature database file(s))` },
  };
}

/**
 * Classificação pura do health do ClamAV. Regra de verdade: **sem base de
 * assinaturas não há deteção real** — o binário responder (`clamscan
 * --version`) não chega; é preciso encontrar .cvd/.cld no database dir.
 * Nunca devolve `active` sem definições.
 *
 * `dbDir`/`dbFiles` são o formato legado; `candidates` (com frescura por
 * ficheiro) tem precedência quando presente.
 */
export function classifyClamavHealth(facts: ClamavProbeFacts): { available: boolean; health: EngineSubsystemHealth } {
  if (facts.versionOutput === null) {
    return {
      available: false,
      health: { status: "unavailable", detail: `clamscan not found or failed: ${facts.versionError ?? "unknown"}` },
    };
  }
  if (!facts.versionOutput.includes("ClamAV")) {
    return { available: false, health: { status: "unavailable", detail: "clamscan --version did not report ClamAV" } };
  }
  if (facts.candidates) {
    return classifyWithCandidates(facts);
  }
  if (!facts.dbDir) {
    return {
      available: false,
      health: { status: "degraded", detail: "ClamAV binary available but database directory is unknown (check clamconf)" },
    };
  }
  if (facts.dbFiles === null) {
    return {
      available: false,
      health: { status: "degraded", detail: `ClamAV installed but database dir not readable: ${facts.dbDir} (run freshclam)` },
    };
  }
  const dbs = facts.dbFiles.filter((entry) => DB_FILE_PATTERN.test(entry));
  if (dbs.length === 0) {
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV instalado mas sem base de assinaturas (${facts.dbDir}) — corre freshclam`,
      },
    };
  }
  return {
    available: true,
    health: { status: "active", detail: `ClamAV binary available (${dbs.length} signature database file(s))` },
  };
}

function firstLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

/**
 * Sonda um directório candidato. Nunca lança: qualquer falha de I/O vira um
 * estado (`missing`/`unreadable`) em vez de uma excepção.
 */
export async function probeDatabaseDir(dir: string, source: ClamavDbSource): Promise<ClamavDbCandidate> {
  const base: ClamavDbCandidate = { dir, source, state: "missing", signatureFiles: [], newestMtimeMs: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    const code = err?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return { ...base, state: "unreadable", error: code ?? String(err?.message ?? err) };
    }
    return base;
  }

  const signatureFiles: string[] = [];
  let newestMtimeMs = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isSignatureFile(entry.name)) continue;
    signatureFiles.push(entry.name);
    // mtime só para frescura; uma falha aqui não invalida a assinatura.
    try {
      const info = await stat(path.join(dir, entry.name));
      if (info.mtimeMs > newestMtimeMs) newestMtimeMs = info.mtimeMs;
    } catch {
      /* mtime desconhecido ⇒ frescura não avaliada */
    }
  }

  return {
    dir,
    source,
    state: signatureFiles.length > 0 ? "ready" : "empty",
    signatureFiles,
    newestMtimeMs,
  };
}

export class ClamavBridge {
  private _health: EngineSubsystemHealth = { status: "unavailable", detail: "Not checked" };
  private probePromise: Promise<boolean> | null = null;
  private _dbDir: string | null = null;
  /** Há assinaturas num directório sondado — mesmo que velhas. */
  private _hasSignatures = false;

  constructor(private readonly options: ClamavBridgeOptions = {}) {}

  get health(): EngineSubsystemHealth {
    return this._health;
  }

  /** Directório de assinaturas que o `clamscan` vai usar (null se nenhum). */
  get datadir(): string | null {
    return this._dbDir;
  }

  /**
   * Verifica binário **e** definições (base de assinaturas). Resultado em
   * cache; `force=true` re-executa o probe (ex.: depois de correr freshclam).
   */
  async isAvailable(force = false): Promise<boolean> {
    if (this.probePromise && !force) return this.probePromise;
    this.probePromise = this.probe();
    return this.probePromise;
  }

  private async probe(): Promise<boolean> {
    let versionOutput: string | null = null;
    let versionError: string | undefined;
    try {
      versionOutput = (await execAsync("clamscan --version", { timeout: 5_000, windowsHide: true })).stdout;
    } catch (err: any) {
      versionError = err?.message;
    }

    let candidates: ClamavDbCandidate[] | undefined;
    if (versionOutput) {
      candidates = await this.collectDatabaseCandidates();
    }

    const outcome = classifyClamavHealth({
      versionOutput,
      versionError,
      dbDir: candidates?.[0]?.dir ?? null,
      dbFiles: null,
      candidates,
    });

    const chosen = candidates ? selectDatabaseCandidate(candidates) : null;
    this._dbDir = chosen?.dir ?? null;
    this._hasSignatures = chosen?.state === "ready";
    this._health = outcome.health;
    return outcome.available;
  }

  /**
   * Candidatos, por ordem de autoridade.
   *
   * O ponto crítico: o `freshclam` da CyberSafe descarrega as definições para
   * `<definitions>/clamav` (`service/src/updater.ts`), que **não** é
   * necessariamente o directório que o `clamconf` reporta. Consultar só o
   * `clamconf` fazia um ClamAV correctamente instalado e populado parecer
   * degradado para sempre. Por isso a base da app é candidata de primeira
   * classe e o `clamconf` é apenas mais uma fonte.
   */
  private async collectDatabaseCandidates(): Promise<ClamavDbCandidate[]> {
    const wanted: Array<{ dir: string; source: ClamavDbSource }> = [];

    if (this.options.datadir) {
      wanted.push({ dir: this.options.datadir, source: "explicit" });
    }
    wanted.push({ dir: appClamavDatabaseDir(this.options.definitionsDir), source: "app-definitions" });
    for (const dir of await this.clamconfDatabaseDirs()) {
      wanted.push({ dir, source: "clamconf" });
    }
    const platformDir = platformClamavDatabaseDir();
    if (platformDir) {
      wanted.push({ dir: platformDir, source: "platform-default" });
    }

    // Dedupe por path (case-insensitive no Windows) mantendo a primeira
    // ocorrência, que é a de maior autoridade.
    const seen = new Set<string>();
    const unique = wanted.filter((entry) => {
      const key = process.platform === "win32" ? entry.dir.toLowerCase() : entry.dir;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return Promise.all(unique.map((entry) => probeDatabaseDir(entry.dir, entry.source)));
  }

  /**
   * Todos os `Database directory:` que o `clamconf` reporta.
   *
   * O `clamconf` pode listar mais do que um (avisa quando `freshclam.conf` e
   * `clamd.conf` divergem). Ler só a primeira linha descartava bases válidas.
   */
  private async clamconfDatabaseDirs(): Promise<string[]> {
    try {
      const { stdout } = await execAsync("clamconf -n", { timeout: 8_000, windowsHide: true });
      const dirs: string[] = [];
      for (const entry of stdout.split(/\r?\n/)) {
        if (!/^\s*Database directory:/i.test(entry)) continue;
        const value = entry
          .split(":")
          .slice(1)
          .join(":")
          .trim()
          .replace(/^"|"$/g, "");
        if (value) dirs.push(value);
      }
      return dirs;
    } catch {
      // Sem clamconf continuamos com a base da app e o padrão da plataforma —
      // degradado, nunca "active" por omissão.
      return [];
    }
  }

  /**
   * Executa clamscan num ficheiro. Só com base de assinaturas real; caso
   * contrário reporta o estado em vez de simular proteção.
   *
   * Duas correções que só a sondagem real revelou:
   *  - A opção é `--database=DIR` (o clamscan aceita explicitamente um
   *    directório). `--datadir` é opção do **freshclam**; o clamscan
   *    aborta com "unrecognized option" — a base da app nunca seria usada.
   *  - O código de saída chega em `error.code` (não em `error.status`), pelo
   *    que comparar `status === 1` nunca detectava uma infeção: o clamscan
   *    devolvia 1 e nós reportávamos `detected: false`. Falso negativo.
   */
  async scanFile(filePath: string): Promise<ClamavScanResult> {
    await this.isAvailable();
    if (!this._hasSignatures) {
      return { detected: false, status: this._health };
    }
    const datadir = this._dbDir;

    try {
      // execFile com array de argumentos: o filePath nunca passa por shell.
      const args = ["--no-summary"];
      if (datadir) args.push(`--database=${datadir}`);
      args.push(filePath);
      await execFileAsync("clamscan", args, { timeout: 10000, windowsHide: true });
      return { detected: false, status: this._health };
    } catch (error: any) {
      // execAsync/execFileAsync rejectam com `code` = exit code; `status` só
      // existe nalguns caminhos. Lemos ambos e normalizamos.
      const exitCode = Number(error?.code ?? error?.status);
      if (exitCode === 1) {
        return { detected: true, status: this._health };
      }
      if (error?.code === "ENOENT") {
        this._health = { status: "unavailable", detail: "clamscan não encontrado" };
        return { detected: false, status: this._health };
      }
      if (exitCode === 2) {
        // Erro de carregamento da base (cl_load) — quase sempre a base errada
        // ou corrompida. Diagnóstico explícito, nunca "active".
        this._health = {
          status: "degraded",
          detail: `clamscan não conseguiu carregar a base${datadir ? ` (${datadir})` : ""}: ${
            firstLine(error?.stderr) || `exit ${exitCode}`
          }`,
        };
        return { detected: false, status: this._health };
      }
      this._health = { status: "degraded", detail: `clamscan exit ${exitCode || error?.message || "unknown"}` };
      return { detected: false, status: this._health };
    }
  }
}
