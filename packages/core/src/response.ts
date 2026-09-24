import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { AnalysisResult, ProcessKillProtectionReason, QuarantineEntry, KillProcessResult } from "@cybersafe/shared-types";

export class QuarantineManager {
  private readonly quarantineDir: string;
  private readonly manifestPath: string;
  private entries = new Map<string, QuarantineEntry>();

  constructor(baseDir: string) {
    this.quarantineDir = path.join(baseDir, "quarantine");
    this.manifestPath = path.join(this.quarantineDir, "manifest.json");
  }

  async init() {
    await fs.mkdir(this.quarantineDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as QuarantineEntry[];
      this.entries = new Map(parsed.map((entry) => [entry.id, entry]));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  private async flush() {
    await fs.writeFile(
      this.manifestPath,
      JSON.stringify(Array.from(this.entries.values()), null, 2),
      "utf-8",
    );
  }

  async quarantine(analysis: AnalysisResult): Promise<QuarantineEntry | null> {
    try {
      const id = crypto.randomUUID();
      const quarantinePath = path.join(this.quarantineDir, `${id}.quarantine`);
      await fs.rename(analysis.artifactPath, quarantinePath);
      // Remove all permissions to prevent execution
      await fs.chmod(quarantinePath, 0o000);
      const entry: QuarantineEntry = {
        id,
        originalPath: analysis.artifactPath,
        quarantinePath,
        fileName: analysis.fileName,
        sha256: analysis.sha256,
        verdict: analysis.verdict,
        riskScore: analysis.riskScore,
        quarantinedAt: new Date().toISOString(),
      };
      this.entries.set(id, entry);
      await this.flush();
      return entry;
    } catch {
      return null;
    }
  }

  async restore(id: string, restoredBy = "user"): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;

    try {
      await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });
      await fs.rename(entry.quarantinePath, entry.originalPath);
      entry.restoredAt = new Date().toISOString();
      entry.restoredBy = restoredBy;
      this.entries.delete(id);
      await this.flush();
      return true;
    } catch {
      return false;
    }
  }

  async delete(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    try {
      await fs.rm(entry.quarantinePath, { force: true });
      this.entries.delete(id);
      await this.flush();
      return true;
    } catch {
      return false;
    }
  }

  list(): QuarantineEntry[] {
    return Array.from(this.entries.values()).sort((a, b) =>
      b.quarantinedAt.localeCompare(a.quarantinedAt),
    );
  }
}

/** Prazo máximo para o `taskkill` terminar antes de ser abortado. */
export const TASKKILL_TIMEOUT_MS = 10_000;
/** Intervalo entre verificações de desaparecimento do PID. */
export const KILL_REAP_INTERVAL_MS = 150;
/** Prazo máximo à espera de que o PID desapareça depois do taskkill. */
export const KILL_REAP_DEADLINE_MS = 5_000;

export interface TaskkillResult {
  /** `taskkill` saiu com sucesso (código 0). Não garante que o PID já desapareceu. */
  ok: boolean;
  status: "ok" | "not-found" | "timeout" | "failed";
  exitCode: number | null;
  error?: string;
}

export interface KillProcessTreeOptions {
  timeoutMs?: number;
  /** Seam de teste: substitui o `spawn` real. */
  spawnImpl?: typeof spawn;
}

/**
 * Corre `taskkill /T /F` com **prazo real**: se o utilitário não terminar dentro
 * de `timeoutMs`, o processo filho é morto e o resultado é `timeout`. Nunca
 * rejeita e nunca fica pendente — é isto que impede um pedido de kill de ficar
 * preso à espera para sempre.
 */
export async function killProcessTree(pid: number, options?: KillProcessTreeOptions): Promise<KillProcessResult> {
  const timeoutMs = options?.timeoutMs ?? TASKKILL_TIMEOUT_MS;
  const spawnFn = options?.spawnImpl ?? spawn;

  let child: ChildProcess;
  try {
    child = spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, status: "failed", pid, error: (err as Error).message, exitCode: undefined };
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({ ok: false, status: "timeout", pid, exitCode: undefined });
    }, timeoutMs);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, status: "ok", pid, exitCode: 0 });
      } else if (code === 128) {
        resolve({ ok: false, status: "not-found", pid, exitCode: 128 });
      } else {
        resolve({ ok: false, status: "failed", pid, exitCode: code ?? undefined });
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, status: "failed", pid, error: err.message, exitCode: undefined });
    });
  });
}

