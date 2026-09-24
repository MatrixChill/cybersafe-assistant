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
      "Get-NetFirewallProfile -ErrorAction SilentlyContinue | Select-Object Name,Enabled | ConvertTo-Json -Compress",
    ].join("\n"),
  },
};

export interface PowerShellResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
  timedOut?: boolean;
}

export class PowerShellExecutor {
  private running = new Set<ChildProcess>();

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

    return new Promise<PowerShellResult<T>>((resolve) => {
      const child = spawn("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `${PS_UTF8_PREFIX}\n${def.script}`,
      ], { windowsHide: true });

      this.running.add(child);

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        this.running.delete(child);
        resolve({ ok: false, data: null, error: `PowerShell query '${query}' timed out`, timedOut: true });
      }, def.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(child);
        resolve({ ok: false, data: null, error: `PowerShell spawn error: ${err.message}` });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(child);
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
    });
  }

  /** Termina quaisquer processos PowerShell ainda em execução (ex.: no encerramento). */
  killAll() {
    for (const child of this.running) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.running.clear();
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
  const res = await exec.run<Array<{ Name?: string; Enabled?: boolean }>>("firewallProfiles");
  if (!res.ok || !res.data) {
    return { enabled: false, profiles: [], available: false };
  }
  const profiles = res.data.map((raw) => ({
    name: String(raw?.Name || "unknown"),
    enabled: raw?.Enabled !== false,
  }));
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
