import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type {
  WindowsDiskInfo,
  WindowsFirewallState,
  WindowsHealthSnapshot,
  WindowsServiceInfo,
  WindowsSystemInfo,
  WindowsTcpConnection,
  WindowsTopProcess,
  WindowsUserInfo,
} from "@cybersafe/shared-types";
import {
  buildWindowsHealthSnapshot,
  type WindowsHealthInput,
} from "./windows-health-logic.js";

/**
 * PowerShell Windows Layer (READ-ONLY).
 *
 * Camada segura que executa APENAS consultas PowerShell fixas e allowlistadas
 * definidas internamente pelo CyberSafe. NUNCA aceita comandos arbitrários
 * vindos da UI ou de qualquer chamador externo.
 *
 * Todas as operações são de leitura (Get-*). Nenhuma funcionalidade destrutiva
 * (matar processo, alterar firewall/registo/serviços, etc.) é exposta.
 */

/** Identificadores de consultas allowlistadas. Valores fixos, nunca vindos de input. */
export type PowerShellQuery =
  | "systemInfo"
  | "topProcessesByCpu"
  | "topProcessesByRam"
  | "services"
  | "tcpConnections"
  | "localUsers"
  | "disks"
  | "firewallProfiles";

interface QueryDefinition {
  /** Comando PowerShell fixo. Não contém nenhuma interpolação com input do utilizador. */
  script: string;
  /** Timeout em ms específico por consulta. */
  timeoutMs: number;
}

const ENABLED_ON_WINDOWS = process.platform === "win32";

/** Força saída UTF-8 a partir do PowerShell 5.1 (evita mojibake em texto acentuado). */
const PS_UTF8_PREFIX = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;";

// Apenas scripts fixos, escritos pelo CyberSafe. Sem inputs dinâmicos.
const QUERIES: Record<PowerShellQuery, QueryDefinition> = {
  systemInfo: {
    timeoutMs: 15000,
    script: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$cs = Get-CimInstance Win32_OperatingSystem",
      "$csys = Get-CimInstance Win32_ComputerSystem",
      "$pf = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum",
      "[PSCustomObject]@{",
      "  osName = $cs.Caption",
      "  osVersion = $cs.Version",
      "  osBuild = $cs.BuildNumber",
      "  manufacturer = $csys.Manufacturer",
      "  model = $csys.Model",
      "  architecture = $env:PROCESSOR_ARCHITECTURE",
      "  totalRamBytes = $cs.TotalVisibleMemorySize * 1KB",
      "  freeRamBytes = $cs.FreePhysicalMemory * 1KB",
      "  logicalProcessors = $pf",
      "} | ConvertTo-Json -Compress",
    ].join("\n"),
  },
  topProcessesByCpu: {
    timeoutMs: 20000,
    script: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors",
      "if (-not $cores -or $cores -eq 0) { $cores = 1 }",
      "$before = @{}",
      "Get-CimInstance Win32_Process | ForEach-Object { $before[$_.ProcessId] = ($_.KernelModeTime + $_.UserModeTime) }",
      "Start-Sleep -Milliseconds 900",
      "Get-CimInstance Win32_Process | ForEach-Object {",
      "  $p = $_",
      "  $prev = $before[$p.ProcessId]",
      "  $delta = ($p.KernelModeTime + $p.UserModeTime) - $prev",
      "  if ($delta -lt 0) { $delta = 0 }",
      "  $cpuPercent = [math]::Round((($delta / 10000) / (1000 * $cores)) * 100, 1)",
      "  [PSCustomObject]@{",
      "    ProcessId = $p.ProcessId",
      "    Name = $p.Name",
      "    WorkingSet = $p.WorkingSetSize",
      "    ExecutablePath = $p.ExecutablePath",
      "    CpuPercent = $cpuPercent",
      "  }",
      "} | Sort-Object CpuPercent -Descending | Select-Object -First 8 | ForEach-Object {",
      "  $_ | Add-Member -NotePropertyName User -NotePropertyValue (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.ProcessId) | Invoke-CimMethod -MethodName GetOwner -ErrorAction SilentlyContinue).User",
      "  $_",
      "} | ConvertTo-Json -Compress",
    ].join("\n"),
  },
  topProcessesByRam: {
    timeoutMs: 15000,
    script: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Get-CimInstance Win32_Process | ForEach-Object {",
      "  $p = $_",
      "  [PSCustomObject]@{",
      "    ProcessId = $p.ProcessId",
      "    Name = $p.Name",
      "    WorkingSet = $p.WorkingSetSize",
      "    ExecutablePath = $p.ExecutablePath",
      "    CpuPercent = 0",
      "  }",
      "} | Sort-Object WorkingSet -Descending | Select-Object -First 8 | ForEach-Object {",
      "  $_ | Add-Member -NotePropertyName User -NotePropertyValue (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.ProcessId) | Invoke-CimMethod -MethodName GetOwner -ErrorAction SilentlyContinue).User",
      "  $_",
      "} | ConvertTo-Json -Compress",
    ].join("\n"),
  },
  services: {
    timeoutMs: 15000,
    script: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,ProcessId | ConvertTo-Json -Compress",
    ].join("\n"),
  },
  tcpConnections: {
    timeoutMs: 15000,
    script: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Get-NetTCPConnection -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess | ConvertTo-Json -Compress",
    ].join("\n"),
  },
  localUsers: {
    timeoutMs: 15000,
    script: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Get-LocalUser -ErrorAction SilentlyContinue | Select-Object Name,FullName,Enabled | ConvertTo-Json -Compress",
    ].join("\n"),
  },
  disks: {
    timeoutMs: 15000,
    script: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem | ConvertTo-Json -Compress",
    ].join("\n"),
  },
  firewallProfiles: {
    timeoutMs: 15000,
    script: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Get-NetFirewallProfile -ErrorAction SilentlyContinue | Select-Object Name,@{Name='Enabled';Expression={ if ($_.Enabled -eq 1) { $true } elseif ($_.Enabled -eq 0) { $false } else { $null } }} | ConvertTo-Json -Compress",
    ].join("\n"),
  },
};

