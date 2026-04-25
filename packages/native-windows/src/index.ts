import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import chokidar, { type FSWatcher } from "chokidar";
import * as si from "systeminformation";
import type { ConnectionSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";

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

  getDefaultPaths() {
    const home = os.homedir();
    return [
      path.join(home, "Downloads"),
      os.tmpdir(),
      path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    ];
  }

  async start(paths = this.getDefaultPaths()) {
    this.watcher = chokidar.watch(paths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 750,
        pollInterval: 100,
      },
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

    await this.captureRegistrySnapshot();
    this.registryTimer = setInterval(() => {
      void this.captureRegistrySnapshot();
    }, 5_000);
  }

  private async captureRegistrySnapshot() {
    const snapshot = await readRegistryRunKeys();
    if (this.lastRegistrySnapshot && this.lastRegistrySnapshot !== snapshot) {
      this.emit("registry.persistence.changed", {
        kind: "registry.persistence.changed",
        path: "HKCU/HKLM Run keys",
        observedAt: new Date().toISOString(),
      });
    }
    this.lastRegistrySnapshot = snapshot;
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
  }
}

export class ProcessMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private previous = new Map<number, ProcessSnapshot>();

  async start() {
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, 3_000);
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
  }
}

export async function snapshotProcesses(): Promise<Map<number, ProcessSnapshot>> {
  const map = new Map<number, ProcessSnapshot>();
  
  try {
    const processes = await si.processes();
    const now = new Date().toISOString();

    for (const processInfo of processes.list.slice(0, 500)) {
      const pid = Number(processInfo.pid);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      map.set(pid, {
        pid,
        ppid: Number((processInfo as any).parentPid ?? 0),
        name: processInfo.name ?? `pid-${pid}`,
        path: (processInfo as any).path ?? "",
        commandLine: (processInfo as any).command ?? "",
        user: processInfo.user,
        cpu: Math.round((processInfo.cpu ?? 0) * 10) / 10,
        memoryMb: Math.round(((processInfo.memRss ?? 0) / 1024)),
        startedAt: now,
        signer: undefined,
        trusted: "neutral",
      });
    }
  } catch (err) {
    console.error("[ProcessMonitor] Falha ao coletar processos do S.O:", err);
  }

  return map;
}

export async function snapshotConnections(): Promise<ConnectionSnapshot[]> {
  try {
    const connections = await si.networkConnections();
    return connections.slice(0, 200).map((connection: any) => ({
      processPid: connection.pid,
      remoteAddress: connection.peeraddress || connection.peeraddr || "unknown",
      remotePort: connection.peerport,
      protocol: connection.protocol,
      state: connection.state,
      direction: "outbound",
      observedAt: new Date().toISOString(),
    }));
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
