#!/usr/bin/env node
/**
 * HARNESS DE CANCELAMENTO P1 — caminho SUPORTADO REAL: SERVICE + IPC.
 *
 * O rascunho anterior referenciava APIs inexistentes (`createClamavBatchEngine`,
 * `scanBatch`, `numberOfRunningScans`). Os contratos reais, verificados no
 * source antes de reescrever este ficheiro:
 *
 *   - Servico real: packages/service/dist/index.js (arranca e faz listen no
 *     PIPE_NAME de @cybersafe/core; protection fica OFF ate monitor.start).
 *   - IPC: newline-delimited JSON (core ipc.ts: encodeMessage/decodeMessages).
 *     request  -> { id, type:"request", method, payload }
 *     response -> { id, type:"response", ok, result|error }
 *     event    -> { type:"event", event }  (scan.progress com scanId no topo)
 *   - Comandos: "scan.start" { type, targetPath? } -> { id, success, error? }
 *               "scan.cancel" { id }               -> { success }
 *               "scan.getActive"                  -> ScanState | null
 *               "service.shutdown"                -> { success }
 *   - Cancelamento em profundidade: ScanManager.cancelScan -> markScanAborted +
 *     abortEngineWork -> signal abortado -> ClamAV abortado (kill da arvore
 *     clamscan). Terminal e' "cancelled" e e' IRREVERSIVEL (guarda terminal).
 *
 * O que este harness mede, com evidencia em disco:
 *   A-mid-batch : cancel enquanto o clamscan do SERVICO esta vivo (batch ativo).
 *   B-restart   : um NOVO scan depois do cancel deve arrancar de novo.
 *   C-pre-spawn : cancel imediato apos o ACK do start (janela pre-spawn).
 *   libertacao  : arvore clamscan do servico morta; zero orfaos; memoria do
 *                 servico antes/depois; estado terminal estavel (sem flip).
 *
 * NAO altera codigo de producao. So escreve em output/manual-retest/ e no
 * directorio temporario das fixtures.
 *
 * Uso:
 *   node scripts/scan-cancel-runtime-probe.mjs
 *   PROBE_FILES=3000 node scripts/scan-cancel-runtime-probe.mjs
 *   PROBE_TIMEOUT_MS=180000 node scripts/scan-cancel-runtime-probe.mjs
 *
 * Pre-condicoes: clamscan em PATH; PIPE LIVRE (se o pipe estiver a ser usado
 * por outra instancia, o harness ABORTA sem a tocar).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOG_DIR = path.join(ROOT, "output", "manual-retest");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const BASE = `scan-cancel-probe-${STAMP}`;
const LOG_PATH = path.join(LOG_DIR, `${BASE}.log`);
const JSON_PATH = path.join(LOG_DIR, `${BASE}.json`);

const core = await import(
  pathToFileURL(path.join(ROOT, "packages", "core", "dist", "index.js")).href
);
const { PIPE_NAME, encodeMessage, decodeMessages } = core;

const FILES = (() => {
  const raw = Number(process.env.PROBE_FILES ?? 1500);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
})();
const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 240_000);
const GRACE_MS = Number(process.env.PROBE_GRACE_MS ?? 5_000);
const STABILITY_MS = Number(process.env.PROBE_STABILITY_MS ?? 5_000);
const PIPE_WAIT_MS = Number(process.env.PROBE_PIPE_WAIT_MS ?? 90_000);
const KEEP_FIXTURES = process.env.PROBE_KEEP_FIXTURES === "1";
// PROBE_MODE=diag — reproducao PEQUENA E CONTROLADA do F2/F3 (ronda P0 rescue):
//   - estado REAL da protecao apos a ligacao ao pipe (auto-start em cada connect);
//   - RTT IPC continuo (protection.getState) para separar "event loop bloqueado"
//     de "fs lento" durante o loop de candidatos;
//   - duracao FILES_SELECTED -> PREFETCH_BEGIN (onde mora o ~3s/ficheiro);
//   - janela OFF confirmada (monitor.stop): eventos file.*, novos singlets
//     clamscan e estado protectionEnabled apos o ACK.
// Modo por omissao = cancel (cenarios A/B/C da ronda anterior).
const MODE = ["diag", "quick"].includes(process.env.PROBE_MODE) ? process.env.PROBE_MODE : "cancel";
const DIAG_FILES = (() => {
  const raw = Number(process.env.PROBE_FILES ?? 20);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
})();
const OFF_WINDOW_MS = Number(process.env.PROBE_OFF_WINDOW_MS ?? 20_000);
const SERVICE_ENTRY = path.join(ROOT, "packages", "service", "dist", "index.js");
// ENTRADA DEV SUPORTADA: `npm run dev:service` = `tsx watch src/index.ts`.
// O dist (node dist/index.js) esta' COMO CAIDO nesta maquina: dist/index.js
// importa "./signal-handlers" sem extensao e o Node ESM recusa (ver finding).
const SERVICE_SRC = path.join(ROOT, "packages", "service", "src", "index.ts");
const SERVICE_TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ── Log: tudo para memoria E para ficheiro (canal de saida protegido) ────────
const logLines = [];
/** Linhas de stdout/stderr do SERVICO com timestamp de rececao (modo diag). */
const serviceLines = [];
let logStream = null;
function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  logLines.push(entry);
  try {
    logStream?.write(entry + "\n");
  } catch {
    /* disco cheio nao pode matar o teste */
  }
}
const origLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a))).join(" ");
  log(line);
  origLog(line);
};
const origErr = console.error.bind(console);
console.error = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a))).join(" ");
  log(`[stderr] ${line}`);
  origErr(line);
};
function safeJson(v) {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// ── Pre-condicoes ────────────────────────────────────────────────────────────
function clamscanVersion() {
  try {
    const r = spawnSync("clamscan", ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
    return { ok: r.status === 0, version: String(r.stdout ?? "").trim().split("\n")[0] };
  } catch (e) {
    return { ok: false, version: String(e?.message ?? e) };
  }
}

function pipeInUse() {
  return new Promise((resolve) => {
    let done = false;
    const s = net.createConnection(PIPE_NAME, () => {
      done = true;
      s.destroy();
      resolve(true);
    });
    s.on("error", () => {
      if (!done) resolve(false);
    });
    setTimeout(() => {
      if (!done) {
        s.destroy();
        resolve(false);
      }
    }, 2000).unref?.();
  });
}

/**
 * Amostra de processos clamscan via CIM (assincrono — nunca bloquear o loop
 * enquanto o socket do pipe esta aberto).
 */
function listClamscan() {
  return new Promise((resolve) => {
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='clamscan.exe'\" | " +
      "ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.WorkingSetSize)\" }";
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, shell: false },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => resolve([]));
    child.on("close", () => {
      const rows = String(out)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [pid, ppid, ws] = l.split("|");
          const n = Number(pid);
          return Number.isFinite(n) && n > 0
            ? { pid: n, ppid: Number(ppid) || null, wsBytes: Number(ws) || 0 }
            : null;
        })
        .filter(Boolean);
      resolve(rows);
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve([]);
    }, 10_000).unref?.();
  });
}

async function serviceMemoryMb(pid) {
  return new Promise((resolve) => {
    const ps = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const bytes = Number(String(out).trim());
      resolve(Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : null);
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 8_000).unref?.();
  });
}

// ── Cliente IPC minimo (mesmo contrato de desktop/src/service-client.ts) ─────
class ProbeClient {
  constructor() {
    this.socket = null;
    this.buffer = "";
    this.pending = new Map();
    this.seq = 0;
    this.events = [];
    this.eventListeners = [];
    this.closed = false;
  }