export interface PowerShellResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
  timedOut?: boolean;
}

// Shared by all executor instances in THIS Node process. Opaque third-party
// providers and other processes are deliberately not claimed to be covered.
const sharedWaiting: PowerShellExecutor[] = [];
const queryClock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
const sharedQueryMetrics: Record<string, { submitted:number; started:number; timeouts:number; queueTimeouts:number; closed:number; queueMs:number; runMs:number }> = {};
let sharedOwned = 0;
let sharedDraining = false;
const SHARED_QUERY_LIMIT = 2;
const SHARED_QUEUE_LIMIT = 64;
const sharedStats = { submitted: 0, deduplicated: 0, started: 0, closed: 0, timedOut: 0, rejected: 0, peak: 0 };
export function powerShellAdmissionSnapshot() {
  return { ...sharedStats, byQuery:Object.fromEntries(Object.entries(sharedQueryMetrics).map(([k,v])=>[k,{...v}])), active: sharedOwned, queued: sharedWaiting.reduce((n, e) => n + e.waitingCount, 0), limit: SHARED_QUERY_LIMIT, queueLimit: SHARED_QUEUE_LIMIT, scope: "PowerShellExecutor instances in this Node process" };
}

export class PowerShellExecutor {
  private running = new Map<ChildProcess, () => void>();
  private pending = new Map<PowerShellQuery, Promise<PowerShellResult<unknown>>>();
  private queue: Array<{ start: () => void; cancel: () => void; interactive:boolean; queuedAt:number }> = [];
  private disposed = false;
  // Bound the eight-query snapshot burst independently of destructive RPCs.
  private readonly maxConcurrent = 2;

  get waitingCount(): number { return this.queue.length; }

  private drain(): void {
    if (!this.disposed && this.queue.length && !sharedWaiting.includes(this)) sharedWaiting.push(this);
    if (sharedDraining) return;
    sharedDraining = true;
    try {
      while (sharedOwned < SHARED_QUERY_LIMIT && sharedWaiting.length) {
        const aged = sharedWaiting.findIndex(e => e.queue.length && queryClock()-e.queue[0].queuedAt >= 1000);
        const preferred = sharedWaiting.findIndex(e => e.queue.some(q => q.interactive));
        const next = sharedWaiting.splice(aged >= 0 ? aged : Math.max(0,preferred),1)[0];
        if (next.disposed || !next.queue.length) continue;
        if (next.running.size >= next.maxConcurrent) { sharedWaiting.push(next); break; }
        const priority = queryClock()-next.queue[0].queuedAt >= 1000 ? 0 : Math.max(0,next.queue.findIndex(q=>q.interactive));
        next.queue.splice(priority,1)[0].start();
        // Round-robin owners: one busy health collector cannot monopolise the queue.
        if (!next.disposed && next.queue.length && !sharedWaiting.includes(next)) sharedWaiting.push(next);
      }
    } finally { sharedDraining = false; }
  }

