#!/usr/bin/env node
/**
 * Benchmark DEV do Scanner (não é um teste).
 *
 * Modo mínimo (por omissão): ScanManager real + motor benigno, 300 ficheiros.
 * Modo integrado (`BENCH_REAL=1`): ProtectionEngineService real com ClamAV,
 * YARA, HashDB e motor nativo, sobre a mesma árvore temporária. O tracing é o
 * `[ScanPerf]` já existente (`CYBERSAFE_DEBUG_SCAN=1`); este script só o lê.
 *
 * Números reais, medidos. Não usa ficheiros do utilizador e remove os
 * artefactos no fim.
 *
 * Uso:
 *   node scripts/scanner-benchmark.mjs
 *   BENCH_REAL=1 BENCH_FILES=300 node scripts/scanner-benchmark.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";

const FILE_COUNT = Number(process.env.BENCH_FILES ?? 300);
const REAL = process.env.BENCH_REAL === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function benignEngine() {
  const counters = { analyzed: 0, bytes: 0 };
  return {
    counters,
    scanArtifact: async (filePath) => {
      counters.analyzed += 1;
      try {
        const data = await fs.readFile(filePath);
        counters.bytes += data.length;
      } catch { /* ilegível: continua */ }
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    emitScanProgress: () => {},
  };
}

async function makeTree(root) {
  for (let i = 0; i < FILE_COUNT; i++) {
    const kind = i % 4;
    const name = kind === 0 ? "doc" + i + ".txt" : kind === 1 ? "app" + i + ".js" : kind === 2 ? "data" + i + ".json" : "script" + i + ".ps1";
    const body = kind === 0
      ? "Documento de teste " + i
      : kind === 1
        ? "export const value" + i + " = " + i + ";"
        : kind === 2
          ? JSON.stringify({ index: i, ok: true })
          : "Write-Output 'benign " + i + "'";
    await fs.writeFile(path.join(root, name), body);
  }
  const zip = new AdmZip();
  zip.addFile("hello.txt", Buffer.from("hello world"));
  zip.writeZip(path.join(root, "archive.zip"));
}

function parsePerfLogs(rows) {
  const engines = new Map();
  const summary = {
    zipMs: 0,
    zipCount: 0,
    prefetchMs: null,
    batchMs: null,
    historyMs: null,
    historyCount: 0,
    perfLines: 0,
  };
  for (const row of rows) {
    const line = row.line;
    let m = /^\[ScanPerf\] ENGINE_PHASE engine=(\w+) elapsedMs=(\d+)/.exec(line);
    if (m) {
      summary.perfLines += 1;
      const name = m[1];
      const ms = Number(m[2]);
      const entry = engines.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
      entry.count += 1;
      entry.totalMs += ms;
      entry.maxMs = Math.max(entry.maxMs, ms);
      engines.set(name, entry);
      continue;
    }
    m = /^\[ScanPerf\] ZIP_PHASE .*elapsedMs=(\d+)/.exec(line);
    if (m) {
      summary.perfLines += 1;
      summary.zipMs += Number(m[1]);
      summary.zipCount += 1;
      continue;
    }
    m = /^\[ScanPerf\] prefetch end .*elapsed=(\d+)s/.exec(line);
    if (m) {
      summary.perfLines += 1;
      summary.prefetchMs = Number(m[1]) * 1000;
      continue;
    }
    m = /^\[ScanPerf\] SCANMANAGER_BATCH_END .*elapsedMs=(\d+)/.exec(line);
    if (m) {
      summary.perfLines += 1;
      summary.batchMs = Number(m[1]);
      continue;
    }
    m = /^\[ScanPerf\] HISTORY_RECORD .*elapsedMs=(\d+)/.exec(line);
    if (m) {
      summary.perfLines += 1;
      summary.historyMs = Number(m[1]);
      summary.historyCount += 1;
    }
  }
  const enginesOut = {};
  for (const [name, entry] of engines) {
    enginesOut[name] = {
      count: entry.count,
      totalMs: entry.totalMs,
      avgMs: Math.round((entry.totalMs / entry.count) * 10) / 10,
      maxMs: entry.maxMs,
    };
  }
  return { engines: enginesOut, ...summary };
}

