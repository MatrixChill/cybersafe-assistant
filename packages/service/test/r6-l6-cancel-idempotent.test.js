import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ScanManager } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTerminal(mgr, id, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(2);
  }
  throw new Error(`scan ${id} não atingiu estado terminal em ${timeoutMs} ms`);
}

/** Engine com scanArtifact lento para garantir que o scan está em andamento quando cancelamos. */
function makeSlowEngine() {
  const events = [];
  const clearCalls = [];
  const abortCalls = [];
  return {
    events,
    clearCalls,
    abortCalls,
    isExcluded: () => false,
    emitScanProgress: (state) => events.push({ ...state }),
    abortEngineWork(scanId) {
      abortCalls.push(scanId);
    },
    clearClamavPrefetch(scanId) {
      clearCalls.push(scanId);
    },
    markScanAborted(scanId) {},
    async scanArtifact() {
      await sleep(10);
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
  };
}

describe("R6-L6 — cancelamento: latência, idempotência e estado terminal", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l6-cancel-"));
    const writes = [];
    for (let i = 0; i < 200; i++) {
      writes.push(fs.writeFile(path.join(tmp, `file-${i}.bin`), `x${i}`));
    }
    await Promise.all(writes);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("1. cancelScan publica 'cancelled' síncrono (latência observável < 500ms)", async () => {
    const engine = makeSlowEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 200; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);
    assert.ok(id);

    // Esperar até que realmente este a 'running' com alguns ficheiros processados.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const st = mgr.getScan(id);
      if (st?.status === "running" && (st?.filesScanned ?? 0) > 3) break;
      await sleep(5);
    }

    const st = mgr.getScan(id);
    assert.equal(st?.status, "running", `pré-condição: scan running (obtido: ${st?.status})`);

    const t0 = Date.now();
    mgr.cancelScan(id);
    const statusAfter = mgr.getScan(id)?.status;
    const latency = Date.now() - t0;

    assert.equal(statusAfter, "cancelled", "cancelScan publica 'cancelled' síncrono");
    assert.ok(latency < 500, `latência cancel→cancelled < 500ms (medido: ${latency}ms)`);
  });

  it("2. cancel duas vezes é idempotente — UM evento, UM abort", async () => {
    const engine = makeSlowEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 200; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);

    // Esperar até 'running'.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (mgr.getScan(id)?.status === "running") break;
      await sleep(5);
    }
    assert.equal(mgr.getScan(id)?.status, "running");

    // Dois cancelamentos consecutivos, sem await entre eles.
    mgr.cancelScan(id);
    mgr.cancelScan(id);
    await sleep(5);

    const state = mgr.getScan(id);
    assert.equal(state?.status, "cancelled", "estado final é 'cancelled'");

    const cancelledEvents = engine.events.filter(
      (e) => e.id === id && e.status === "cancelled",
    );
    assert.equal(
      cancelledEvents.length, 1,
      `evento 'cancelled' publicado 1 vez, não ${cancelledEvents.length}`,
    );

    const abortForId = engine.abortCalls.filter((a) => a === id);
    assert.equal(
      abortForId.length, 1,
      `abortEngineWork chamado 1 vez, não ${abortForId.length}`,
    );
  });

  it("3. estado terminal não é reaberto por cancel tardio", async () => {
    const engine = makeSlowEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 200; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed", "pré-condição: scan completado");

    const eventCountBefore = engine.events.length;
    mgr.cancelScan(id);
    await sleep(20);

    assert.equal(mgr.getScan(id)?.status, "completed", "estado não reaberto");
    assert.equal(engine.events.length, eventCountBefore, "sem novos eventos");
  });

  it("4. cancel a meio do loop: latência < 5s + estado correcto + cleanup", async () => {
    const engine = makeSlowEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 200; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);

    // Esperar até que esteja a correr e ter processado alguns ficheiros.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const st = mgr.getScan(id);
      if (st?.status === "running" && (st?.filesScanned ?? 0) > 5) break;
      await sleep(5);
    }

    const cancelTime = Date.now();
    mgr.cancelScan(id);

    const state = await waitTerminal(mgr, id, 10_000);
    const latency = Date.now() - cancelTime;

    assert.equal(state.status, "cancelled", "estado terminal é 'cancelled'");
    assert.ok(latency < 5_000, `latência < 5s (medido: ${latency}ms)`);

    // Wait for drain.
    const drainStart = Date.now();
    while (!engine.clearCalls.includes(id) && Date.now() - drainStart < 3_000) {
      await sleep(2);
    }
    assert.ok(
      engine.clearCalls.includes(id),
      `clearClamavPrefetch chamado (latência drain: ${Date.now() - drainStart}ms)`,
    );
    assert.equal(
      engine.clearCalls.filter((c) => c === id).length, 1,
      "cleanup chamado exactamente uma vez",
    );
  });
});