  /**
   * Executa uma consulta allowlistada fixa. NÃO aceita comandos arbitrários.
   * @throws se chamado fora do Windows (o chamador deve tratar com falha graciosa).
   */
  async run<T>(query: PowerShellQuery): Promise<PowerShellResult<T>> {
    if (!ENABLED_ON_WINDOWS) {
      return { ok: false, data: null, error: "PowerShell layer is only available on Windows" };
    }

    const def = QUERIES[query];
    if (!def) {
      return { ok: false, data: null, error: `Unknown whitelisted query: ${String(query)}` };
    }

    if (this.disposed) return { ok: false, data: null, error: "PowerShell executor disposed" };
    const existing = this.pending.get(query);
    if (existing) { sharedStats.deduplicated++; return existing as Promise<PowerShellResult<T>>; }
    if (sharedWaiting.reduce((n, e) => n + e.waitingCount, 0) >= SHARED_QUEUE_LIMIT) {
      sharedStats.rejected++;
      return { ok: false, data: null, error: "Shared PowerShell read queue is full" };
    }
    sharedStats.submitted++;

    const submittedAt = queryClock();
    const metric = sharedQueryMetrics[query] ??= {submitted:0,started:0,timeouts:0,queueTimeouts:0,closed:0,queueMs:0,runMs:0};
    metric.submitted++;
    const deadline = submittedAt + def.timeoutMs;
    let resolveResult!: (result: PowerShellResult<T>) => void;
    const result = new Promise<PowerShellResult<T>>(resolve => { resolveResult = resolve; });
    this.pending.set(query, result);
    const cancelled = (): PowerShellResult<T> => ({ ok: false, data: null, error: "PowerShell executor disposed" });
    const queued = {
      interactive: query === "tcpConnections" || query === "systemInfo",
      queuedAt:submittedAt,
      cancel: () => {
        clearTimeout(queueTimer);
        this.pending.delete(query);
        resolveResult(cancelled());
      },
      start: () => {
      clearTimeout(queueTimer);
      if (queryClock() >= deadline) {
        sharedStats.timedOut++;
        metric.queueTimeouts++;
        this.pending.delete(query);
        resolveResult({ ok: false, data: null, timedOut: true, error: "PowerShell query budget expired before spawn" });
        return;
      }
      let child: ChildProcess;
      const startedAt = queryClock();
      metric.started++;
      metric.queueMs += startedAt-submittedAt;
      sharedOwned++;
      sharedStats.started++;
      sharedStats.peak = Math.max(sharedStats.peak, sharedOwned);
      try {
        child = spawn("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `${PS_UTF8_PREFIX}\n${def.script}`,
      ], { windowsHide: true });
      } catch (error) {
        sharedOwned--;
        this.pending.delete(query);
        resolveResult({ ok: false, data: null, error: `PowerShell spawn error: ${String(error)}` });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const resolve = (value: PowerShellResult<T>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult(value);
      };
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.running.delete(child);
        sharedOwned--;
        sharedStats.closed++;
        metric.closed++;
        metric.runMs += queryClock()-startedAt;
        this.pending.delete(query);
        this.drain();
      };

      const timer = setTimeout(() => {
        if (settled) return;
        sharedStats.timedOut++;
        metric.timeouts++;
        resolve({ ok: false, data: null, error: `PowerShell query '${query}' timed out`, timedOut: true });
        // A kill request is not proof of exit. Retain ownership and the slot
        // until close, preventing replacement children piling up on failure.
        try { child.kill(); } catch { /* retained for disposal */ }
      }, Math.max(1, deadline - queryClock()));

      this.running.set(child, () => {
        resolve(cancelled());
        try { child.kill(); } catch { /* still owned until close */ }
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (!settled) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!settled) stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        resolve({ ok: false, data: null, error: `PowerShell spawn error: ${err.message}` });
        // Failed spawn has no live process. Other errors still await close.
        if (child.pid === undefined) release();
      });
      child.on("close", (code) => {
        release();
        if (settled) return;
        try {
          if (code !== 0 && !stdout.trim()) {
            resolve({ ok: false, data: null, error: stderr.trim() || `PowerShell exited with code ${code}` });
            return;
          }
          const data = JSON.parse(stdout.trim()) as T;
          resolve({ ok: true, data });
        } catch (err) {
          resolve({ ok: false, data: null, error: `Failed to parse PowerShell JSON output: ${String(err)}` });
        }
      });
    } };
    // Waiting and execution share the original per-query budget. No child
    // starts if capacity remains stuck; neither timeout nor retry is enlarged.
    const queueTimer = setTimeout(() => {
      const index = this.queue.indexOf(queued);
      if (index < 0) return;
      this.queue.splice(index, 1);
      if (!this.queue.length) { const owner = sharedWaiting.indexOf(this); if (owner >= 0) sharedWaiting.splice(owner, 1); }
      sharedStats.timedOut++;
      metric.queueTimeouts++;
      this.pending.delete(query);
      resolveResult({ ok: false, data: null, error: `PowerShell query '${query}' queue timed out`, timedOut: true });
    }, def.timeoutMs);
    this.queue.push(queued);
    this.drain();
    return result;
  }

  /** Termina quaisquer processos PowerShell ainda em execução (ex.: no encerramento). */
  killAll() {
    if (this.disposed) return;
    this.disposed = true;
    const owner = sharedWaiting.indexOf(this);
    if (owner >= 0) sharedWaiting.splice(owner, 1);
    for (const entry of this.queue.splice(0)) entry.cancel();
    for (const cancel of this.running.values()) cancel();
  }
}

