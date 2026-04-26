import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import chokidar from "chokidar";
import * as si from "systeminformation";
export class NativeWindowsWatcher extends EventEmitter {
    watcher = null;
    registryTimer = null;
    lastRegistrySnapshot = "";
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
    async captureRegistrySnapshot() {
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
    timer = null;
    previous = new Map();
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
    async list() {
        return Array.from((await snapshotProcesses()).values());
    }
    async poll() {
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
export async function snapshotProcesses() {
    const map = new Map();
    try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        // No Windows, usamos PowerShell para obter a linha de comando completa, já que o wmic está depreciado
        const { stdout } = await execAsync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | ConvertTo-Csv -NoTypeInformation"');
        const lines = stdout.split('\n').filter(line => line.trim() !== "" && line.includes(","));
        const now = new Date().toISOString();
        for (let i = 1; i < lines.length; i++) {
            // O CSV do PowerShell pode conter aspas, vamos limpá-las
            const line = lines[i].replace(/"/g, '');
            const parts = line.split(',');
            if (parts.length < 3)
                continue;
            const pid = parseInt(parts[0] || "0");
            const name = parts[1] || "";
            const commandLine = parts.slice(2).join(',') || ""; // O comando pode conter vírgulas
            if (!Number.isFinite(pid) || pid <= 0)
                continue;
            map.set(pid, {
                pid,
                ppid: 0, // WMIC csv format here doesn't include parentPid by default
                name: name || `pid-${pid}`,
                path: "", // Path is harder to get in this specific wmic format without extra cols
                commandLine,
                user: "unknown",
                cpu: 0,
                memoryMb: 0,
                startedAt: now,
                signer: undefined,
                trusted: "neutral",
            });
        }
        // Fallback ou complemento com systeminformation para CPU/Memória
        const siProcesses = await si.processes();
        for (const p of siProcesses.list) {
            const existing = map.get(Number(p.pid));
            if (existing) {
                existing.cpu = Math.round((p.cpu ?? 0) * 10) / 10;
                existing.memoryMb = Math.round(((p.memRss ?? 0) / 1024));
                existing.path = p.path || existing.path;
                existing.ppid = Number(p.parentPid || 0);
                existing.user = p.user || existing.user;
            }
        }
    }
    catch (err) {
        console.error("[ProcessMonitor] Falha ao coletar processos do S.O:", err);
    }
    return map;
}
export async function snapshotConnections() {
    try {
        const connections = await si.networkConnections();
        return connections.slice(0, 200).map((connection) => ({
            processPid: connection.pid,
            remoteAddress: connection.peeraddress || connection.peeraddr || "unknown",
            remotePort: connection.peerport,
            protocol: connection.protocol,
            state: connection.state,
            direction: "outbound",
            observedAt: new Date().toISOString(),
        }));
    }
    catch {
        return [];
    }
}
export async function terminateProcessTree(pid) {
    return new Promise((resolve) => {
        const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
        });
        child.on("exit", (code) => resolve(code === 0));
        child.on("error", () => resolve(false));
    });
}
async function readRegistryRunKeys() {
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
