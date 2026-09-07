import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import * as si from "systeminformation";
import type { ConnectionSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";

export * from "./wfp-filter.js";
export * from "./amsi-provider.js";
export * from "./etw-consumer.js";
export * from "./powershell.js";
import { WindowsHealthEngine } from "./powershell.js";

export interface FileObservation {
  kind: "file.created" | "file.modified" | "file.renamed";
  path: string;
  observedAt: string;
}

export interface PersistenceObservation {
  kind: "registry.persistence.changed" | "scheduledtask.changed";
  path: string;
  observedAt: string;
  value?: string;
}

export interface NativeWindowsWatcherEvents {
  "file.created": (event: FileObservation) => void;
  "file.modified": (event: FileObservation) => void;
  "file.renamed": (event: FileObservation) => void;
  "registry.persistence.changed": (event: PersistenceObservation) => void;
  "scheduledtask.changed": (event: PersistenceObservation) => void;
}

export class NativeWindowsWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private registryTimer: NodeJS.Timeout | null = null;
  private lastRegistrySnapshot = "";
  private validatedPaths: string[] = [];

  getDefaultPaths() {
    const home = os.homedir();
    return [
      path.join(home, "Downloads"),
      path.join(home, "Desktop"),
      path.join(home, "Documents"),
      os.tmpdir(),
      path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    ];
  }

  /**
   * Validates and filters paths to only include those that are accessible.
   * Logs detailed information about paths that fail validation.
   */
  private async validateAndFilterPaths(paths: string[]): Promise<string[]> {
    const validPaths: string[] = [];
    const invalidPaths: Array<{ path: string; reason: string }> = [];

    for (const p of paths) {
      try {
        // Check if path exists and is accessible
        await fs.access(p, fs.constants.R_OK);
        validPaths.push(p);
        console.log(`[NativeWindowsWatcher] Path validated: ${p}`);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        let reason = "Unknown error";

        if (err.code === "ENOENT") {
          reason = "Path does not exist";
        } else if (err.code === "EACCES" || err.code === "EPERM") {
          reason = `Permission denied (${err.code})`;
        } else {
          reason = `Error: ${err.code || err.message}`;
        }

        invalidPaths.push({ path: p, reason });
        console.warn(
          `[NativeWindowsWatcher] Path validation failed: ${p} - ${reason}`
        );
      }
    }

    if (validPaths.length === 0 && paths.length > 0) {
      const failedList = invalidPaths.map((ip) => `  - ${ip.path} (${ip.reason})`).join("\n");
      console.error(
        `[NativeWindowsWatcher] CRITICAL: All ${paths.length} paths failed validation:\n${failedList}`
      );
    } else if (invalidPaths.length > 0) {
      console.warn(
        `[NativeWindowsWatcher] Proceeding with ${validPaths.length}/${paths.length} paths. Skipped paths:`
      );
      for (const ip of invalidPaths) {
        console.warn(`  - ${ip.path} (${ip.reason})`);
      }
    }

    return validPaths;
  }

  async start(paths = this.getDefaultPaths()): Promise<void> {
    // Validate and filter paths before creating watcher
    this.validatedPaths = await this.validateAndFilterPaths(paths);

    if (this.validatedPaths.length === 0) {
      throw new Error(
        "[NativeWindowsWatcher] Cannot start watcher: no accessible paths available"
      );
    }

    // Excludes os.tmpdir from scanning to avoid extreme churn in Temp
    // (browsers/installers constantly create .tmp files). Keeps watching
    // persistence-heavy paths without the CPU cost of a temp temp dir.
    const tmpDir = os.tmpdir();

    this.watcher = chokidar.watch(this.validatedPaths, {
      persistent: true,
      ignoreInitial: true,
      ignored: [
        /(^|[\/\\])\../, // ignore hidden files
        /node_modules/, // ignore node_modules
        /\.log$/, // ignore log files
        /cybersafe-assistant[\/\\]logs/, // specific ignore for app logs
        // Event-driven native watching (no 100ms polling); large files only
        // considered "finished" after 3s of no writes.
        (p: string) => p.startsWith(tmpDir),
      ],
      awaitWriteFinish: {
        stabilityThreshold: 3000,
        pollInterval: 2000,
      },
    });

    // Add error handler to catch any runtime watch errors
    this.watcher.on("error", (error) => {
      console.error(`[NativeWindowsWatcher] Watch error:`, error);
      // Emit as internal event for diagnostics but don't crash
      this.emit("watcher.error", { error, timestamp: new Date().toISOString() });
    });

    this.watcher
      .on("add", (entryPath) => this.emit("file.created", {
        kind: "file.created",
        path: entryPath,
        observedAt: new Date().toISOString(),
      }))
      .on("change", (entryPath) => this.emit("file.modified", {
        kind: "file.modified",
        path: entryPath,
        observedAt: new Date().toISOString(),
      }))
      .on("unlink", (entryPath) => this.emit("file.renamed", {
        kind: "file.renamed",
        path: entryPath,
        observedAt: new Date().toISOString(),
      }));

    console.log(
      `[NativeWindowsWatcher] File watcher started on ${this.validatedPaths.length} paths`
    );

    await this.captureRegistrySnapshot();
    this.registryTimer = setInterval(() => {
      void this.captureRegistrySnapshot();
    }, 30_000);
  }

  private registryInFlight = false;

  private async captureRegistrySnapshot() {
    if (this.registryInFlight) return;
    this.registryInFlight = true;
    try {
      const snapshot = await readRegistryRunKeys();
      if (this.lastRegistrySnapshot && this.lastRegistrySnapshot !== snapshot) {
        this.emit("registry.persistence.changed", {
          kind: "registry.persistence.changed",
          path: "HKCU/HKLM Run keys",
          observedAt: new Date().toISOString(),
        });
      }
      this.lastRegistrySnapshot = snapshot;
    } finally {
      this.registryInFlight = false;
    }
  }

  async stop() {
    if (this.registryTimer) {
      clearInterval(this.registryTimer);
      this.registryTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.validatedPaths = [];
    console.log("[NativeWindowsWatcher] File watcher stopped");
  }
}

export class ProcessMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private previous = new Map<number, ProcessSnapshot>();
  private pollInFlight = false;

  async start() {
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, 10_000);
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async list(): Promise<ProcessSnapshot[]> {
    return Array.from((await snapshotProcesses()).values());
  }

  private async poll() {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const current = await snapshotProcesses();

      for (const [pid, processInfo] of current.entries()) {
        if (!this.previous.has(pid)) {
          this.emit("process.started", processInfo);
        }
      }

      for (const [pid, processInfo] of this.previous.entries()) {
        if (!current.has(pid)) {
          this.emit("process.exited", processInfo);
        }
      }

      this.previous = current;
    } finally {
      this.pollInFlight = false;
    }
  }
}