/**
 * Converte a lista de processos de CPU/RAM para o formato WindowsTopProcess,
 * guardando contra campos ausentes/enviados pelo que o PowerShell não fornece.
 *
 * Nota de unidades: Win32_Process.WorkingSetSize vem em BYTES (empiricamente
 * verificado). Dividimos por 1024² para obter MB. O "System Idle Process"
 * (PID 0 / System Idle Process) NÃO é consumo real — representa CPU ociosa,
 * por isso é excluído dos rankings de consumidores.
 */
export function normalizeTopProcesses(input: unknown): WindowsTopProcess[] {
  const arr = Array.isArray(input) ? input : input && typeof input === "object" ? [input] : [];
  return arr
    .filter((raw: any) => {
      const pid = Number(raw?.ProcessId);
      const name = String(raw?.Name || "").toLowerCase();
      return Number.isFinite(pid) && pid > 0 && name !== "system idle process";
    })
    .map((raw: any) => ({
      pid: Number(raw?.ProcessId) || 0,
      name: String(raw?.Name || "unknown"),
      cpuPercent: Number(raw?.CpuPercent) || 0,
      memoryMb: Math.round(Number(raw?.WorkingSet) / 1024 / 1024) || 0,
      path: String(raw?.ExecutablePath || ""),
      user: String(raw?.User || "unknown"),
    }));
}

async function runSystemInfo(exec: PowerShellExecutor): Promise<WindowsSystemInfo> {
  const res = await exec.run<{
    osName?: string;
    osVersion?: string;
    osBuild?: string;
    manufacturer?: string;
    model?: string;
    architecture?: string;
    totalRamBytes?: number;
    freeRamBytes?: number;
  }>("systemInfo");

  if (!res.ok || !res.data) {
    return {
      osName: "unknown",
      osVersion: "unknown",
      osBuild: "unknown",
      manufacturer: "unknown",
      model: "unknown",
      architecture: "unknown",
      totalRamGb: 0,
      availableRamGb: 0,
      ramUsagePercent: 0,
      available: false,
    };
  }

  const d = res.data;
  const totalGb = (d.totalRamBytes || 0) / (1024 ** 3);
  const freeGb = (d.freeRamBytes || 0) / (1024 ** 3);
  const usage = totalGb > 0 ? Math.round(((totalGb - freeGb) / totalGb) * 100) : 0;

  return {
    osName: d.osName || "unknown",
    osVersion: d.osVersion || "unknown",
    osBuild: d.osBuild || "unknown",
    manufacturer: d.manufacturer || "unknown",
    model: d.model || "unknown",
    architecture: d.architecture || "unknown",
    totalRamGb: Math.round(totalGb * 10) / 10,
    availableRamGb: Math.round(freeGb * 10) / 10,
    ramUsagePercent: usage,
    available: true,
  };
}

const SERVICE_STATES: Record<string, string> = {
  Running: "running",
  Stopped: "stopped",
  "Start Pending": "startPending",
  "Stop Pending": "stopPending",
};