  async connect(timeoutMs = 30_000) {
    const deadline = now() + timeoutMs;
    let lastErr = null;
    while (now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(PIPE_NAME, () => {
            this.socket = socket;
            resolve();
          });
          socket.on("data", (chunk) => this.handleData(chunk.toString()));
          socket.on("error", (err) => {
            if (this.socket === socket) this.handleClosed();
            reject(err);
          });
          socket.on("close", () => this.handleClosed());
          setTimeout(() => reject(new Error("connect timeout")), 3000).unref?.();
        });
        this.closed = false;
        return;
      } catch (e) {
        lastErr = e;
        await sleep(500);
      }
    }
    throw new Error(`pipe inacessivel: ${String(lastErr?.message ?? lastErr)}`);
  }

  handleClosed() {
    this.socket = null;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error("pipe fechado"));
    this.pending.clear();
  }

  handleData(chunk) {
    this.buffer += chunk;
    const decoded = decodeMessages(this.buffer);
    this.buffer = decoded.rest;
    for (const message of decoded.messages) {
      if (message?.type === "event" && message.event) {
        const record = { at: now(), iso: new Date().toISOString(), event: message.event };
        this.events.push(record);
        for (const fn of this.eventListeners) fn(record);
        continue;
      }
      if (message?.type === "response" && message.id) {
        const p = this.pending.get(message.id);
        if (!p) continue;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.ok) p.resolve(message.result);
        else p.reject(new Error(message.error ?? "request failed"));
      }
    }
  }

  request(method, payload, timeoutMs = 20_000) {
    if (!this.socket) return Promise.reject(new Error("nao ligado"));
    const id = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout em ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeMessage({ id, type: "request", method, payload }), (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  onEvent(fn) {
    this.eventListeners.push(fn);
  }

  disconnect() {
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client disconnect"));
    }
    this.pending.clear();
  }
}

// ── Fixtures benignas ────────────────────────────────────────────────────────
async function makeFixtures(count) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cybersafe-cancel-fixture-`));
  const payload = Buffer.from("CyberSafe benign cancel fixture. Nao e malware. ".repeat(24), "utf-8");
  const files = [];
  for (let i = 0; i < count; i++) {
    const p = path.join(dir, `f-${String(i).padStart(5, "0")}.txt`);
    await fsp.writeFile(p, Buffer.concat([payload, Buffer.from(`#${i}\n`)]));
    files.push(p);
  }
  return { dir, files };
}

// ── Helpers de scan ──────────────────────────────────────────────────────────
function scanEvents(client, scanId) {
  return client.events
    .filter((r) => r.event?.type === "scan.progress" && (r.event.scanId === scanId || r.event.data?.id === scanId))
    .map((r) => ({
      at: r.at,
      iso: r.iso,
      status: r.event.data?.status ?? null,
      phase: r.event.data?.phase ?? null,
      progress: r.event.data?.progress ?? null,
      filesScanned: r.event.data?.filesScanned ?? null,
      filesInEngineBatch: r.event.data?.filesInEngineBatch ?? null,
      revision: r.event.data?.revision ?? null,
    }));
}

async function waitFor(pred, timeoutMs, intervalMs = 200) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const v = await pred();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

async function startScanWithRetry(client, payload, retries = 10) {
  // Apos um cancel, o worker anterior ainda pode estar a fazer o finally
  // (o lock unico so liberta quando o worker assenta) — retry e registado.
  const attempts = [];
  for (let i = 0; i < retries; i++) {
    try {
      const res = await client.request("scan.start", payload, 15_000);
      if (res?.success && res.id) return { id: res.id, attempts, retriesUsed: i };
      attempts.push({ i, error: res?.error ?? "sem id" });
    } catch (e) {
      attempts.push({ i, error: String(e?.message ?? e) });
    }
    await sleep(1000);
  }
  return { id: null, attempts, retriesUsed: retries };
}

// ── Cenario ──────────────────────────────────────────────────────────────────
async function runScenario({ label, client, servicePid, baseline, fixtureDir, mode }) {
  const rec = {
    scenario: label,
    mode,
    files: FILES,
    startAttempts: null,
    scanId: null,
    tStart: null,
    tAck: null,
    tClamAlive: null,
    tCancel: null,
    tCancelAck: null,
    tTerminal: null,
    cancelAckSuccess: null,
    cancelAckError: null,
    abortToResolveMs: null,
    cancelToClamDeadMs: null,
    terminalStatus: null,
    terminalEvent: null,
    progressSeen: 0,
    statusTrail: [],
    clamOwnedAtCancel: [],
    clamOwnedAfterGrace: [],
    orphanNewAfterGrace: [],
    stabilityViolations: [],
    activeScanAfter: "unset",
    serviceMemMbBefore: null,
    serviceMemMbAfter: null,
    pass: false,
    failReasons: [],
  };

  rec.serviceMemMbBefore = await serviceMemoryMb(servicePid);
  rec.tStart = now();

  const started = await startScanWithRetry(client, { type: "custom", targetPath: fixtureDir });
  rec.startAttempts = started.attempts;
  if (!started.id) {
    rec.failReasons.push("scan.start recusado em todas as tentativas");
    console.log(`[${label}] FALHA: ${rec.failReasons.join("; ")}`);
    return rec;
  }
  rec.scanId = started.id;
  rec.tAck = now();
  console.log(`[${label}] scan.start ok id=${started.id} retries=${started.retriesUsed}`);

  // Armar o cancel assim que o clamscan DO SERVICO nascer (batch ativo).
  // Atribuição por parentesco do listener, incluindo filhos do launcher Windows.
  const ownedPids = new Set();
  const isOwned = (r) => {
    const owned = r.ppid === servicePid || ownedPids.has(r.ppid) || ownedPids.has(r.pid);
    if (owned) ownedPids.add(r.pid);
    return owned;
  };
  const armTimeout = mode === "C-pre-spawn" ? 0 : HARD_TIMEOUT_MS;
  if (mode === "C-pre-spawn") {
    rec.tCancel = now();
  } else {
    const armed = await waitFor(async () => {
      const rows = await listClamscan();
      const owned = rows.filter(isOwned);
      const running = scanEvents(client, rec.scanId).filter((e) => e.status === "running");
      const batchActive = running.at(-1)?.filesInEngineBatch > 0;
      if (owned.length > 0 && batchActive) {
        rec.clamOwnedAtCancel = owned.map((r) => `${r.pid}(pp=${r.ppid},${Math.round(r.wsBytes / 1048576)}MB)`);
        return true;
      }
      return false;
    }, armTimeout, 250);
    if (!armed) {
      rec.failReasons.push("clamscan do servico nunca ficou vivo (batch nao observado)");
      // Cancel defensivo para nao deixar scan a correr.
      try {
        await client.request("scan.cancel", { id: rec.scanId }, 10_000);
      } catch {
        /* ignore */
      }
      await sleep(1000);
      console.log(`[${label}] FALHA: batch ativo nunca observado`);
      return rec;
    }
    rec.tClamAlive = now();
    rec.tCancel = now();
  }

  // Cancel + espera do terminal "cancelled".
  try {
    const ack = await client.request("scan.cancel", { id: rec.scanId }, 15_000);
    rec.tCancelAck = now();
    rec.cancelAckSuccess = ack?.success ?? null;
  } catch (e) {
    rec.cancelAckError = String(e?.message ?? e);
    rec.failReasons.push(`scan.cancel falhou: ${rec.cancelAckError}`);
  }

  const terminalDeadline = now() + Math.min(HARD_TIMEOUT_MS, 60_000);
  let terminal = null;
  while (now() < terminalDeadline) {
    const evs = scanEvents(client, rec.scanId);
    terminal = evs.find((e) => e.status === "cancelled" || e.status === "completed" || e.status === "failed");
    if (terminal) break;
    await sleep(150);
  }
  if (terminal) {
    rec.tTerminal = terminal.at;
    rec.terminalStatus = terminal.status;
    rec.terminalEvent = terminal;
    rec.abortToResolveMs = rec.tTerminal - rec.tCancel;
  } else {
    rec.failReasons.push("sem estado terminal ate ao timeout");
  }
  if (rec.terminalStatus !== "cancelled") {
    rec.failReasons.push(`terminal inesperado: ${String(rec.terminalStatus)}`);
  }

  rec.progressSeen = scanEvents(client, rec.scanId).length;
  rec.statusTrail = [...new Set(scanEvents(client, rec.scanId).map((e) => e.status))];

  // Janela de GRACA: arvore clamscan deve morrer.
  const graceDeadline = now() + GRACE_MS;
  let clamDeadAt = null;
  while (now() < graceDeadline) {
    const rows = await listClamscan();
    const owned = rows.filter(isOwned);
    if (owned.length === 0) {
      if (clamDeadAt === null) clamDeadAt = now();
    } else if (clamDeadAt !== null) {
      clamDeadAt = null; // voltou a aparecer — conta como instabilidade
    }
    await sleep(300);
  }
  const rowsAfter = await listClamscan();
  rec.clamOwnedAfterGrace = rowsAfter.filter(isOwned).map((r) => `${r.pid}(pp=${r.ppid})`);
  rec.orphanNewAfterGrace = rowsAfter.filter((r) => !baseline.has(r.pid)).map((r) => `${r.pid}(${Math.round(r.wsBytes / 1048576)}MB)`);
  if (clamDeadAt !== null) rec.cancelToClamDeadMs = clamDeadAt - rec.tCancel;

  // Estabilidade terminal: nenhum evento posterior pode mudar o estado.
  const stabilityDeadline = now() + STABILITY_MS;
  while (now() < stabilityDeadline) {
    const evs = scanEvents(client, rec.scanId);
    const lastTerminalIdx = evs.map((e) => e.status).lastIndexOf(rec.terminalStatus);
    for (let i = lastTerminalIdx + 1; i < evs.length; i++) {
      const e = evs[i];
      if (e.status && e.status !== rec.terminalStatus) {
        rec.stabilityViolations.push({ at: e.at, status: e.status, revision: e.revision });
      }
    }
    await sleep(500);
  }

  // Estado activo: depois de terminal nao pode haver scan "running/queued".
  try {
    const active = await client.request("scan.getActive", undefined, 10_000);
    rec.activeScanAfter = active ? `${active.status}` : "null";
    if (active && (active.status === "running" || active.status === "queued")) {
      rec.failReasons.push(`scan.getActive ainda activo: ${active.status}`);
    }
  } catch (e) {
    rec.activeScanAfter = `erro:${String(e?.message ?? e)}`;
    rec.failReasons.push(`scan.getActive falhou: ${rec.activeScanAfter}`);
  }

  rec.serviceMemMbAfter = await serviceMemoryMb(servicePid);

  if (rec.clamOwnedAfterGrace.length > 0) rec.failReasons.push("clamscan do servico ainda vivo apos graça");
  if (rec.orphanNewAfterGrace.length > 0) rec.failReasons.push("clamscan orfaos novos detectados");
  if (rec.stabilityViolations.length > 0) rec.failReasons.push("estado terminal violado");
  if (rec.cancelAckSuccess !== true && !rec.cancelAckError) rec.failReasons.push("ack de cancel nao confirmado");

  rec.pass = rec.failReasons.length === 0;
  console.log(
    `[${label}] ${rec.pass ? "PASS" : "FAIL"} terminal=${rec.terminalStatus} abortToResolve=${rec.abortToResolveMs}ms ` +
      `clamDead=+${rec.cancelToClamDeadMs ?? "?"}ms orphans=${rec.orphanNewAfterGrace.length} ` +
      `stabilityViolations=${rec.stabilityViolations.length} active=${rec.activeScanAfter}` +
      (rec.failReasons.length ? ` motivos=${JSON.stringify(rec.failReasons)}` : ""),
  );
  return rec;
}