/** `process.kill(pid, 0)` não envia sinal — só diz se o PID ainda existe. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = existe, mas não temos permissão para o sinalizar.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface KillTargetInfo {
  pid: number;
  ppid?: number;
  name?: string;
  path?: string;
  commandLine?: string;
}

export interface KillProtectionContext {
  /** PID do próprio serviço (nunca pode ser terminado). */
  selfPid: number;
  /** Ancestrais do serviço (processo pai e cadeia acima). */
  ancestorPids: readonly number[];
  /** Caminhos normalizados exatos de executáveis internos. */
  internalPaths: readonly string[];
  /** Prefixos de diretório ligados ao runtime/projeto/app (ex.: pasta do serviço). */
  internalPathPrefixes?: readonly string[];
  /** Marcadores de commandLine ligados ao runtime/projeto/app (ex.: "cybersafe"). */
  commandLineMarkers?: readonly string[];
  /** Nomes usados **apenas** quando não há PID/ppid/path fiáveis. */
  fallbackNames: readonly string[];
  /** PIDs de sistema (<= limiar) sempre protegidos. */
  systemPidThreshold?: number;
}

/** Normaliza caminhos para comparação (case-insensitive, sem prefixo \\?\). */
export function normalizeProcessPath(value: string | undefined | null): string {
  if (!value) return "";
  let normalized = value.trim().replace(/\//g, "\\");
  if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  return normalized.toLowerCase();
}

/** Identidade estável o suficiente para detetar PID reuse (nome + linha de comando). */
export function killTargetIdentity(target: Pick<KillTargetInfo, "name" | "commandLine">): string {
  return `${(target.name ?? "").toLowerCase()}|${(target.commandLine ?? "").trim()}`;
}

/**
 * Decide se um alvo de kill está protegido. A identidade é resolvida por PID e
 * ppid (serviço/ancestrais/filhos internos), depois por caminho de executável
 * interno; o **nome é só fallback**, e apenas quando não há caminho fiável.
 */
export function classifyKillTarget(
  target: KillTargetInfo,
  context: KillProtectionContext,
): ProcessKillProtectionReason | null {
  const { pid } = target;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  // 1. O próprio serviço — por PID, nunca por nome.
  if (context.selfPid > 0 && pid === context.selfPid) return "self";

  // 2. PIDs de sistema (kernel/idle/SMSS e afins).
  const threshold = context.systemPidThreshold ?? 0;
  if (threshold > 0 && pid <= threshold) return "system-pid";

  // 3. Ancestrais do serviço — por PID.
  if (context.ancestorPids.includes(pid)) return "ancestor";

  // 4. Componentes internos — por ppid (filhos do serviço/ancestral) ou caminho.
  const ppid = target.ppid;
  if (ppid && ppid > 0 && (ppid === context.selfPid || context.ancestorPids.includes(ppid))) {
    return "internal";
  }
  const targetPath = normalizeProcessPath(target.path);
  if (targetPath) {
    if (context.internalPaths.includes(targetPath)) return "internal";
    for (const prefix of context.internalPathPrefixes ?? []) {
      if (!prefix) continue;
      const boundary = prefix.endsWith("\\") ? prefix : `${prefix}\\`;
      if (targetPath === prefix || targetPath.startsWith(boundary)) return "internal";
    }
  }

  // 5. Componentes internos pela linha de comando: node/electron/powershell só
  //    quando a linha liga ao runtime/projeto/app — nunca o executável em si.
  const commandLine = normalizeProcessPath(target.commandLine);
  if (commandLine && (context.commandLineMarkers ?? []).some((marker) => marker && commandLine.includes(marker))) {
    return "internal";
  }

  // 6. Nomes SÓ como fallback, quando não há caminho fiável.
  const name = (target.name ?? "").toLowerCase();
  if (!targetPath && name && context.fallbackNames.includes(name)) return "fallback-name";

  return null;
}

export type ReconcileKillStatus = "exited" | "reused" | "still-running";

export interface ProcessProbe {
  alive: boolean;
  identity?: string;
}

export interface ReconcileKillOptions {
  pid: number;
  /** Identidade do alvo capturada ANTES do kill; se mudar, o PID foi reutilizado. */
  originalIdentity?: string;
  probe: (pid: number) => ProcessProbe | Promise<ProcessProbe>;
  deadlineMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reconciliação autoritativa: só declara `exited` quando o PID desaparece. Se o
 * PID continuar vivo com outra identidade, é reutilização (`reused`) — nunca é
 * tratado como sucesso. Termina sempre (nunca fica pendente).
 */
export async function reconcileProcessExit(options: ReconcileKillOptions): Promise<{ status: ReconcileKillStatus }> {
  const deadlineMs = options.deadlineMs ?? KILL_REAP_DEADLINE_MS;
  const intervalMs = Math.max(1, options.intervalMs ?? KILL_REAP_INTERVAL_MS);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  // Limite de tentativas garante terminação mesmo com relógio injetado.
  const maxAttempts = Math.max(1, Math.ceil(deadlineMs / intervalMs) + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const probe = await options.probe(options.pid);
    if (!probe.alive) return { status: "exited" };
    if (probe.identity && options.originalIdentity && probe.identity !== options.originalIdentity) {
      return { status: "reused" };
    }
    if (now() - startedAt >= deadlineMs) return { status: "still-running" };
    await sleep(intervalMs);
  }
  return { status: "still-running" };
}