async function runServices(exec: PowerShellExecutor): Promise<WindowsServiceInfo[]> {
  const res = await exec.run<Array<{
    Name?: string;
    DisplayName?: string;
    State?: string;
    StartMode?: string;
    ProcessId?: number;
  }>>("services");
  if (!res.ok || !res.data) return [];
  return res.data.map((raw) => ({
    name: String(raw?.Name || "unknown"),
    displayName: String(raw?.DisplayName || raw?.Name || "unknown"),
    status: SERVICE_STATES[String(raw?.State)] || String(raw?.State || "unknown"),
    startType: String(raw?.StartMode || "unknown"),
    running: raw?.ProcessId ? true : raw?.State === "Running",
  }));
}

async function runTcpConnections(exec: PowerShellExecutor): Promise<WindowsTcpConnection[]> {
  const res = await exec.run<Array<{
    LocalAddress?: string;
    LocalPort?: number;
    RemoteAddress?: string;
    RemotePort?: number;
    State?: string;
    OwningProcess?: number;
  }>>("tcpConnections");
  if (!res.ok || !res.data) return [];

  const STATE_MAP: Record<string, string> = {
    "1": "Listen", "2": "SynSent", "3": "SynReceived", "4": "Established",
    "5": "FinWait1", "6": "FinWait2", "7": "CloseWait", "8": "Closing",
    "9": "LastAck", "10": "TimeWait", "11": "DeleteTCB", "12": "Bound",
  };
  const normalizeState = (raw: string): string => {
    if (!raw) return "Desconhecido";
    return STATE_MAP[raw] ?? raw;
  };

  const seen = new Set<string>();
  const result: WindowsTcpConnection[] = [];
  for (const raw of res.data) {
    const localAddress = String(raw?.LocalAddress || "0.0.0.0");
    const localPort = Number(raw?.LocalPort) || 0;
    const remoteAddress = String(raw?.RemoteAddress || "");
    const remotePort = Number(raw?.RemotePort) || 0;
    const state = normalizeState(String(raw?.State || ""));
    const key = `${localAddress}:${localPort}:${remoteAddress}:${remotePort}:${state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      localAddress,
      localPort,
      remoteAddress,
      remotePort,
      state,
      owningProcessPid: raw?.OwningProcess || null,
      owningProcessName: null,
    });
    if (result.length >= 50) break;
  }
  return result;
}

async function runLocalUsers(exec: PowerShellExecutor): Promise<WindowsUserInfo[]> {
  const res = await exec.run<Array<{ Name?: string; FullName?: string; Enabled?: boolean }>>("localUsers");
  if (!res.ok || !res.data) return [];
  return res.data.map((raw) => ({
    name: String(raw?.Name || "unknown"),
    fullName: String(raw?.FullName || ""),
    enabled: raw?.Enabled !== false,
    local: true,
  }));
}

async function runDisks(exec: PowerShellExecutor): Promise<WindowsDiskInfo[]> {
  const res = await exec.run<Array<{
    DeviceID?: string;
    VolumeName?: string;
    Size?: number;
    FreeSpace?: number;
    FileSystem?: string;
  }>>("disks");
  if (!res.ok || !res.data) return [];
  return res.data.map((raw) => {
    const sizeGb = Number(raw?.Size) / (1024 ** 3) || 0;
    const freeGb = Number(raw?.FreeSpace) / (1024 ** 3) || 0;
    const usedGb = Math.max(0, sizeGb - freeGb);
    const usagePercent = sizeGb > 0 ? Math.round((usedGb / sizeGb) * 100) : 0;
    return {
      deviceId: String(raw?.DeviceID || "unknown"),
      volumeName: String(raw?.VolumeName || ""),
      sizeGb: Math.round(sizeGb * 10) / 10,
      freeGb: Math.round(freeGb * 10) / 10,
      usedGb: Math.round(usedGb * 10) / 10,
      usagePercent,
      fileSystem: String(raw?.FileSystem || "unknown"),
    };
  });
}

async function runFirewall(exec: PowerShellExecutor): Promise<WindowsFirewallState> {
  const res = await exec.run<Array<{ Name?: string; Enabled?: unknown }>>("firewallProfiles");
  if (!res.ok || !Array.isArray(res.data)) {
    return { enabled: false, profiles: [], available: false };
  }
  const profiles: WindowsFirewallState["profiles"] = [];
  for (const raw of res.data) {
    const value = raw?.Enabled;
    let enabled: boolean;
    if (value === true || value === 1 || value === "True" || value === "true") {
      enabled = true;
    } else if (value === false || value === 0 || value === "False" || value === "false") {
      enabled = false;
    } else {
      // The shared contract represents unknown through available=false.
      // Do not publish an invented per-profile enabled/disabled state.
      return { enabled: false, profiles: [], available: false };
    }
    profiles.push({ name: String(raw?.Name || "unknown"), enabled });
  }
  const enabled = profiles.length > 0 ? profiles.every((p) => p.enabled) : false;
  return { enabled, profiles, available: profiles.length > 0 };
}

interface ProcessOwnerMap {
  [pid: number]: string;
}

async function resolveProcessOwners(
  exec: PowerShellExecutor,
  connections: WindowsTcpConnection[],
): Promise<WindowsTcpConnection[]> {
  const pids = connections.map((c) => c.owningProcessPid).filter((p): p is number => p != null);
  if (pids.length === 0) return connections;

  const owner: ProcessOwnerMap = {};
  const res = await exec.run<Array<{ ProcessId?: number; Name?: string }>>("topProcessesByRam").catch(() => null);
  if (res?.ok && res.data) {
    for (const p of res.data) {
      const pid = Number(p?.ProcessId);
      if (pid && p?.Name) owner[pid] = String(p.Name);
    }
  }
  return connections.map((c) =>
    c.owningProcessPid != null && owner[c.owningProcessPid]
      ? { ...c, owningProcessName: owner[c.owningProcessPid] }
      : c,
  );
}

export class WindowsHealthEngine {
  readonly executor = new PowerShellExecutor();
  private lastSnapshot: WindowsHealthSnapshot | null = null;
  private lastCollectedAt = 0;
  private readonly ttlMs = 30000;
  private inFlight: Promise<WindowsHealthSnapshot> | null = null;

  /**
   * Recolhe um snapshot completo de saúde do Windows (read-only).
   * Se uma consulta falhar (privilégio, cmdlet ausente), falhamos graciosamente
   * marcando o campo como indisponível e registando o erro em vez de falhar tudo.
   */
  async getSnapshot(): Promise<WindowsHealthSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collectSnapshot().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async collectSnapshot(): Promise<WindowsHealthSnapshot> {
    const errors: string[] = [];

    const [system, topCpuRaw, topRamRaw, services, tcp, users, disks, firewall] = await Promise.all([
      runSystemInfo(this.executor),
      this.executor.run<unknown>("topProcessesByCpu"),
      this.executor.run<unknown>("topProcessesByRam"),
      runServices(this.executor),
      runTcpConnections(this.executor),
      runLocalUsers(this.executor),
      runDisks(this.executor),
      runFirewall(this.executor),
    ]);

    for (const [label, r] of [
      ["systemInfo", { ok: system.available }],
      ["topProcessesByCpu", topCpuRaw],
      ["topProcessesByRam", topRamRaw],
      ["services", { ok: services.length > 0 }],
      ["tcpConnections", { ok: tcp.length > 0 }],
      ["localUsers", { ok: users.length > 0 }],
      ["disks", { ok: disks.length > 0 }],
      ["firewall", { ok: firewall.available }],
    ] as const) {
      if (!r.ok) {
        errors.push(`${label} unavailable`);
      }
    }

    const topCpu = normalizeTopProcesses(topCpuRaw.data);
    const topRam = normalizeTopProcesses(topRamRaw.data);
    const connections = await resolveProcessOwners(this.executor, tcp);

    const input: WindowsHealthInput = {
      system,
      topCpu,
      topRam,
      services,
      connections,
      users,
      disks,
      firewall,
    };

    return buildWindowsHealthSnapshot(input, new Date().toISOString(), errors);
  }

  /** Devolve o último snapshot em cache se ainda estiver dentro do TTL (evita chamadas pesadas repetidas). */
  async getCached(): Promise<WindowsHealthSnapshot> {
    if (this.lastSnapshot && Date.now() - this.lastCollectedAt < this.ttlMs) {
      return this.lastSnapshot;
    }
    const snapshot = await this.getSnapshot();
    this.lastSnapshot = snapshot;
    this.lastCollectedAt = Date.now();
    return snapshot;
  }

  getLastSnapshot() {
    return this.lastSnapshot;
  }

  async dispose() {
    this.executor.killAll();
  }
}