/**
 * O processo que faz listen no pipe pode NAO ser o filho directo que
 * lancamos: `tsx` (entrada dev) re-executa node num filho. Devolve o pid do
 * node que realmente serve o pipe, ou null se nao for determinavel.
 */
async function resolveServicePid(spawnedPid) {
  const rows = await new Promise((resolve) => {
    const ps =
      "Get-CimInstance Win32_Process | ForEach-Object { " +
      "\"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve([]));
    child.on("close", () => {
      resolve(
        String(out)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i1 = l.indexOf("\t");
            const i2 = i1 < 0 ? -1 : l.indexOf("\t", i1 + 1);
            const i3 = i2 < 0 ? -1 : l.indexOf("\t", i2 + 1);
            if (i1 < 0 || i2 < 0 || i3 < 0) return null;
            const pid = Number(l.slice(0, i1));
            return Number.isFinite(pid)
              ? { pid, ppid: Number(l.slice(i1 + 1, i2)) || null, name: l.slice(i2 + 1, i3), cmd: l.slice(i3 + 1) }
              : null;
          })
          .filter(Boolean),
      );
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve([]);
    }, 20_000).unref?.();
  });

  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const self = byPid.get(spawnedPid);
  if (self && self.cmd.includes(SERVICE_ENTRY)) return spawnedPid; // entrada dist directa

  // Descendentes: prefere o node que corre src/index.ts sem passar pelo cli do tsx.
  const seen = new Set([spawnedPid]);
  let frontier = [spawnedPid];
  const candidates = [];
  for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
    const next = [];
    for (const p of frontier) {
      for (const r of rows) {
        if (r.ppid !== p || seen.has(r.pid)) continue;
        seen.add(r.pid);
        next.push(r.pid);
        if (r.name === "node.exe" && /index\.(ts|js)/.test(r.cmd) && !r.cmd.includes("cli.mjs")) {
          candidates.push(r.pid);
        }
      }
    }
    frontier = next;
  }
  if (candidates.length > 0) return candidates[candidates.length - 1];
  // Sem candidato exacto: qualquer node descendente.
  const nodeDescendants = [...seen].filter((pid) => pid !== spawnedPid && byPid.get(pid)?.name === "node.exe");
  if (nodeDescendants.length === 1) return nodeDescendants[0];
  return null;
}

// ── Helpers do modo diag ─────────────────────────────────────────────────────
function findServiceLine(marker, sinceIdx = 0) {
  for (let i = Math.max(0, sinceIdx); i < serviceLines.length; i++) {
    if (serviceLines[i].line.includes(marker)) return { idx: i, ...serviceLines[i] };
  }
  return null;
}

async function waitForScanTerminal(client, scanId, timeoutMs) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const evs = scanEvents(client, scanId);
    const terminal = evs.find((e) => e.status === "cancelled" || e.status === "completed" || e.status === "failed");
    if (terminal) return terminal;
    await sleep(150);
  }
  return null;
}

function numStats(values) {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const pick = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return {
    n: v.length,
    min: v[0],
    med: pick(0.5),
    p95: pick(0.95),
    max: v[v.length - 1],
  };
}

async function measureRawFs(files) {
  const t0 = now();
  let bytes = 0;
  for (const f of files) {
    try {
      const fh = await fsp.open(f, "r");
      const buf = Buffer.alloc(4);
      await fh.read(buf, 0, 4, 0);
      await fh.close();
      bytes += buf.length;
    } catch {
      /* baseline tolera erros */
    }
  }
  return { files: files.length, totalMs: now() - t0, bytes };
}

// Amostrador de sistema (F2): CPU total da maquina, CPU acumulada do servico
// e RAM livre — 1 amostra/s. Distingue "servico nao executa" (espera/agendado)
// de "servico queima CPU em nativo" durante as janelas de latencia.
function sampleSystemOnce(servicePid) {
  return new Promise((resolve) => {
    const ps =
      `$p=Get-Process -Id ${servicePid} -ErrorAction SilentlyContinue; ` +
      `$c=Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction SilentlyContinue; ` +
      `$os=Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue; ` +
      `$cpu=if($c){[math]::Round(($c.CounterSamples|Where-Object{$_.InstanceName -eq '_total'}|Select-Object -First 1).CookedValue,1)}else{-1}; ` +
      `$svc=if($p){[math]::Round($p.TotalProcessorTime.TotalMilliseconds)}else{-1}; ` +
      `$free=if($os){[math]::Round($os.FreePhysicalMemory/1024)}else{-1}; ` +
      `Write-Output "$cpu|$svc|$free"`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const m = String(out).trim().match(/^(-?[\d.]+)\|(-?\d+)\|(-?\d+)$/);
      resolve(m ? { cpuPct: Number(m[1]), svcCpuMs: Number(m[2]), freeMB: Number(m[3]) } : null);
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 6000).unref?.();
  });
}

