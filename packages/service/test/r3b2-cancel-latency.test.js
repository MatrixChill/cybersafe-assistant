/**
 * R3-B2 — LATÊNCIA DE CANCELAMENTO MEDIDA.
 *
 * Mede o tempo entre `cancelScan(id)` e o estado terminal `cancelled`:
 * - O estado `cancelled` é publicado IMEDIATAMENTE (microsegundos) — o updateScan
 *   é síncrono dentro de cancelScan.
 * - O worker dral-o no finally (clearClamavPrefetch + clearInterval) — mede-se
 *   também o "drain time" até que `currentScanPromise` seja null.
 *
 * Cobertura existente que NÃO mede latência:
 *   - scan-cancel-mid-batch.test.js        (verifica contratos, não latência)
 *   - scan-cancel-edge-cases.test.js        (verifica idempotência, não latência)
 *   - scan-cancel-prefetch-window.test.js   (verifica janela zip, não latência)
 *   - p1-4-cancel-before-controller.test.js (verifica canário, não latência)
 *
 * Este teste acrescenta a medida REAL: cancel → terminal < 5s (teto prático).
 * Zero clamscan. Zero EICAR. Motor dublê determinístico.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ScanManager } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANCEL_TERMINAL_TIMEOUT_MS = 200;
const DRAIN_TIMEOUT_MS = 3_000;

async function waitTerminal(mgr, id, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(2);
  }
  throw new Error(`scan ${id} não atingiu terminal em ${timeoutMs} ms`);
}

async function waitWorkerDrained(engine, id, timeoutMs = 3_000) {
  const start = Date.now();
  while (!engine.clearCalls.includes(id) && Date.now() - start < timeoutMs) {
    await sleep(2);
  }
  return engine.clearCalls.includes(id);
}

function makeSlowEngine() {
  const events = [];
  const prefetchCalls = [];
  const clearCalls = [];
  return {
    events,
    prefetchCalls,
    clearCalls,
    isExcluded: () => false,
    emitScanProgress: (state) => events.push({ ...state }),
    abortEngineWork: () => {},
    clearClamavPrefetch: (scanId) => clearCalls.push(scanId),
    async prefetchClamav(_filePaths, _scanId, _onProgress) {
      prefetchCalls.push({ count: _filePaths.length });
      return { spawned: true, files: _filePaths.length };
    },
    async scanArtifact(_filePath) {
      await sleep(5);
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
  };
}

let tmp;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r3b2-cancel-"));
  const writes = [];
  for (let i = 0; i < 20; i++) {
    writes.push(fs.writeFile(path.join(tmp, `f${i}.bin`), `x${i}`));
  }
  await Promise.all(writes);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("R3-B2 — latência de cancelamento medida", () => {

  it("cancelScan publica 'cancelled' imediatamente (latência < 200ms)", async () => {
    const engine = makeSlowEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 20; i++) output.push(path.join(tmp, `f${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);
    assert.ok(id);

    await sleep(50);
    const beforeStatus = mgr.getScan(id)?.status;
    assert.ok(
      beforeStatus === "running" || beforeStatus === "queued",
      `pré-condição: scan running/queued (obtido: ${beforeStatus})`,
    );

    const t0 = Date.now();
    mgr.cancelScan(id);
    const statusAfter = mgr.getScan(id)?.status;
    const immediateLatency = Date.now() - t0;

    assert.equal(statusAfter, "cancelled", "cancelScan publica 'cancelled' síncrono");
    assert.ok(
      immediateLatency < CANCEL_TERMINAL_TIMEOUT_MS,
      `latência cancel→cancelled deve ser < ${CANCEL_TERMINAL_TIMEOUT_MS}ms (medido: ${immediateLatency}ms)`,
    );
  });

  it("worker draina dentro do teto — sem promessas penduradas (drain < 3s)", async () => {
    const engine = makeSlowEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 20; i++) output.push(path.join(tmp, `f${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);
    await sleep(30);
    const cancelTime = Date.now();
    mgr.cancelScan(id);

    await waitTerminal(mgr, id);
    const drained = await waitWorkerDrained(engine, id, DRAIN_TIMEOUT_MS);
    const drainLatency = Date.now() - cancelTime;

    assert.equal(mgr.getScan(id)?.status, "cancelled", "estado final é cancelled");
    assert.ok(drained, `worker deve dar drain dentro de ${DRAIN_TIMEOUT_MS}ms (latência: ${drainLatency}ms)`);
    assert.ok(
      engine.clearCalls.length >= 1,
      "clearClamavPrefetch chamado no finally — sem órfãos",
    );

    assert.ok(drained, `worker drainou em ${drainLatency}ms (teto: ${DRAIN_TIMEOUT_MS}ms)`);
  });

  it("cancel não deixa timers/intervalos ativos após drain", async () => {
    const engine = makeSlowEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 20; i++) output.push(path.join(tmp, `f${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);
    await sleep(30);

    mgr.cancelScan(id);
    await waitTerminal(mgr, id);
    await waitWorkerDrained(engine, id, DRAIN_TIMEOUT_MS);

    assert.equal(mgr.getActiveScan(), null, "slot libertado");
    assert.equal(mgr.getActiveScans().filter((s) => s.status === "running" || s.status === "queued").length, 0, "nenhum scan activo — sem timers órfãos");

    const id2 = await mgr.startScan("custom", tmp);
    assert.ok(id2 !== null, "novo scan aceite após drain — sem lock residual");
    await waitTerminal(mgr, id2, 10_000);
    assert.equal(mgr.getScan(id2)?.status, "completed");
  });

  it("cancel a meio do loop de ficheiros: latência < 5s mesmo com percurso longo", async () => {
    const engine = makeSlowEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 50; i++) output.push(path.join(tmp, `f${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);

    await sleep(50);
    const cancelTime = Date.now();
    mgr.cancelScan(id);

    const state = await waitTerminal(mgr, id, 10_000);
    await waitWorkerDrained(engine, id, DRAIN_TIMEOUT_MS);
    const latency = Date.now() - cancelTime;

    assert.equal(state.status, "cancelled");
    assert.ok(
      latency < 5_000,
      `cancelamento a meio do loop deve ser rápido (< 5s, medido: ${latency}ms)`,
    );
    assert.equal(engine.clearCalls.filter((c) => c === id).length, 1,
      "cleanup chamado exatamente uma vez",
    );
  });
});
