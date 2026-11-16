import type { ServiceResponseMap } from "@cybersafe/shared-types";

type Snapshot = {
  protection: ServiceResponseMap["protection.getState"];
  scans: ServiceResponseMap["scan.history"];
  events: ServiceResponseMap["events.list"];
  hardware: ServiceResponseMap["hardware.snapshot"];
};

const engineStates = new Set(["active", "degraded", "unavailable", "error"]);
const engineReasons = new Set(["not-installed", "no-definitions", "exec-failed", "starting"]);
const protectionStates = new Set(["safe", "attention", "critical", "degraded"]);
const scanStates = new Set(["completed", "cancelled", "failed"]);
const alertTypes = new Set(["threat.detected", "quarantine.added", "quarantine.failed", "process.blocked"]);
const alertSeverities = new Set(["low", "medium", "high", "critical"]);

function known(value: string | undefined, values: Set<string>) {
  return value !== undefined && values.has(value) ? value : null;
}

function timestamp(value: string | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function count(value: number | undefined) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function identifier(value: string | undefined) {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(value) ? value : null;
}

function percent(value: number | null | undefined, status: string | undefined) {
  return status === "available" && typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= 100 ? value : null;
}

/** Bounded read-only process view for the authenticated local shell client.
 * Keep producer freshness: cached rows after failure are never called current.
 * Command lines, executable paths and account names stay inside the service.
 */
export function projectNigorProcesses(result: ServiceResponseMap["processes.list"]) {
  const nonnegative = (value: number) => Number.isFinite(value) && value >= 0 ? value : null;
  const epoch = (value: number | null) => {
    if (value === null || !Number.isFinite(value)) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  return {
    version: 1,
    state: known(result.truth.state, new Set(["never", "in-progress", "ok", "failed", "unreported"])),
    servedFrom: known(result.truth.servedFrom, new Set(["snapshot", "cache"])),
    enumeratedAt: epoch(result.truth.enumeratedAt),
    total: result.processes.length,
    processes: result.processes.slice(0, 50).map((process) => ({
      pid: count(process.pid),
      name: process.name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 128),
      cpuPercent: nonnegative(process.cpu),
      memoryMb: nonnegative(process.memoryMb),
    })),
  };
}

export function projectNigorStatus({ protection, scans, events, hardware }: Snapshot) {
  const { engine } = protection;
  const history = scans.entries.slice(0, 5).map((scan) => ({
    id: identifier(scan.id),
    status: known(scan.status, scanStates),
    endedAt: timestamp(scan.endedAt),
    filesAnalyzed: count(scan.filesAnalyzed),
    filesFailed: count(scan.filesFailed),
    filesInconclusive: count(scan.filesInconclusive),
    threatsFound: count(scan.threatsFound),
  }));

  return {
    version: 1,
    serviceRunning: engine.serviceRunning === true,
    protection: {
      status: known(protection.status, protectionStates),
      enabled: typeof protection.protectionEnabled === "boolean" ? protection.protectionEnabled : null,
    },
    // Additive v1 capability facts; no filenames, root paths or invented
    // percentage. A file watch is post-write, never a permission gate.
    monitoring: {
      mode: "post-write",
      preventionConfirmed: false,
      queueDepth: count(engine.realtimeQueueDepth),
      rootCount: Array.isArray(engine.monitoredPaths) ? engine.monitoredPaths.length : null,
    },
    engines: {
      clamav: known(engine.clamav?.status, engineStates),
      yara: known(engine.yara?.status, engineStates),
      hashDb: known(engine.hashDb?.status, engineStates),
      native: known(engine.nativeEngine?.status, engineStates),
    },
    // Aditivo (v1): motivo estruturado de um motor não ativo, quando o serviço
    // o envia (≥ esta versão). `null` = sem motivo reportado, nunca «saudável».
    engineReasons: {
      clamav: known(engine.clamav?.reason, engineReasons),
      yara: known(engine.yara?.reason, engineReasons),
      hashDb: known(engine.hashDb?.reason, engineReasons),
      native: known(engine.nativeEngine?.reason, engineReasons),
    },
    latestScan: history[0] ?? null,
    history,
    // O replay chega do mais antigo para o mais recente: os alertas são os
    // cinco MAIS RECENTES (antes eram os cinco mais antigos da janela).
    alerts: events.filter(({ type }) => alertTypes.has(type)).reverse().slice(0, 5).map((event) => ({
      id: identifier(event.id),
      scanId: identifier(event.scanId),
      type: event.type,
      severity: known(event.severity, alertSeverities),
      timestamp: timestamp(event.timestamp),
    })),
    // Aditivo (v1): os alertas vêm do registo de eventos em memória do serviço
    // (desde o seu arranque). O histórico de análises é persistente; por isso
    // `latestScan.threatsFound > 0` com `alerts` vazio não é contradição.
    alertsScope: "service-session",
    metrics: {
      cpuPercent: percent(hardware.cpu.usage, hardware.cpu.usageStatus),
      ramPercent: percent(hardware.ram.usagePercent, hardware.ram.usageStatus),
    },
  };
}