// ── MODO QUICK: E2E do Quick Scan REAL via servico/IPC (aceitacao B/C/E/F) ──
  // Com a protecao ligada por monitor.start: scan.start type=quick sobre as
// raizes reais, mede tempo ate ao 1o progresso, PREFETCH/batch ClamAV atingido,
// duracao total, pausa maxima entre progressos e RTT. Depois: monitor.stop +
// janela OFF para confirmar que NAO ha trabalho novo (gate F3).
async function runQuickMode({ client, baseline, summary, fixtureDir }) {
  const serviceLogLen = () => serviceLines.length;
  const findServiceLines = (pattern, since = 0) =>
    serviceLines.slice(since).filter((entry) => new RegExp(pattern).test(entry.line));
  const rec = {
    scenario: "quick-e2e",
    protectionAtConnect: null,
    requestToSelectedMs: null,
    requestToFirstProgressMs: null,
    selectedToPrefetchMs: null,
    prefetchBeforeStop: null,
    batchOurs: false,
    terminalStatus: null,
    requestToTerminalMs: null,
    selectedToTerminalMs: null,
    maxProgressGapMs: null,
    filesScannedAtTerminal: null,
    rttWindows: null,
    progressTrail: [],
    stop: { at: null, ack: null },
    off: {
      fileEventsAfterStop: 0,
      naSpawnsAfterStop: 0,
      newClamscanUnique: [],
      fileObsOffAfterStop: 0,
      protectionEnabledAfterStop: null,
      firstLines: [],
    },
    activeScanAfter: "unset",
    pass: false,
    failReasons: [],
  };

  rec.protectionAtConnect = await client.request("protection.getState", undefined, 15_000);
  const startAck = await client.request("monitor.start", undefined, 30_000);
  if (startAck?.ok !== true) throw new Error(`monitor.start: ${JSON.stringify(startAck)}`);
  const startIdx = serviceLines.length;
  const tRequest = now();
  const started = await startScanWithRetry(client, { type: "quick" });
  if (!started.id) throw new Error("Quick Scan recusado");
  const terminal = await waitForScanTerminal(client, started.id, HARD_TIMEOUT_MS);
  if (!terminal) await client.request("scan.cancel", { id: started.id }, 15_000);
  const progress = scanEvents(client, started.id);
  const selected = findServiceLine(`FILES_SELECTED scanId=${started.id}`, startIdx);
  const prefetch = findServiceLine(`PREFETCH_BEGIN scanId=${started.id}`, startIdx);
  const ex = {
    tRequest, terminal, progress, timedOut: !terminal,
    markers: { batchOurs: findServiceLine(`CLAMAV_BATCH_COUNT scanId=${started.id}`, startIdx) },
    requestToSelectedMs: selected ? selected.at - tRequest : null,
    selectedToPrefetchMs: selected && prefetch ? prefetch.at - selected.at : null,
    requestToTerminalMs: terminal ? terminal.at - tRequest : null,
    selectedToTerminalMs: selected && terminal ? terminal.at - selected.at : null,
    maxProgressGapMs: Math.max(0, ...progress.slice(1).map((event, index) => event.at - progress[index].at)),
  };
  rec.requestToSelectedMs = ex.requestToSelectedMs;
  rec.selectedToPrefetchMs = ex.selectedToPrefetchMs;
  rec.batchOurs = Boolean(ex.markers?.batchOurs);
  rec.terminalStatus = ex.terminal?.status ?? (ex.timedOut ? "timeout" : null);
  rec.requestToTerminalMs = ex.requestToTerminalMs;
  rec.selectedToTerminalMs = ex.selectedToTerminalMs;
  rec.maxProgressGapMs = ex.maxProgressGapMs;
  rec.filesScannedAtTerminal = ex.terminal?.filesScanned ?? null;
  rec.rttWindows = ex.rttWindows;
  rec.progressTrail = (ex.progress ?? []).slice(0, 40);
  rec.requestToFirstProgressMs = ex.progress?.length
    ? ex.progress[0].iso
      ? new Date(ex.progress[0].iso).getTime() - ex.tRequest
      : null
    : null;
  console.log(
    `[quick] terminal=${rec.terminalStatus} firstProgress=${rec.requestToFirstProgressMs ?? "?"}ms ` +
      `selectedToPrefetch=${rec.selectedToPrefetchMs ?? "NUNCA"}ms batchOurs=${rec.batchOurs} ` +
      `total=${rec.requestToTerminalMs ?? "?"}ms maxGap=${rec.maxProgressGapMs ?? "?"}ms`,
  );

  if (!rec.batchOurs) rec.failReasons.push("batch ClamAV do scan quick nunca observado");
  if (rec.terminalStatus !== "completed") rec.failReasons.push(`terminal=${rec.terminalStatus}`);
  if ((rec.maxProgressGapMs ?? 0) > 60_000) rec.failReasons.push(`pausa>60s (${rec.maxProgressGapMs}ms)`);

  // ── JANELA OFF (gate F3): stop + observacao de trabalho NOVO ──────────────
  const markOff = serviceLogLen();
  rec.stop.at = now();
  try {
    const a = await client.request("monitor.stop", undefined, 20_000);
    rec.stop.ack = a?.ok ?? a?.success ?? null;
  } catch (e) {
    rec.stop.ack = `erro:${String(e?.message ?? e)}`;
  }
  // Evento real após OFF e ligação nova: ambos têm de manter a proteção desligada.
  await fsp.appendFile(path.join(fixtureDir, "f-00000.txt"), "benign OFF observation\n");
  const reconnect = new ProbeClient();
  try {
    await reconnect.connect(10_000);
    rec.off.stateAfterReconnect = await reconnect.request("protection.getState", undefined, 10_000);
    if (rec.off.stateAfterReconnect?.protectionEnabled !== false) rec.failReasons.push("reconnect reativou proteção");
  } finally { reconnect.socket?.destroy(); }
  const stopTag = rec.stop.at;
  const windowDeadline = now() + 20_000;
  const seenFileEvents = new Set();
  const seenClamTags = new Set();
  const seenOffObs = new Set();
  while (now() < windowDeadline) {
    for (const r of client.events) {
      if (r.at < stopTag) continue;
      const t = r.event?.type ?? "";
      if (t.startsWith("file.")) seenFileEvents.add(t);
    }
    for (const row of await listClamscan()) {
      if (baseline.has(row.pid)) continue;
      const tag = `${row.pid}`;
      if (!seenClamTags.has(tag)) seenClamTags.add(tag);
    }
    const obsLines = findServiceLines("fileObs total=", markOff).filter((l) => l.at >= stopTag);
    for (const l of obsLines) {
      const m = l.line.match(/off=(\d+)/);
      if (m) seenOffObs.add(m[1]);
    }
    const na = findServiceLines("CLAMAV_BATCH_COUNT scanId=n/a", markOff).filter((l) => l.at >= stopTag);
    rec.off.naSpawnsAfterStop = na.map((l) => l.at);
    await sleep(400);
  }
  rec.off.fileEventsAfterStop = [...seenFileEvents];
  rec.off.newClamscanUnique = [...seenClamTags];
  rec.off.firstLines = findServiceLines(
    "STOPping|stopped|watcher|protection",
    markOff,
  )
    .slice(0, 8)
    .map((l) => new Date(l.at).toISOString() + " " + l.line.slice(0, 140));
  try {
    const st = await client.request("protection.getState", undefined, 10_000);
    rec.off.protectionEnabledAfterStop = st?.protectionEnabled ?? null;
  } catch {
    /* ignore */
  }

  if (rec.stop.ack !== true) rec.failReasons.push(`monitor.stop ack=${rec.stop.ack}`);
  if (rec.off.protectionEnabledAfterStop !== false)
    rec.failReasons.push(`protectionEnabled apos stop=${rec.off.protectionEnabledAfterStop}`);
  if (rec.off.fileEventsAfterStop.length > 0)
    rec.failReasons.push(`eventos file.* apos stop: ${rec.off.fileEventsAfterStop.join(",")}`);
  if (rec.off.naSpawnsAfterStop.length > 0)
    rec.failReasons.push(`batches n/a NOVOS apos stop: ${rec.off.naSpawnsAfterStop.length}`);

  try {
    const active = await client.request("scan.getActive", undefined, 10_000);
    rec.activeScanAfter = active ? `${active.status}` : "null";
    if (active && (active.status === "running" || active.status === "queued"))
      rec.failReasons.push(`scan ainda activo: ${active.status}`);
  } catch (e) {
    rec.activeScanAfter = `erro:${String(e?.message ?? e)}`;
  }

  rec.pass = rec.failReasons.length === 0;
  console.log(
    `[quick] ${rec.pass ? "PASS" : "FAIL"} offWindow fileEvents=${rec.off.fileEventsAfterStop.length} ` +
      `naSpawns=${rec.off.naSpawnsAfterStop.length} newClam=${rec.off.newClamscanUnique.length} ` +
      `protEnabled=${rec.off.protectionEnabledAfterStop}` +
      (rec.failReasons.length ? ` motivos=${JSON.stringify(rec.failReasons)}` : ""),
  );
  return rec;
}