function startCapture() {
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const rows = [];
  const capture = (kind) => (...args) => {
    rows.push({
      at: Date.now(),
      line: "[stderr] " + args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(" "),
    });
  };
  const captureOut = (...args) => {
    rows.push({
      at: Date.now(),
      line: args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(" "),
    });
  };
  console.log = captureOut;
  console.error = capture("error");
  console.warn = capture("warn");
  return {
    rows,
    restore() {
      console.log = originals.log;
      console.error = originals.error;
      console.warn = originals.warn;
    },
  };
}

async function runFake(root) {
  const { ScanManager } = await import("../packages/service/dist/scan-manager.js");
  const engine = benignEngine();
  const manager = new ScanManager(engine);
  const start = Date.now();
  const id = await manager.startScan("custom", root);
  if (!id) throw new Error("scan recusado");
  while (true) {
    const state = manager.getScan(id);
    if (state && ["completed", "cancelled", "failed"].includes(state.status)) break;
    await sleep(50);
  }
  const state = manager.getScan(id);
  const elapsedMs = Date.now() - start;
  const perSec = elapsedMs > 0 ? Math.round((state.filesScanned / (elapsedMs / 1000)) * 10) / 10 : 0;
  return {
    mode: "minimal",
    state,
    elapsedMs,
    perSec,
    engineCalls: engine.counters.analyzed,
    phases: null,
    health: null,
    errors: [],
  };
}

async function runReal(root) {
  process.env.NODE_ENV = "test";
  process.env.CYBERSAFE_USB_PROTECTION = "0";
  process.env.CYBERSAFE_STARTUP_RESUME = "0";
  process.env.CYBERSAFE_DEBUG_SCAN = "1";
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-bench-base-"));
  const capture = startCapture();
  let engine = null;
  try {
    const { ProtectionEngineService } = await import("../packages/service/dist/engine.js");
    engine = new ProtectionEngineService(baseDir);
    await engine.init();
    const manager = engine.scanManager;
    const start = Date.now();
    const id = await manager.startScan("custom", root);
    if (!id) throw new Error("scan recusado");
    let state = null;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      state = manager.getScan(id);
      if (state && ["completed", "cancelled", "failed"].includes(state.status)) break;
      await sleep(50);
    }
    if (!state) throw new Error("scan sem estado terminal");
    await sleep(750); // deixa o record assíncrono do histórico terminar
    let health = null;
    try { health = engine.getProtectionState(); } catch { /* health é opcional no benchmark */ }
    const elapsedMs = Date.now() - start;
    const perSec = elapsedMs > 0 ? Math.round((state.filesScanned / (elapsedMs / 1000)) * 10) / 10 : 0;
    return {
      mode: "integrated",
      state,
      elapsedMs,
      perSec,
      engineCalls: state.filesAnalyzed,
      phases: parsePerfLogs(capture.rows),
      health: health ? { engine: health.engine } : null,
      errors: capture.rows.filter((row) => row.line.startsWith("[stderr]")).slice(0, 12),
    };
  } finally {
    capture.restore();
    if (engine) await engine.dispose().catch(() => {});
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-bench-"));
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-bench-empty-"));
  console.log("[bench] mode=" + (REAL ? "integrated" : "minimal") + " files=" + FILE_COUNT + " root=" + root);
  try {
    await makeTree(root);
    const result = REAL ? await runReal(root) : await runFake(root);
    const state = result.state;
    console.log(
      "[bench] status=" + state.status + " filesScanned=" + state.filesScanned + "/" + state.filesTotal +
      " analyzed=" + state.filesAnalyzed + " excluded=" + state.filesExcluded + " failed=" + state.filesFailed +
      " elapsed=" + (result.elapsedMs / 1000).toFixed(2) + "s filesPerSec=" + result.perSec +
      " engineCalls=" + result.engineCalls,
    );
    if (result.phases) console.log("[bench] phases=" + JSON.stringify(result.phases));
    if (result.health) console.log("[bench] health=" + JSON.stringify(result.health));
    if (result.errors.length > 0) console.log("[bench] errors=" + JSON.stringify(result.errors));
    if (state.status !== "completed") process.exitCode = 1;
    if (REAL && result.health?.engine?.clamav?.status !== "active") {
      console.log("[bench] incomplete=clamav-not-active");
      process.exitCode = 2;
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    console.log("[bench] artefactos temporários removidos");
  }
}

void main().catch((error) => {
  console.error("[bench] FAIL: " + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exitCode = 1;
});