export async function snapshotProcesses(): Promise<Map<number, ProcessSnapshot>> {
  const map = new Map<number, ProcessSnapshot>();

  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    // Saída JSON (a versão CSV anterior partia campos com vírgulas e gerava dados corrompidos).
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress"',
      { windowsHide: true }
    );
    const rows = JSON.parse(stdout.trim());
    const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? [rows] : [];
    const now = new Date().toISOString();

    for (const raw of list) {
      const pid = parseInt(raw.ProcessId, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;

      map.set(pid, {
        pid,
        ppid: 0,
        name: String(raw.Name || `pid-${pid}`),
        path: "",
        commandLine: String(raw.CommandLine || ""),
        user: undefined,
        cpu: 0,
        memoryMb: 0,
        startedAt: now,
        signer: undefined,
        trusted: "neutral",
      });
    }

    // Complemento com systeminformation para CPU/Memória
    const siProcesses = await si.processes();
    for (const p of siProcesses.list) {
      const existing = map.get(Number(p.pid));
      if (existing) {
        existing.cpu = Math.round((p.cpu ?? 0) * 10) / 10;
        existing.memoryMb = Math.round((p.memRss ?? 0) / 1024);
        existing.path = (p as any).path || existing.path;
        existing.ppid = Number((p as any).parentPid || 0);
        existing.user = p.user || existing.user;
      }
    }
  } catch (err) {
    console.error("[ProcessMonitor] Falha ao coletar processos do S.O:", err);
  }

  return map;
}

export async function snapshotConnections(): Promise<ConnectionSnapshot[]> {
  try {
    // No Windows, systeminformation depende do netstat em inglês e falha em locales
    // como o português. Usa Get-NetTCPConnection (estável em qualquer locale).
    const engine = new WindowsHealthEngine();
    const res = await engine.executor.run<Array<{
      LocalAddress?: string;
      LocalPort?: number;
      RemoteAddress?: string;
      RemotePort?: number;
      State?: string;
      OwningProcess?: number;
    }>>("tcpConnections");

    if (!res.ok || !res.data) return [];

    const seen = new Set<string>();
    const result: ConnectionSnapshot[] = [];
    for (const raw of res.data) {
      const localAddress = String(raw.LocalAddress || "0.0.0.0");
      const localPort = Number(raw.LocalPort) || 0;
      const remoteAddress = String(raw.RemoteAddress || "");
      const remotePort = Number(raw.RemotePort) || 0;
      const state = String(raw.State || "unknown");
      const key = `${localAddress}:${localPort}:${remoteAddress}:${remotePort}:${state}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isListening = remoteAddress === "" || remoteAddress === "0.0.0.0" || remoteAddress === "::" || state === "Listen";
      result.push({
        processPid: (raw.OwningProcess && raw.OwningProcess > 0) ? raw.OwningProcess : undefined,
        remoteAddress: isListening ? localAddress : remoteAddress,
        remotePort: isListening ? localPort : remotePort,
        protocol: "tcp",
        state,
        direction: isListening ? "inbound" : "outbound",
        observedAt: new Date().toISOString(),
      });
      if (result.length >= 200) break;
    }
    return result;
  } catch {
    return [];
  }
}

export async function terminateProcessTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function readRegistryRunKeys(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-Command",
      "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' | ConvertTo-Json -Compress",
    ], { windowsHide: true });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("exit", () => resolve(stdout.trim()));
    child.on("error", () => resolve(""));
  });
}