async function runDiag({ client, service, baseline, summary, fixtureDir, files }) {
  const servicePid = summary.serviceStart.listenerPid;
  const recT0 = now();
  const rec = {
    mode: "diag",
    diagFiles: DIAG_FILES,
    servicePid,
    bootLines: {},
    protection: { atConnect: null, beforeExp1: null, afterStop: null, afterExp2: null },
    rawFs: null,
    exp1: null,
    exp3: null,
    off: null,
    exp2: null,
    rttByPhase: {},
    completed: false,
    notes: [],
  };

  // Linhas de arranque: coerencia OFF vs watcher (evidencia do auto-start).
  const offMsg = findServiceLine("Protection remains OFF until monitor.start");
  const watcherMsg = findServiceLine("File watcher started on");
  rec.bootLines.offMessage = offMsg ? { at: offMsg.at, idx: offMsg.idx } : null;
  rec.bootLines.watcherStarted = watcherMsg ? { at: watcherMsg.at, idx: watcherMsg.idx } : null;
  rec.bootLines.watcherBeforeClientConnect =
    offMsg && watcherMsg ? watcherMsg.at - offMsg.at : null;

  rec.protection.atConnect = await client.request("protection.getState", undefined, 15_000);
  console.log(
    `[diag] protectionState atConnect protectionEnabled=${rec.protection.atConnect?.protectionEnabled} status=${rec.protection.atConnect?.protectionStatus ?? "?"}`,
  );

  console.log(`[diag] fixture=${fixtureDir} (${files.length} ficheiros)`);
  rec.rawFs = await measureRawFs(files.slice(0, Math.min(20, files.length)));
  console.log(`[diag] rawFs baseline: ${rec.rawFs.files} opens em ${rec.rawFs.totalMs}ms`);

  // RTT pinger: mede bloqueio do event loop do SERVICO (resposta a pedidos IPC).
  const phaseRef = { phase: "idle" };
  const rtts = [];
  let pingerOn = true;
  const pinger = (async () => {
    while (pingerOn) {
      const t = now();
      try {
        await client.request("protection.getState", undefined, 10_000);
        rtts.push({ phase: phaseRef.phase, at: now() - t });
      } catch (e) {
        rtts.push({ phase: phaseRef.phase, at: -1, err: String(e?.message ?? e) });
      }
      await sleep(250);
    }
  })();

  // Amostrador de sistema (1 amostra/s): CPU maquina, CPU acumulada servico,
  // RAM livre — para separar "nao executa" de "queima CPU em nativo".
  const sysSamples = [];
  let sysOn = true;
  let sysLast = null;
  const sysTimer = (async () => {
    while (sysOn) {
      const s = await sampleSystemOnce(servicePid);
      if (s) {
        const at = now();
        sysSamples.push({
          at,
          t: at - recT0,
          cpuPct: s.cpuPct,
          freeMB: s.freeMB,
          svcCpuMsDelta: sysLast === null ? null : s.svcCpuMs - sysLast,
        });
        sysLast = s.svcCpuMs;
      }
      await sleep(1000);
    }
  })();

  const recordRtts = () => {
    const byPhase = {};
    for (const r of rtts) {
      (byPhase[r.phase] ??= { ok: [], err: [] });
      if (r.at >= 0) byPhase[r.phase].ok.push(r.at);
      else byPhase[r.phase].err.push(r.err);
    }
    const out = {};
    for (const [p, v] of Object.entries(byPhase)) {
      out[p] = { stats: numStats(v.ok), errors: v.err.length };
    }
    rec.rttByPhase = out;
  };

  const runScanExp = async (label) => {
    phaseRef.phase = `${label}-scan`;
    const startIdx = serviceLines.length;
    const tRequest = now();
    const started = await startScanWithRetry(client, { type: "custom", targetPath: fixtureDir });
    const recExp = {
      label,
      scanId: started.id,
      startAttempts: started.attempts,
      tRequest,
      tAck: started.id ? now() : null,
      terminal: null,
      tTerminal: null,
      firstEventMs: null,
      events: [],
      markers: {},
      timedOut: false,
    };
    if (!started.id) {
      recExp.error = "scan.start recusado";
      console.log(`[diag][${label}] FALHA: scan.start recusado ${JSON.stringify(started.attempts)}`);
      return recExp;
    }
    const eventsFrom = tRequest;
    const terminal = await waitForScanTerminal(client, started.id, 240_000);
    if (!terminal) {
      recExp.timedOut = true;
      try {
        await client.request("scan.cancel", { id: started.id }, 15_000);
      } catch {
        /* ignore */
      }
      await sleep(2000);
      recExp.terminalAfterCancel = scanEvents(client, started.id).at(-1) ?? null;
      console.log(`[diag][${label}] TIMEOUT sem terminal — cancel defensivo enviado`);
    } else {
      recExp.terminal = terminal;
      recExp.tTerminal = terminal.at;
    }
    const evs = scanEvents(client, started.id);
    recExp.events = evs;
    const firstAfter = evs.find((e) => e.at >= eventsFrom);
    recExp.firstEventMs = firstAfter ? firstAfter.at - tRequest : null;

    // Marcadores no stdout do servico (arquivo completo do scan).
    for (const [key, marker] of [
      ["filesSelected", `FILES_SELECTED scanId=${started.id}`],
      ["prefetchBegin", `PREFETCH_BEGIN scanId=${started.id}`],
      ["prefetchStart", `prefetch start id=${started.id}`],
      ["batchOurs", `CLAMAV_BATCH_COUNT scanId=${started.id}`],
      ["prefetchCancelled", `PREFETCH_CANCELLED_BEFORE_START scanId=${started.id}`],
    ]) {
      const hit = findServiceLine(marker, startIdx);
      recExp.markers[key] = hit ? { at: hit.at, line: hit.line } : null;
    }
    if (recExp.markers.filesSelected && recExp.markers.prefetchBegin) {
      recExp.selectedToPrefetchMs = recExp.markers.prefetchBegin.at - recExp.markers.filesSelected.at;
    } else {
      recExp.selectedToPrefetchMs = null;
    }
    if (recExp.markers.filesSelected) {
      recExp.requestToSelectedMs = recExp.markers.filesSelected.at - tRequest;
    }
    if (recExp.tTerminal && recExp.markers.filesSelected) {
      recExp.selectedToTerminalMs = recExp.tTerminal - recExp.markers.filesSelected.at;
    }
    console.log(
      `[diag][${label}] terminal=${terminal?.status ?? "timeout"} ` +
        `reqToSelected=${recExp.requestToSelectedMs ?? "?"}ms ` +
        `selectedToPrefetch=${recExp.selectedToPrefetchMs ?? "NUNCA"}ms ` +
        `selectedToTerminal=${recExp.selectedToTerminalMs ?? "?"}ms ` +
        `batchOurs=${recExp.markers.batchOurs ? "SIM" : "NAO"}`,
    );
    return recExp;
  };

  // ── EXPERIMENTO 1: BASELINE — NESTA CORRIDA E' O EXP3 QUE USA A JANELA ────
  // O bloqueio so existe nos ~50 s iniciais apos o arranque do watcher (walk
  // inicial do chokidar). O exp3 ocupa essa janela; a baseline de exp1-on
  // (selectedToPrefetch 49 641-54 088 ms em 4 execs) esta' nos JSONs anteriores.
  rec.protection.beforeExp1 = await client.request("protection.getState", undefined, 15_000);
  rec.exp1 = null;
  rec.notes.push(
    "exp1 pulado nesta corrida: baseline 49.6-54.1 s (4 execs anteriores); janela de walk usada pelo exp3.",
  );

  // ── EXPERIMENTO 3: stop NO MEIO do stall (causalidade protecao vs scan) ────
  // PRIMEIRO cenario: o scan arranca com a protecao ligada, espera 10 s pelo
  // PREFETCH (que nao chega = stall) e so depois monitor.stop(). Se o prefetch
  // despontar logo apos o stop, o bloqueio vinha dos subsistemas da protecao.
  phaseRef.phase = "exp3-stop";
  rec.exp3 = {
    scanId: null,
    selectedAt: null,
    prefetchBeforeStop: null,
    stopAt: null,
    stopAck: null,
    stopAckMs: null,
    prefetchAfterStopMs: null,
    selectedToPrefetchMs: null,
    selectedToTerminalMs: null,
    terminalStatus: null,
    inconclusive: false,
  };
  {
    const start3 = await startScanWithRetry(client, { type: "custom", targetPath: fixtureDir });
    rec.exp3.scanId = start3.id;
    if (!start3.id) {
      rec.exp3.inconclusive = true;
      console.log("[diag][exp3-stop] FALHA: scan.start recusado");
    } else {
      const sel = await waitFor(() => findServiceLine(`FILES_SELECTED scanId=${start3.id}`), 30_000, 200);
      rec.exp3.selectedAt = sel ? sel.at : null;
      let pre = null;
      const stallDeadline = now() + 10_000;
      while (now() < stallDeadline && !pre) {
        pre = findServiceLine(`PREFETCH_BEGIN scanId=${start3.id}`);
        if (!pre) await sleep(300);
      }
      rec.exp3.prefetchBeforeStop = Boolean(pre);
      if (pre) rec.exp3.inconclusive = true; // nao ha stall — sem experiencia
      const stopT = now();
      const stopT0 = now();
      try {
        const a = await client.request("monitor.stop", undefined, 20_000);
        rec.exp3.stopAck = a?.ok ?? a?.success ?? a ?? null;
      } catch (e) {
        rec.exp3.stopAck = `erro:${String(e?.message ?? e)}`;
      }
      rec.exp3.stopAt = stopT;
      rec.exp3.stopAckMs = now() - stopT0;
      const afterDeadline = now() + 120_000;
      while (now() < afterDeadline && !rec.exp3.terminalStatus) {
        if (!pre) pre = findServiceLine(`PREFETCH_BEGIN scanId=${start3.id}`);
        const term = scanEvents(client, start3.id).find((e) =>
          ["cancelled", "completed", "failed"].includes(e.status),
        );
        if (term) rec.exp3.terminalStatus = term.status;
        else await sleep(300);
      }
      rec.exp3.prefetchAfterStopMs = pre && rec.exp3.stopAt ? pre.at - rec.exp3.stopAt : null;
      if (pre && rec.exp3.selectedAt) rec.exp3.selectedToPrefetchMs = pre.at - rec.exp3.selectedAt;
      if (rec.exp3.terminalStatus && rec.exp3.selectedAt) {
        const term = scanEvents(client, start3.id).find((e) => e.status === rec.exp3.terminalStatus);
        rec.exp3.selectedToTerminalMs = term ? term.at - rec.exp3.selectedAt : null;
      }
      console.log(
        `[diag][exp3-stop] terminal=${rec.exp3.terminalStatus ?? "timeout"} ` +
          `prefetchBeforeStop=${rec.exp3.prefetchBeforeStop} ` +
          `stopAck=${safeJson(rec.exp3.stopAck)} in ${rec.exp3.stopAckMs}ms ` +
          `prefetchAfterStop=${rec.exp3.prefetchAfterStopMs ?? "NUNCA"}ms ` +
          `selectedToPrefetch=${rec.exp3.selectedToPrefetchMs ?? "NUNCA"}ms ` +
          `selectedToTerminal=${rec.exp3.selectedToTerminalMs ?? "?"}ms`,
      );
    }
  }

  // ── JANELA OFF: monitor.stop + observacao de gate ──────────────────────────
  phaseRef.phase = "off-window";
  const stopIdx = serviceLines.length;
  const stopTs = now();
  let stopAck = null;
  let stopError = null;
  try {
    const ack = await client.request("monitor.stop", undefined, 20_000);
    stopAck = ack?.ok ?? ack?.success ?? ack ?? null;
  } catch (e) {
    stopError = String(e?.message ?? e);
  }
  const stateAfterStop = await client.request("protection.getState", undefined, 15_000).catch((e) => ({ error: String(e?.message ?? e) }));
  rec.protection.afterStop = stateAfterStop;
  rec.off = {
    stopTs,
    stopAck,
    stopError,
    protectionEnabledAfterStop: stateAfterStop?.protectionEnabled ?? null,
    windowMs: OFF_WINDOW_MS,
    fileEventsAfterStop: [],
    naSpawnsAfterStop: [],
    newClamscanDuringWindow: [],
    rttDuringWindow: [],
  };
  console.log(
    `[diag][off] monitor.stop ack=${safeJson(stopAck)} err=${stopError ?? "n/a"} protectionEnabled=${rec.off.protectionEnabledAfterStop}`,
  );

  const eventsBeforeOff = client.events.length;
  const windowDeadline = now() + OFF_WINDOW_MS;
  while (now() < windowDeadline) {
    const rows = await listClamscan();
    const fresh = rows.filter((r) => !baseline.has(r.pid));
    for (const r of fresh) {
      const tag = `${r.pid}@${now() - stopTs}`;
      if (!rec.off.newClamscanDuringWindow.includes(tag)) rec.off.newClamscanDuringWindow.push(tag);
    }
    await sleep(500);
  }
  // Eventos novos apos o stop (watcher/process monitor devem estar calados).
  for (const ev of client.events.slice(eventsBeforeOff)) {
    if (ev.at < stopTs) continue;
    if (["file.created", "file.modified", "file.renamed", "process.started"].includes(ev.event?.type)) {
      rec.off.fileEventsAfterStop.push({ at: ev.at - stopTs, type: ev.event.type, path: ev.event?.data?.path ?? null });
    }
  }
  for (const l of serviceLines.slice(stopIdx)) {
    if (l.line.includes("CLAMAV_BATCH_COUNT") && l.line.includes("scanId=n/a")) {
      rec.off.naSpawnsAfterStop.push({ at: l.at - stopTs, line: l.line.trim() });
    }
  }
  console.log(
    `[diag][off] window=${OFF_WINDOW_MS}ms fileEventsAfterStop=${rec.off.fileEventsAfterStop.length} ` +
      `naSpawnsAfterStop=${rec.off.naSpawnsAfterStop.length} newClamscan=${rec.off.newClamscanDuringWindow.length}`,
  );

  // ── EXPERIMENTO 2: MESMO scan com a protecao OFF confirmada ────────────────
  rec.exp2 = await runScanExp("exp2-off");
  rec.protection.afterExp2 = await client.request("protection.getState", undefined, 15_000).catch((e) => ({ error: String(e?.message ?? e) }));

  pingerOn = false;
  await pinger;
  sysOn = false;
  await sysTimer;
  rec.system = sysSamples;
  recordRtts();
  for (const [phase, v] of Object.entries(rec.rttByPhase)) {
    console.log(`[diag][rtt] phase=${phase} n=${v.stats.n ?? 0} med=${v.stats.med ?? "?"}ms p95=${v.stats.p95 ?? "?"}ms max=${v.stats.max ?? "?"}ms err=${v.errors}`);
  }

  rec.notes.push(
    "F2: selectedToPrefetchMs e a janela do loop de candidatos (scan-manager 471-498); 'NUNCA' = batch nao iniciado.",
    "F2/F3: RTT medido com protection.getState no event loop do servico; max perto de selectedToPrefetchMs/iteracao indica loop bloqueado por outro trabalho.",
    "F3: fileEventsAfterStop deve ser 0; naSpawnsAfterStop pode conter drain de trabalho criado ANTES do stop (timestamps relativos em ms).",
  );
  rec.completed = Boolean(rec.exp1 && rec.exp2 && rec.exp1.scanId && rec.exp2.scanId);
  summary.diag = rec;
  return rec;
}


