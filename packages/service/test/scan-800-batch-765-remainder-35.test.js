import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ScanManager } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp;
let fixturePaths;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-scan-800-"));
  const writes = [];
  fixturePaths = [];
  for (let i = 0; i < 765; i++) {
    const filePath = path.join(tmp, `regular-${i}.bin`);
    fixturePaths.push(filePath);
    writes.push(fs.writeFile(filePath, `x${i}`));
  }
  for (let i = 0; i < 35; i++) {
    const filePath = path.join(tmp, `excluded-${i}.tmp`);
    fixturePaths.push(filePath);
    writes.push(fs.writeFile(filePath, `y${i}`));
  }
  await Promise.all(writes);
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

function makeManager(engine, scanPaths = fixturePaths) {
  const manager = new ScanManager(engine);
  // The contract concerns ScanManager's batch/remainder loop, not filesystem
  // enumeration. Feed the exact fixture deterministically.
  manager.gatherFiles = async (_root, output) => output.push(...scanPaths);
  manager.looksLikeZip = async () => false;
  return manager;
}

function makeEngine({ batchProgress = true, holdBatch = false } = {}) {
  const events = [];
  const prefetchCalls = [];
  const clearCalls = [];
  const callbacks = [];
  const excludedExt = ".tmp";
  const scannedPaths = new Set();
  const excludedPaths = new Set();
  const controllers = new Map();
  let prefetchSettled = false;
  let releaseBatch;
  let batchEntered;
  const batchEnteredPromise = new Promise((resolve) => { batchEntered = resolve; });
  const batchReleasePromise = new Promise((resolve) => { releaseBatch = resolve; });
  return {
    events,
    prefetchCalls,
    clearCalls,
    callbacks,
    scannedPaths,
    prefetchSettled: () => prefetchSettled,
    waitForBatch: () => batchEnteredPromise,
    releaseBatch: () => releaseBatch(),
    excludedPaths,
    isExcluded: (filePath) => {
      const excluded = path.extname(filePath).toLowerCase() === excludedExt;
      if (excluded) excludedPaths.add(filePath);
      return excluded;
    },
    emitScanProgress: (state) => events.push({ ...state }),
    abortEngineWork: (scanId) => {
      const ctrl = controllers.get(scanId);
      if (ctrl) ctrl.abort();
    },
    async prefetchClamav(filePaths, scanId, onProgress) {
      prefetchCalls.push({ count: filePaths.length, scanId, paths: [...filePaths] });
      const ctrl = new AbortController();
      controllers.set(scanId, ctrl);
      if (!batchProgress || typeof onProgress !== "function") {
        await sleep(5);
        controllers.delete(scanId);
        return { spawned: true };
      }
      try {
        if (holdBatch) {
          batchEntered();
          await batchReleasePromise;
          if (ctrl.signal.aborted) return { spawned: true };
        }
        for (let n = 1; n <= 765; n++) {
          if (ctrl.signal.aborted) break;
          onProgress(n);
          callbacks.push({ scanId, n, afterCancel: ctrl.signal.aborted });
        }
      } finally {
        controllers.delete(scanId);
      }
      await sleep(5);
      prefetchSettled = true;
      return { spawned: true };
    },
    clearClamavPrefetch: (scanId) => clearCalls.push(scanId),
    async scanArtifact(filePath) {
      scannedPaths.add(filePath);
      return {
        results: [{
          fileName: path.basename(filePath),
          size: 1,
          severity: "low",
          confidence: 1,
          rulesTriggered: [],
          riskScore: 0,
          verdict: "safe",
          sha256: "x",
        }],
        totalFiles: 1,
        highRiskCount: 0,
        overallSeverity: "low",
        rulesTriggered: [],
        riskScore: 0,
      };
    },
  };
}

async function waitTerminal(mgr, id, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(10);
  }
  throw new Error("o scan não atingiu estado terminal");
}

async function waitBatchActive(mgr, id, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && (s.filesInEngineBatch ?? 0) > 0) return s;
    await sleep(10);
  }
  throw new Error("batch não ficou ativo dentro do timeout");
}

