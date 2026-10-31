/**
 * P1 CANCELAMENTO — CASOS LIMITE.
 *
 * Cobre cinco casos limite que complementam scan-cancel-mid-batch.test.js:
 *
 *  1. cancel repetido (idempotência): dois cancelScan consecutivos não
 *     duplicam eventos nem chamadas a abortEngineWork.
 *  2. cancel antes do batch (fase gathering): o scan termina 'cancelled' sem
 *     qualquer registo residual de batch (filesInEngineBatch=0, prefetch=0).
 *  3. cancel depois de completed: o estado 'completed' não é reaberto.
 *  4. dispose com scan cancelado a meio: nenhum timer nem promessa pendurada.
 *  5. startScan recusado durante drain e aceite depois (foco no mesmo mgr).
 *
 * ── Padrão ──────────────────────────────────────────────────────────────────
 * Mesmo fake engine com portão de scan-cancel-mid-batch.test.js. O portão
 * permite tornar determinístico o momento em que o cancel chega relativamente
 * ao ciclo de vida do batch.
 *
 * Zero clamscan real. Zero EICAR. Zero I/O fora do tmpdir isolado.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ScanManager } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitTerminal(mgr, id, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(5);
  }
  throw new Error(`scan ${id} não atingiu estado terminal em ${timeoutMs} ms`);
}

async function waitBatchActive(mgr, id, timeoutMs = 3_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && (s.filesInEngineBatch ?? 0) > 0) return s;
    await sleep(5);
  }
  throw new Error(`batch do scan ${id} não ficou activo (filesInEngineBatch>0) em ${timeoutMs} ms`);
}

/** Aguarda clearClamavPrefetch(id) — sinal real de que o worker assentou. */
async function waitWorkerDrained(engine, id, timeoutMs = 2_000) {
  const start = Date.now();
  while (!engine.clearCalls.includes(id) && Date.now() - start < timeoutMs) {
    await sleep(5);
  }
  assert.ok(
    engine.clearCalls.includes(id),
    `worker não assentou em ${timeoutMs} ms: clearClamavPrefetch('${id}') nunca chamado ` +
    `(clearCalls: ${JSON.stringify(engine.clearCalls)})`,
  );
}

// ── Fake engine ───────────────────────────────────────────────────────────────
//
// Mesmo padrão de scan-cancel-mid-batch.test.js.
// holdBatch=true  → prefetchClamav fica preso no portão até releaseBatch().
// holdBatch=false → prefetchClamav termina imediatamente (para testes que não
//                   precisam de batch activo).
// holdGather=true → o gatherFiles no makeManager fica preso até releaseGather().

function makeEngine({ holdBatch = true, batchSize = 20 } = {}) {
  const events        = [];
  const prefetchCalls = [];
  const clearCalls    = [];
  const abortCalls    = [];

  const controllers = new Map();
  let batchEnteredResolve;
  let batchReleaseResolve;
  const batchEnteredPromise = new Promise((r) => { batchEnteredResolve = r; });
  const batchReleasePromise = new Promise((r) => { batchReleaseResolve = r; });

  return {
    events,
    prefetchCalls,
    clearCalls,
    abortCalls,

    waitForBatch: () => batchEnteredPromise,
    releaseBatch: () => batchReleaseResolve(),

    isExcluded: () => false,

    emitScanProgress(state) {
      events.push({ ...state });
    },

    abortEngineWork(scanId) {
      abortCalls.push(scanId);
      const ctrl = controllers.get(scanId);
      if (ctrl) ctrl.abort();
    },

    async prefetchClamav(filePaths, scanId, onProgress) {
      prefetchCalls.push({ count: filePaths.length, scanId });
      const ctrl = new AbortController();
      controllers.set(scanId, ctrl);

      try {
        if (holdBatch) {
          batchEnteredResolve();
          await batchReleasePromise;
          if (ctrl.signal.aborted) return { spawned: true };
        }

        for (let n = 1; n <= batchSize; n++) {
          if (ctrl.signal.aborted) break;
          if (typeof onProgress === "function") onProgress(n);
        }
      } finally {
        controllers.delete(scanId);
      }

      await sleep(2);
      return { spawned: true };
    },

    clearClamavPrefetch(scanId) {
      clearCalls.push(scanId);
    },

    async scanArtifact(filePath) {
      return {
        results: [{
          fileName: path.basename(filePath),
          size: 1, severity: "low", confidence: 1,
          rulesTriggered: [], riskScore: 0, verdict: "safe", sha256: "x",
        }],
        totalFiles: 1, highRiskCount: 0,
        overallSeverity: "low", rulesTriggered: [], riskScore: 0,
      };
    },
  };
}

// ── Fixture ───────────────────────────────────────────────────────────────────

let tmp;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-cancel-edge-"));
  const writes = [];
  for (let i = 0; i < 20; i++) {
    writes.push(fs.writeFile(path.join(tmp, `file-${i}.bin`), `x${i}`));
  }
  await Promise.all(writes);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/**
 * makeManager padrão: gatherFiles controlado, sem filesystem real.
 * holdGather: se verdadeiro, gatherFiles fica preso até releaseGather().
 */