async function startServiceEntry(cmd, args, label) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      CYBERSAFE_DEBUG_SCAN: "1",
      CYBERSAFE_PERF_TRACE: "1",
      // PROBE_TP16=1: experimento E1 de F2 — alarga o threadpool do servico
      // para testar a teoria de saturacao do pool pelo walk do chokidar.
      ...(process.env.PROBE_TP16 === "1" ? { UV_THREADPOOL_SIZE: "16" } : {}),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line.trim()) continue;
      serviceLines.push({ at: now(), src: "out", line });
      log(`[${label}:out] ${line}`);
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line.trim()) continue;
      serviceLines.push({ at: now(), src: "err", line });
      log(`[${label}:err] ${line}`);
    }
  });
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal, at: now() };
    log(`[${label}] exit code=${code} signal=${signal}`);
  });
  child.on("error", (e) => log(`[${label}] spawn error: ${e.message}`));

  const readyAt = await waitFor(async () => {
    if (exited) return { failed: exited };
    return await new Promise((resolve) => {
      const s = net.createConnection(PIPE_NAME, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
      setTimeout(() => {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
        resolve(false);
      }, 1000).unref?.();
    });
  }, PIPE_WAIT_MS, 500);

  const ready = Boolean(readyAt) && typeof readyAt === "boolean";
  return { child, exited: () => exited, ready, label, cmd: `${cmd} ${args.join(" ")}` };
}