describe("scan-800-batch-765-remainder-35", () => {
  it("765 batch callbacks reportam 1..765 e o batch termina", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);
    const id = await mgr.startScan("custom", tmp);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed");
    assert.equal(state.filesScanned, 800);
    assert.equal(state.filesAnalyzed, 765);
    assert.equal(state.filesExcluded, 35);
    assert.equal(state.filesTotal, 800);
    assert.equal(engine.prefetchCalls.length, 1);
    assert.equal(engine.prefetchCalls[0].count, 765);
    assert.equal(engine.clearCalls.length, 1);
    assert.equal(engine.clearCalls[0], id);
    assert.equal(mgr.getActiveScan(), null);

    assert.equal(engine.callbacks.length, 765, "onProgress chamado 765 vezes");
    assert.equal(engine.callbacks[0].n, 1, "primeiro callback é 1");
    assert.equal(engine.callbacks[engine.callbacks.length - 1].n, 765, "último callback é 765");
    for (let i = 1; i < engine.callbacks.length; i++) {
      const prev = engine.callbacks[i - 1].n;
      const curr = engine.callbacks[i].n;
      assert.equal(curr, prev + 1, `callback ${i} não é consecutivo: ${prev} -> ${curr}`);
    }

    assert.equal(engine.scannedPaths.size, 765, "scanArtifact chamado só para os 765 não-excluded");
    assert.equal(engine.excludedPaths.size, 35, "35 paths marcados como excluded");
  });

  it("os eventos durante o batch levam o scanId certo e filesInEngineBatch=765", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);
    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    const batchEvents = engine.events.filter((e) => (e.filesInEngineBatch ?? 0) > 0);
    assert.ok(batchEvents.length > 0, "não houve eventos durante o batch");
    for (const e of batchEvents) {
      assert.equal(e.id, id, `evento com id errado: ${e.id} != ${id}`);
      assert.equal(e.filesInEngineBatch, 765);
      assert.ok(e.filesAnalyzed >= 0 && e.filesAnalyzed <= 765);
    }
    const afterBatch = engine.events.filter((e) => (e.filesInEngineBatch ?? 0) === 0);
    assert.ok(afterBatch.length > 0, "depois do batch não houve eventos de continuação");

    const terminal = engine.events.filter((e) => ["completed", "cancelled", "failed"].includes(e.status));
    assert.ok(terminal.length >= 1, "evento terminal presente");
    const last = engine.events[engine.events.length - 1];
    assert.equal(last.status, "completed", "último evento é completed");
    assert.equal(last.filesInEngineBatch, 0, "batch finalizado com filesInEngineBatch=0");
    assert.equal(last.filesAnalyzed, 765);
    assert.equal(last.filesScanned, 800);
    assert.equal(last.phase, "finalizing", "fase final é finalizing");
  });

  it("o remainder 35 (excluded) não entra no batch e conta como excluded", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);
    const id = await mgr.startScan("custom", tmp);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.filesExcluded, 35);
    assert.equal(state.filesAnalyzed, 765);
    assert.equal(state.filesScanned, 800);
    assert.equal(state.filesTotal, 800);
  });

  it("processes the 35 eligible ZIP remainder after the 765-file batch resolves", async () => {
    const regularPaths = fixturePaths.slice(0, 765);
    const remainderZipPaths = [];
    for (let i = 0; i < 35; i++) {
      const zipPath = path.join(tmp, `remainder-${i}.zip`);
      remainderZipPaths.push(zipPath);
      await fs.writeFile(zipPath, "fixture ZIP placeholder");
    }
    const paths = [...regularPaths, ...remainderZipPaths];
    const engine = makeEngine();
    const mgr = makeManager(engine, paths);
    const zipScanCalls = [];
    const batchStateAtArtifactScan = [];
    const prefetchSettledAtArtifactScan = [];
    const prefetchCleanupCountAtArtifactScan = [];

    // Isolate the ScanManager contract: ZIP parsing has its own implementation
    // and tests; this verifies selection, ordering, counters, and terminal state.
    mgr.scanZipWithSafety = async (scanId, zipPath) => {
      zipScanCalls.push({ scanId, zipPath });
      return 1;
    };
    const scanArtifact = engine.scanArtifact.bind(engine);
    engine.scanArtifact = async (filePath, ...args) => {
      if (path.extname(filePath).toLowerCase() === ".zip") {
        const latest = engine.events.at(-1);
        batchStateAtArtifactScan.push(latest?.filesInEngineBatch ?? null);
        prefetchSettledAtArtifactScan.push(engine.prefetchSettled());
        prefetchCleanupCountAtArtifactScan.push(engine.clearCalls.length);
      }
      return scanArtifact(filePath, ...args);
    };

    const id = await mgr.startScan("custom", tmp);
    const state = await waitTerminal(mgr, id);

    assert.equal(engine.prefetchCalls.length, 2, "batch principal + batch dos ZIP externos");
    assert.equal(engine.prefetchCalls[0].count, 765);
    assert.deepEqual(engine.prefetchCalls[0].paths, regularPaths);
    assert.equal(engine.prefetchCalls[1].count, 35, "os ZIP externos passam por UM batch, nunca por um clamscan cada");
    assert.deepEqual(engine.prefetchCalls[1].paths, remainderZipPaths);
    assert.equal(engine.callbacks.length, 765);
    assert.equal(engine.callbacks.at(-1).n, 765);
    assert.deepEqual(zipScanCalls, remainderZipPaths.map((zipPath) => ({ scanId: id, zipPath })));
    assert.equal(engine.scannedPaths.size, 800, "each outer candidate calls scanArtifact once");
    assert.deepEqual(batchStateAtArtifactScan, Array(35).fill(0), "remainder starts after batch is cleared");
    assert.deepEqual(prefetchSettledAtArtifactScan, Array(35).fill(true), "remainder starts after the batch promise resolves");
    assert.deepEqual(prefetchCleanupCountAtArtifactScan, Array(35).fill(0), "prefetch state remains owned until all scanArtifact calls finish");
    assert.equal(state.filesScanned, 800);
    assert.equal(state.filesAnalyzed, 800, "765 batch + 35 individually analyzed, with no double count");
    assert.equal(state.filesExcluded, 0);
    assert.equal(state.filesFailed, 0);
    assert.equal(state.threatsFound, 35, "simulated ZIP findings are included in final result");
    assert.equal(state.filesTotal, 800);
    assert.equal(state.status, "completed");
    assert.equal(engine.events.at(-1).status, "completed", "terminal completion event is published");
    assert.equal(engine.events.at(-1).filesScanned, 800);
    assert.equal(engine.events.at(-1).filesAnalyzed, 800);
    assert.equal(engine.clearCalls.length, 1);
    assert.equal(engine.clearCalls[0], id);
    assert.equal(mgr.getActiveScan(), null);
  });

  it("cancelar durante o batch não publica completed tardio e conserva o lock até cleanup", async () => {
    const engine = makeEngine({ holdBatch: true });
    const mgr = makeManager(engine);
    const id = await mgr.startScan("custom", tmp);

    await engine.waitForBatch();
    mgr.cancelScan(id);
    assert.equal(mgr.getScan(id).status, "cancelled");

    // Um estado terminal visível ainda não significa que o worker limpou o
    // batch: enquanto a Promise está pendente, o segundo start tem de aguardar.
    const secondWhileDraining = await mgr.startScan("custom", tmp);
    if (secondWhileDraining) mgr.cancelScan(secondWhileDraining);

    engine.releaseBatch();
    const expectedCleanupCalls = secondWhileDraining ? 2 : 1;
    for (let i = 0; i < 200; i++) {
      if (engine.clearCalls.length === expectedCleanupCalls) break;
      await sleep(10);
    }
    assert.equal(engine.clearCalls.length, expectedCleanupCalls, "cleanup de todos os workers aceites termina");
    assert.equal(mgr.getActiveScan(), null);
    assert.equal(engine.events.filter((e) => e.status === "completed").length, 0);
    assert.equal(secondWhileDraining, null, "não pode haver overlap durante o cleanup pós-cancel");

    const id2 = await mgr.startScan("custom", tmp);
    assert.ok(id2, "novo scan permitido só depois de terminar o cleanup");
    const final = await waitTerminal(mgr, id2);
    assert.equal(final.status, "completed");
  });

  it("segundo scan rejeitado enquanto o primeiro está ativo", async () => {
    const engine = makeEngine({ holdBatch: true });
    const mgr = makeManager(engine);
    const id1 = await mgr.startScan("custom", tmp);
    await engine.waitForBatch();

    const id2 = await mgr.startScan("custom", tmp);
    assert.equal(id2, null, "segundo scan deve ser rejeitado enquanto o primeiro está ativo");

    engine.releaseBatch();
    const terminal = await waitTerminal(mgr, id1);
    assert.equal(terminal.status, "completed");
    assert.equal(mgr.getActiveScan(), null);
  });

  it("nenhum evento de um scan vaza para o scan seguinte", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const idA = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, idA);
    const eventsA = engine.events.slice();
    engine.events.length = 0;

    const idB = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, idB);
    const eventsB = engine.events.slice();

    assert.notEqual(idA, idB);
    for (const e of eventsA) assert.equal(e.id, idA, `evento do scan A vazou para o scan B`);
    for (const e of eventsB) assert.equal(e.id, idB, `evento do scan B vazou para o scan A`);
  });

  it("prefetch cleanup é chamado exatamente uma vez no terminal", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);
    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    assert.equal(engine.clearCalls.length, 1);
    assert.equal(engine.clearCalls[0], id);
  });
});