function makeManager(engine, { holdGather = false } = {}) {
  let gatherRelease;
  const gatherGate = holdGather
    ? new Promise((r) => { gatherRelease = r; })
    : Promise.resolve();

  const mgr = new ScanManager(engine);
  mgr.gatherFiles = async (_root, output) => {
    if (holdGather) await gatherGate;
    for (let i = 0; i < 20; i++) output.push(path.join(tmp, `file-${i}.bin`));
  };
  mgr.looksLikeZip = async () => false;

  return { mgr, releaseGather: () => { if (gatherRelease) gatherRelease(); } };
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe("P1 — cancelamento: casos limite", () => {

  /**
   * CASO 1 — Cancel repetido é idempotente.
   *
   * Dois cancelScan consecutivos sobre o mesmo scan em curso:
   *   - o estado continua 'cancelled' (não há segundo estado);
   *   - o evento 'cancelled' é publicado exactamente uma vez;
   *   - abortEngineWork é chamado exactamente uma vez.
   */
  it("1. cancel repetido é idempotente — um evento, um abort", async () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    // Dois cancelamentos consecutivos, sem await entre eles.
    mgr.cancelScan(id);
    mgr.cancelScan(id);

    engine.releaseBatch();
    await waitTerminal(mgr, id);

    // Estado final.
    assert.equal(mgr.getScan(id)?.status, "cancelled",
      "estado final tem de ser 'cancelled'");

    // Evento 'cancelled' publicado exactamente uma vez.
    const cancelledEvents = engine.events.filter(
      (e) => e.id === id && e.status === "cancelled",
    );
    assert.equal(
      cancelledEvents.length, 1,
      `o evento 'cancelled' deve ser publicado 1 vez, não ${cancelledEvents.length}`,
    );

    // abortEngineWork chamado exactamente uma vez com o id certo.
    const abortForId = engine.abortCalls.filter((a) => a === id);
    assert.equal(
      abortForId.length, 1,
      `abortEngineWork deve ser chamado 1 vez, não ${abortForId.length} ` +
      `(chamadas: ${JSON.stringify(engine.abortCalls)})`,
    );
  });

  /**
   * CASO 2 — Cancel antes do batch entrar (fase gathering).
   *
   * O scan é cancelado enquanto o gatherFiles ainda está em curso (antes de
   * prefetchClamav ser chamado):
   *   - o estado fica 'cancelled';
   *   - filesInEngineBatch é 0 (nunca houve batch);
   *   - prefetchClamav nunca foi chamado.
   */
  it("2. cancel durante gathering — sem registo residual de batch", async () => {
    const engine = makeEngine({ holdBatch: true });
    const { mgr, releaseGather } = makeManager(engine, { holdGather: true });

    const id = await mgr.startScan("custom", tmp);
    assert.ok(id, "o scan tem de arrancar");

    // Aguardar que o scan entre em 'running' (gathering ainda não terminou).
    const runningDeadline = Date.now() + 3_000;
    while (mgr.getScan(id)?.status !== "running" && Date.now() < runningDeadline) {
      await sleep(5);
    }
    assert.equal(mgr.getScan(id)?.status, "running",
      "pré-condição: scan tem de estar running antes do cancel");

    // Cancelar enquanto o gather está preso no portão.
    mgr.cancelScan(id);
    assert.equal(mgr.getScan(id)?.status, "cancelled",
      "cancelScan durante gathering deve pôr o estado 'cancelled' imediatamente");

    // Libertar o gather para que o worker termine sem ficar pendurado.
    releaseGather();

    // Aguardar que o worker drene (clearClamavPrefetch chamado no finally).
    await waitWorkerDrained(engine, id);

    const finalState = mgr.getScan(id);
    assert.equal(finalState?.status, "cancelled",
      `estado final tem de ser 'cancelled' (obtido: '${finalState?.status}')`);

    // Sem batch activo em momento algum.
    assert.equal(
      finalState?.filesInEngineBatch ?? 0, 0,
      `filesInEngineBatch tem de ser 0 (obtido: ${finalState?.filesInEngineBatch})`,
    );

    // prefetchClamav nunca foi chamado (o cancel chegou antes do gather terminar).
    assert.equal(
      engine.prefetchCalls.length, 0,
      `prefetchClamav não deve ter sido chamado (chamadas: ${engine.prefetchCalls.length})`,
    );
  });

  /**
   * CASO 3 — Cancel depois de completed não reabre o estado.
   *
   * Um cancelScan chamado depois de o scan já estar 'completed':
   *   - o estado mantém-se 'completed';
   *   - nenhum novo evento é publicado.
   */
  it("3. cancel depois de completed — estado não é reaberto", async () => {
    const engine = makeEngine({ holdBatch: false });
    const { mgr } = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    const finalState = await waitTerminal(mgr, id);

    assert.equal(finalState.status, "completed",
      `pré-condição: scan tem de ter completado (obtido: '${finalState.status}')`);

    const eventCountBefore = engine.events.length;

    // Cancelar um scan já terminal.
    mgr.cancelScan(id);
    await sleep(20); // dar tempo a qualquer efeito assíncrono residual

    // Estado continua 'completed'.
    assert.equal(
      mgr.getScan(id)?.status, "completed",
      `cancelScan depois de completed não pode reabrir o estado ` +
      `(obtido: '${mgr.getScan(id)?.status}')`,
    );

    // Nenhum evento novo publicado.
    assert.equal(
      engine.events.length, eventCountBefore,
      `cancelScan tardio não deve publicar eventos ` +
      `(eventos adicionais: ${engine.events.length - eventCountBefore})`,
    );

    // abortEngineWork não é chamado para um scan já terminal.
    assert.equal(
      engine.abortCalls.filter((a) => a === id).length, 0,
      `abortEngineWork não deve ser chamado para um scan já terminal ` +
      `(chamadas: ${JSON.stringify(engine.abortCalls)})`,
    );
  });

  /**
   * CASO 4 — Dispose com scan cancelado a meio não deixa promessas penduradas.
   *
   * O ScanManager não tem método dispose próprio, mas o contrato equivalente
   * é: depois de cancelScan + drain do worker, currentScanPromise é null e
   * não há timers a segurar o processo de teste. Verificamos que:
   *   - o worker drena dentro do timeout (clearClamavPrefetch chamado);
   *   - getActiveScan() é null;
   *   - um startScan novo é aceite (prova que o slot foi libertado).
   *
   * Se o worker ficasse pendurado, o teste excederia o timeout do node --test
   * e apareceria como FAIL — não como hang silencioso.
   */
  it("4. dispose equivalente — sem promessas penduradas após cancel a meio", async () => {
    const engine = makeEngine({ holdBatch: true });
    const { mgr } = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    // Cancelar a meio do batch.
    mgr.cancelScan(id);
    assert.equal(mgr.getScan(id)?.status, "cancelled");

    // Libertar o portão (simula o ClamAV a terminar).
    engine.releaseBatch();

    // O worker tem de drenar dentro de 2 s — sem pendurar.
    await waitWorkerDrained(engine, id);

    // Slot libertado.
    assert.equal(mgr.getActiveScan(), null,
      "getActiveScan deve ser null depois do drain");

    // Um novo scan é aceite — prova que currentScanPromise é null.
    const engine2 = makeEngine({ holdBatch: false });
    // Reutilizamos o mesmo mgr para confirmar que o slot foi mesmo libertado.
    // Substituímos o engine para que o segundo scan complete sem batch activo.
    mgr.engine = engine2;
    const id2 = await mgr.startScan("custom", tmp);
    assert.ok(id2 !== null && id2 !== undefined,
      `startScan após drain tem de ser aceite (obtido: ${id2})`);
    assert.notEqual(id2, id, "o segundo scan tem id diferente");

    // Aguardar que o segundo scan complete para não deixar workers vivos.
    await waitTerminal(mgr, id2, 5_000);
    assert.equal(mgr.getScan(id2)?.status, "completed");
  });

  /**
   * CASO 5 — startScan recusado durante drain e aceite depois.
   *
   * Enquanto o worker do scan cancelado ainda está a drenar:
   *   - startScan devolve null (slot ocupado);
   * Depois do drain (clearClamavPrefetch chamado):
   *   - startScan é aceite (devolve id não-null).
   *
   * Este caso testa especificamente o mesmo manager (não um manager novo),
   * com foco na janela entre cancelScan e o drain, e na janela após o drain.
   */
  it("5. startScan recusado durante drain e aceite depois do drain", async () => {
    const engine = makeEngine({ holdBatch: true });
    const { mgr } = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    mgr.cancelScan(id);

    // ── Durante o drain (portão ainda fechado) ────────────────────────────
    // O worker ainda não terminou: clearCalls não inclui id.
    assert.ok(!engine.clearCalls.includes(id),
      "pré-condição: o worker ainda não dreneu antes de releaseBatch");

    const idDuringDrain = await mgr.startScan("custom", tmp);
    assert.equal(
      idDuringDrain, null,
      `startScan durante o drain tem de devolver null ` +
      `(obtido: ${idDuringDrain})`,
    );

    // ── Libertar o portão ─────────────────────────────────────────────────
    engine.releaseBatch();
    await waitWorkerDrained(engine, id);

    // ── Depois do drain ───────────────────────────────────────────────────
    const id3 = await mgr.startScan("custom", tmp);
    assert.ok(
      id3 !== null && id3 !== undefined,
      `startScan depois do drain tem de ser aceite (obtido: ${id3})`,
    );
    assert.notEqual(id3, id,
      "o scan após drain tem id diferente do cancelado");

    // Limpar: cancelar o id3 para não deixar worker pendurado.
    mgr.cancelScan(id3);
    await waitTerminal(mgr, id3, 3_000).catch(() => {});
  });

});