async function startServiceWithFallback() {
  const attempts = [];
  // PROBE_CPU_PROF=1: perfil de CPU do SERVICO (node --cpu-prof) — atribui o
  // tempo de event loop sem tocar no codigo de producao.
  const profArgs = (args) =>
    process.env.PROBE_CPU_PROF === "1"
      ? ["--cpu-prof", `--cpu-prof-dir=${path.join(LOG_DIR, `cpu-prof-${STAMP}`)}`, ...args]
      : args;
  // 1a tentativa: dist (entry oficial "start"). Se morrer, registar e seguir.
  const dist = await startServiceEntry(process.execPath, profArgs([SERVICE_ENTRY]), "service-dist");
  attempts.push({ label: dist.label, cmd: dist.cmd, ready: dist.ready, exit: dist.exited() });
  if (dist.ready) return { service: dist, attempts };
  if (!dist.exited()) {
    try {
      dist.child.kill();
    } catch {
      /* ignore */
    }
  }
  await sleep(500);
  // 2a tentativa: entrada dev suportada (tsx), a mesma do `dev:service`.
  if (!fs.existsSync(SERVICE_TSX)) {
    return { service: null, attempts, fatal: `tsx nao encontrado em ${SERVICE_TSX}` };
  }
  const tsx = await startServiceEntry(process.execPath, profArgs([SERVICE_TSX, SERVICE_SRC]), "service-tsx");
  attempts.push({ label: tsx.label, cmd: tsx.cmd, ready: tsx.ready, exit: tsx.exited() });
  return { service: tsx.ready ? tsx : null, attempts, fatal: tsx.ready ? null : "tsx entry tambem nao ficou pronto" };
}

async function shutdownService(client, child, exited) {
  const result = { ack: null, exit: null, forced: false };
  try {
    const ack = await client.request("service.shutdown", undefined, 5000);
    result.ack = ack?.success ?? null;
  } catch (e) {
    result.ack = `erro:${String(e?.message ?? e)}`;
  }
  const deadline = now() + 15_000;
  while (now() < deadline && !exited()) await sleep(200);
  if (!exited()) {
    result.forced = true;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    const deadline2 = now() + 5_000;
    while (now() < deadline2 && !exited()) await sleep(200);
  }
  result.exit = exited();
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

  console.log("=== CyberSafe — scan cancel runtime probe (P1, SERVICE+IPC real) ===");
  console.log(`stamp=${STAMP} node=${process.version} platform=${process.platform}`);
  console.log(`files=${FILES} hardTimeout=${HARD_TIMEOUT_MS}ms grace=${GRACE_MS}ms stability=${STABILITY_MS}ms`);
  console.log(`pipe=${PIPE_NAME}`);
  console.log(`service=${SERVICE_ENTRY} exists=${fs.existsSync(SERVICE_ENTRY)}`);
  console.log(`log=${LOG_PATH}`);

  const cv = clamscanVersion();
  console.log(`clamscan=${cv.ok ? "OK" : "MISSING"} version=${cv.version}`);
  if (!cv.ok) {
    console.error("clamscan nao esta em PATH — abort.");
    process.exitCode = 3;
    await new Promise((r) => logStream.end(r));
    return;
  }
  if (!fs.existsSync(SERVICE_ENTRY)) {
    console.error(`servico nao compilado: ${SERVICE_ENTRY} — correr build do workspace service primeiro.`);
    process.exitCode = 3;
    await new Promise((r) => logStream.end(r));
    return;
  }

  if (await pipeInUse()) {
    console.error("PIPE EM USO — outra instancia do servico esta ativa. Abortar sem a tocar.");
    process.exitCode = 4;
    await new Promise((r) => logStream.end(r));
    return;
  }
  console.log("pipe=livre");

  const baselineRows = await listClamscan();
  const baseline = new Set(baselineRows.map((r) => r.pid));
  console.log(`clamscan baseline=${baselineRows.length}${baselineRows.length ? ` pids=${[...baseline].join(",")}` : ""}`);

  const { dir: fixtureDir, files } = await makeFixtures(FILES);
  console.log(`fixture=${fixtureDir} (${files.length} ficheiros)`);

  const summary = {
    stamp: STAMP,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    clamscan: cv.version,
    pipe: PIPE_NAME,
    serviceEntry: SERVICE_ENTRY,
    files: FILES,
    graceMs: GRACE_MS,
    stabilityMs: STABILITY_MS,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    baselineClamscan: baselineRows,
    fixtureDir,
    scenarios: [],
    serviceStart: null,
    shutdown: null,
    verdict: "UNKNOWN",
  };

  let service = null;
  let client = null;
  let overallPass = true;
  try {
    console.log("\n=== ARRANQUE DO SERVICO REAL ===");
    const startedService = await startServiceWithFallback();
    service = startedService.service;
    summary.serviceStart = {
      attempts: startedService.attempts,
      fatal: startedService.fatal ?? null,
      pid: service?.child?.pid ?? null,
      entry: service?.label ?? null,
      cmd: service?.cmd ?? null,
    };
    for (const a of startedService.attempts) {
      console.log(`entrada ${a.label}: ready=${a.ready} exit=${safeJson(a.exit)} cmd=${a.cmd}`);
    }
    if (!service) {
      console.error(`servico nao ficou pronto no pipe: ${startedService.fatal ?? "desconhecido"}`);
      overallPass = false;
      summary.verdict = "FAIL_SERVICE_START";
      return;
    }
    console.log(`servico pronto pid=${service.child.pid} via ${service.label}`);

    client = new ProbeClient();
    await client.connect(15_000);
    console.log("cliente ligado ao pipe");

    const spawnedPid = service.child.pid;
    const resolvedPid = await resolveServicePid(spawnedPid);
    const servicePid = resolvedPid ?? spawnedPid;
    summary.serviceStart.spawnedPid = spawnedPid;
    summary.serviceStart.listenerPid = servicePid;
    summary.serviceStart.listenerResolved = resolvedPid !== null;
    console.log(`pid lancado=${spawnedPid} listener(pipe)=${servicePid} resolved=${resolvedPid !== null}`);
    const baseline2 = new Set([...baseline]);

    if (MODE === "diag") {
      console.log("\n=== MODO DIAG (F2/F3): estado, RTT, loop de candidatos, janela OFF ===");
      const diagRec = await runDiag({ client, service, baseline: baseline2, summary, fixtureDir, files });
      overallPass = overallPass && diagRec.completed;
      summary.verdict = overallPass ? "DIAG_COMPLETE" : "DIAG_INCOMPLETE";
    } else if (MODE === "quick") {
      console.log("\n=== MODO QUICK (E2E Quick Scan via IPC + gate OFF) ===");
      const q = await runQuickMode({ client, baseline: baseline2, summary, fixtureDir });
      summary.quick = q;
      overallPass = overallPass && q.pass;
      summary.verdict = overallPass ? "QUICK_PASS" : "QUICK_FAIL";
    } else {
    console.log("\n=== CENARIO A: cancel MID-BATCH ===");
    const a = await runScenario({ label: "A-mid-batch", client, servicePid, baseline: baseline2, fixtureDir, mode: "A-mid-batch" });
    summary.scenarios.push(a);
    overallPass = overallPass && a.pass;

    console.log("\n=== CENARIO B: NOVO scan apos cancel ===");
    const b = await runScenario({ label: "B-restart", client, servicePid, baseline: baseline2, fixtureDir, mode: "B-restart" });
    summary.scenarios.push(b);
    overallPass = overallPass && b.pass;

    console.log("\n=== CENARIO C: cancel PRE-SPAWN ===");
    const c = await runScenario({ label: "C-pre-spawn", client, servicePid, baseline: baseline2, fixtureDir, mode: "C-pre-spawn" });
    summary.scenarios.push(c);
    // C e' informativo: um cancel imediato pode chegar antes de "running".
    // So falha o conjunto se NAO terminar cancelado.
    if (c.terminalStatus !== "cancelled") overallPass = false;

    summary.verdict = overallPass ? "PASS" : "FAIL";
    }
  } catch (e) {
    overallPass = false;
    summary.verdict = "FAIL_HARNESS";
    summary.harnessError = String(e?.stack ?? e);
    console.error(`HARNESS ERROR: ${summary.harnessError}`);
  } finally {
    if (client && service) {
      console.log("\n=== SHUTDOWN DO SERVICO ===");
      summary.shutdown = await shutdownService(client, service.child, service.exited);
      console.log(`shutdown ack=${summary.shutdown.ack} exit=${safeJson(summary.shutdown.exit)} forced=${summary.shutdown.forced}`);
      if (summary.shutdown.exit?.code !== 0 && !summary.shutdown.forced) overallPass = false;
    } else if (service) {
      try {
        service.child.kill();
      } catch {
        /* ignore */
      }
    }
    client?.disconnect();

    // Nenhum clamscan pode sobreviver ao teste.
    await sleep(1500);
    const finalRows = await listClamscan();
    summary.finalClamscan = finalRows;
    if (finalRows.filter((r) => !baseline.has(r.pid)).length > 0) {
      console.log(`ALERTA: clamscan novo ainda vivo: ${JSON.stringify(finalRows.filter((r) => !baseline.has(r.pid)))}`);
      overallPass = false;
      if (summary.verdict === "PASS") summary.verdict = "FAIL_ORPHAN_AT_END";
    } else {
      console.log("clamscan final: zero novos processos");
    }

    if (!KEEP_FIXTURES) {
      await fsp.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (summary.verdict === "UNKNOWN") summary.verdict = overallPass ? "PASS" : "FAIL";
  else if (!overallPass && summary.verdict === "DIAG_COMPLETE") summary.verdict = "DIAG_INCOMPLETE";
  fs.writeFileSync(JSON_PATH, JSON.stringify(summary, null, 2));
  await new Promise((r) => logStream.end(r));

  console.log("\n=== RESUMO ===");
  for (const s of summary.scenarios) {
    console.log(
      `scenario=${s.scenario} pass=${s.pass} terminal=${s.terminalStatus} abortToResolveMs=${s.abortToResolveMs} ` +
        `clamDeadMs=${s.cancelToClamDeadMs} orphans=${s.orphanNewAfterGrace?.length} stability=${s.stabilityViolations?.length} ` +
        `active=${s.activeScanAfter} memMB=${s.serviceMemMbBefore}->${s.serviceMemMbAfter}`,
    );
  }
  if (summary.quick) {
    const q = summary.quick;
    console.log(
      `[quick] terminal=${q.terminalStatus} firstProgress=${q.requestToFirstProgressMs ?? "?"}ms ` +
        `selectedToPrefetch=${q.selectedToPrefetchMs ?? "NUNCA"}ms batchOurs=${q.batchOurs} ` +
        `total=${q.requestToTerminalMs ?? "?"}ms maxGap=${q.maxProgressGapMs ?? "?"}ms ` +
        `files=${q.filesScannedAtTerminal} offFileEvents=${q.off.fileEventsAfterStop.length} ` +
        `offNaSpawns=${q.off.naSpawnsAfterStop.length} protEnabledAfterStop=${q.off.protectionEnabledAfterStop} ` +
        `fail=${JSON.stringify(q.failReasons)}`,
    );
  }
  if (summary.diag) {
    const d = summary.diag;
    console.log(
      `[diag] protectionEnabled atConnect=${d.protection?.atConnect?.protectionEnabled} ` +
        `afterStop=${d.protection?.afterStop?.protectionEnabled} afterExp2=${d.protection?.afterExp2?.protectionEnabled}`,
    );
    console.log(`[diag] rawFs=${d.rawFs?.files}files/${d.rawFs?.totalMs}ms`);
    for (const e of [d.exp1, d.exp2]) {
      if (!e) continue;
      console.log(
        `[diag] ${e.label} terminal=${e.terminal?.status ?? (e.timedOut ? "timeout" : "none")} ` +
          `reqToSelected=${e.requestToSelectedMs ?? "?"}ms selectedToPrefetch=${e.selectedToPrefetchMs ?? "NUNCA"}ms ` +
          `selectedToTerminal=${e.selectedToTerminalMs ?? "?"}ms batchOurs=${e.markers?.batchOurs ? "SIM" : "NAO"}`,
      );
    }
    if (d.off) {
      console.log(
        `[diag] offWindow fileEvents=${d.off.fileEventsAfterStop?.length} naSpawns=${d.off.naSpawnsAfterStop?.length} ` +
          `newClamscan=${d.off.newClamscanDuringWindow?.length} protectionEnabled=${d.off.protectionEnabledAfterStop}`,
      );
    }
    if (d.exp3) {
      console.log(
        `[diag] exp3-stop terminal=${d.exp3.terminalStatus ?? "timeout"} prefetchBeforeStop=${d.exp3.prefetchBeforeStop} ` +
          `prefetchAfterStop=${d.exp3.prefetchAfterStopMs ?? "NUNCA"}ms selectedToPrefetch=${d.exp3.selectedToPrefetchMs ?? "NUNCA"}ms ` +
          `selectedToTerminal=${d.exp3.selectedToTerminalMs ?? "?"}ms inconclusive=${d.exp3.inconclusive}`,
      );
    }
    for (const [phase, v] of Object.entries(d.rttByPhase ?? {})) {
      console.log(`[diag] rtt phase=${phase} n=${v.stats.n ?? 0} med=${v.stats.med ?? "?"} p95=${v.stats.p95 ?? "?"} max=${v.stats.max ?? "?"} err=${v.errors}`);
    }
  }
  console.log(`VERDICT=${summary.verdict}`);
  console.log(`JSON=${JSON_PATH}`);
  console.log(`LOG=${LOG_PATH}`);
  if (process.env.PROBE_CPU_PROF === "1") {
    console.log(`CPUPROF_DIR=${path.join(LOG_DIR, `cpu-prof-${STAMP}`)}`);
  }
  process.exitCode = overallPass ? 0 : 1;
}

await main();
