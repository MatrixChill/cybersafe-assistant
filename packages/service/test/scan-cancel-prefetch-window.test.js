/**
 * P1 JANELA DE CANCEL DURANTE looksLikeZip.
 *
 * BUG (Codex finding, P1): o ciclo de classificação de ficheiros verifica
 * `isCancelled` no topo de cada iteração, mas `await this.looksLikeZip(file)`
 * é um ponto de suspensão. Se cancelScan chegar DURANTE esse await, o código
 * continua sem revalidar, o ficheiro entra em `candidatos`, e
 * `prefetchClamav` é chamado com o scan já no estado 'cancelled'.
 *
 * O que o teste prova:
 *   - o cancel chega DURANTE o await looksLikeZip (determinístico via portão);
 *   - após o portão resolver, o prefetchClamav NÃO deve ser chamado (ou, se
 *     chamado, o signal já está abortado antes da primeira instrução do corpo);
 *   - nenhum trabalho de batch arranca com o scan em estado 'cancelled'.
 *
 * RESULTADO ESPERADO COM O CÓDIGO ACTUAL: RED.
 * O prefetchClamav é chamado com o scan já cancelado porque não há verificação
 * de `isCancelled` depois do `await looksLikeZip`.
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

async function waitWorkerDrained(engine, id, timeoutMs = 3_000) {
  const start = Date.now();
  while (!engine.clearCalls.includes(id) && Date.now() - start < timeoutMs) {
    await sleep(5);
  }
  assert.ok(
    engine.clearCalls.includes(id),
    `worker não assentou em ${timeoutMs} ms: clearClamavPrefetch('${id}') nunca chamado`,
  );
}

// ── Fake engine ───────────────────────────────────────────────────────────────

function makeEngine() {
  const events        = [];
  const prefetchCalls = [];   // { scanId, calledWhileCancelled }
  const clearCalls    = [];
  const abortCalls    = [];

  const controllers = new Map();

  return {
    events,
    prefetchCalls,
    clearCalls,
    abortCalls,

    isExcluded: () => false,

    emitScanProgress(state) {
      events.push({ ...state });
    },

    abortEngineWork(scanId) {
      abortCalls.push(scanId);
      const ctrl = controllers.get(scanId);
      if (ctrl) ctrl.abort();
    },

    async prefetchClamav(filePaths, scanId, _onProgress) {
      // Regista SE foi chamado com o scan já cancelado.
      const ctrl = new AbortController();
      controllers.set(scanId, ctrl);
      prefetchCalls.push({
        scanId,
        fileCount: filePaths.length,
        // "já cancelado" significa que abortEngineWork foi chamado antes de aqui
        calledWhileCancelled: abortCalls.includes(scanId),
        // O signal reflete o estado do AbortController do engine, não do scan —
        // mas se abortEngineWork foi chamado antes, o ctrl já está abortado.
        signalAbortedOnEntry: ctrl.signal.aborted,
      });
      controllers.delete(scanId);
      return { spawned: true, files: filePaths.length };
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-cancel-zip-window-"));
  // Criar ficheiros .bin (não ZIP) para que looksLikeZip leia os magic bytes.
  const writes = [];
  for (let i = 0; i < 5; i++) {
    // Conteúdo inerte: não são ZIP (sem assinatura PK\x03\x04).
    writes.push(fs.writeFile(path.join(tmp, `file-${i}.bin`), `inerte-${i}`));
  }
  await Promise.all(writes);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

// ── Teste ─────────────────────────────────────────────────────────────────────

describe("P1 — janela de cancel durante looksLikeZip", () => {

  /**
   * O cancel chega DURANTE o await looksLikeZip do primeiro ficheiro.
   *
   * Mecanismo: sobrepõe mgr.looksLikeZip com uma versão que:
   *   1. na primeira chamada, sinaliza que entrou (gateEntered.resolve);
   *   2. fica suspensa até ser libertada (gateLatch);
   *   3. depois de libertada, resolve normalmente (false → não é ZIP).
   *
   * O teste cancela o scan enquanto o looksLikeZip está suspenso, depois
   * liberta o portão. O contrato: prefetchClamav NÃO deve ser chamado
   * (o cancel chegou antes de candidatos ser preenchido).
   */
  it("prefetchClamav não é chamado quando o cancel chega durante looksLikeZip", async () => {
    const engine = makeEngine();

    // ── portão do looksLikeZip ────────────────────────────────────────────
    let gateEnteredResolve;
    let gateLatchResolve;
    const gateEntered = new Promise((r) => { gateEnteredResolve = r; });
    const gateLatch   = new Promise((r) => { gateLatchResolve = r; });

    const mgr = new ScanManager(engine);
    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 5; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };

    // Substituir looksLikeZip: na primeira invocação, entra no portão e espera.
    let looksLikeCalls = 0;
    mgr.looksLikeZip = async (_filePath) => {
      looksLikeCalls++;
      if (looksLikeCalls === 1) {
        // Sinaliza que entrámos na janela.
        gateEnteredResolve();
        // Fica suspenso até o teste libertar o portão.
        await gateLatch;
      }
      return false; // não é ZIP — o ficheiro vai para candidatos
    };

    // ── arrancar o scan ───────────────────────────────────────────────────
    const id = await mgr.startScan("custom", tmp);
    assert.ok(id, "o scan deve arrancar");

    // ── aguardar que o looksLikeZip entre na janela ───────────────────────
    await gateEntered;

    // O scan está suspenso dentro do await looksLikeZip.
    // Confirmar que ainda não foi cancelado.
    const stateBeforeCancel = mgr.getScan(id);
    assert.ok(
      stateBeforeCancel?.status === "running" || stateBeforeCancel?.status === "queued",
      `pré-condição: o scan tem de estar running/queued antes do cancel ` +
      `(obtido: '${stateBeforeCancel?.status}')`,
    );

    // ── cancelar ENQUANTO o looksLikeZip está suspenso ────────────────────
    mgr.cancelScan(id);
    assert.equal(
      mgr.getScan(id)?.status, "cancelled",
      "cancelScan deve pôr o estado 'cancelled' imediatamente",
    );

    // ── libertar o portão: looksLikeZip resolve ───────────────────────────
    gateLatchResolve();

    // ── aguardar que o worker drene ───────────────────────────────────────
    await waitWorkerDrained(engine, id);
    const finalState = await waitTerminal(mgr, id);

    // ── ASSERÇÃO PRINCIPAL ────────────────────────────────────────────────
    //
    // Com o código ACTUAL (sem fix): o loop continua depois do looksLikeZip
    // resolver, empurra os ficheiros para candidatos, e prefetchClamav É chamado
    // com o scan já em estado 'cancelled'. Este teste deve ser RED.
    //
    // Com o fix: o loop revalida isCancelled após o await looksLikeZip, sai
    // sem preencher candidatos, e prefetchClamav NÃO é chamado.
    assert.equal(
      engine.prefetchCalls.length, 0,
      `BUG: prefetchClamav foi chamado com o scan já cancelado ` +
      `(chamadas: ${engine.prefetchCalls.length}, ` +
      `detalhes: ${JSON.stringify(engine.prefetchCalls)})`,
    );

    // Estado final tem de ser 'cancelled', nunca 'completed'.
    assert.equal(
      finalState.status, "cancelled",
      `estado final tem de ser 'cancelled' (obtido: '${finalState.status}')`,
    );

    // filesInEngineBatch tem de ser 0 (nenhum batch foi iniciado).
    assert.equal(
      finalState.filesInEngineBatch ?? 0, 0,
      `filesInEngineBatch tem de ser 0 (obtido: ${finalState.filesInEngineBatch})`,
    );
  });

  /**
   * Variante: cancel chega DEPOIS do último looksLikeZip mas ANTES de
   * prefetchClamav. Quando todos os ficheiros já foram classificados e
   * `candidatos` está preenchido, o isCancelled deve ser verificado antes
   * de chamar prefetchClamav.
   *
   * Com o código ACTUAL: a verificação `!this.isCancelled.has(id)` existe
   * no `if` exterior (antes do loop), mas não é reavaliada depois do loop.
   * Se o cancel chegar durante o ÚLTIMO looksLikeZip, o código avança para
   * o `if (candidatos.length > 0)` sem verificar novamente.
   *
   * Este teste só é observável se o código não tiver fix. Com fix, ambos
   * os testes ficam verdes.
   */
  it("prefetchClamav não arranca se cancel chegar durante o último looksLikeZip", async () => {
    const engine = makeEngine();

    const FILE_COUNT = 3;
    let gateEnteredResolve;
    let gateLatchResolve;
    const gateEntered = new Promise((r) => { gateEnteredResolve = r; });
    const gateLatch   = new Promise((r) => { gateLatchResolve = r; });

    const mgr = new ScanManager(engine);
    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < FILE_COUNT; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };

    let looksLikeCalls = 0;
    mgr.looksLikeZip = async (_filePath) => {
      looksLikeCalls++;
      // Suspender APENAS na última chamada (FILE_COUNT-ésima).
      if (looksLikeCalls === FILE_COUNT) {
        gateEnteredResolve();
        await gateLatch;
      }
      return false;
    };

    const id = await mgr.startScan("custom", tmp);
    assert.ok(id, "o scan deve arrancar");

    // Aguardar que o último looksLikeZip entre no portão.
    await gateEntered;

    // Cancelar enquanto o ÚLTIMO looksLikeZip está suspenso.
    mgr.cancelScan(id);
    assert.equal(mgr.getScan(id)?.status, "cancelled",
      "cancel durante o último looksLikeZip deve ser imediato");

    // Libertar o último looksLikeZip.
    gateLatchResolve();

    await waitWorkerDrained(engine, id);
    const finalState = await waitTerminal(mgr, id);

    // ASSERÇÃO PRINCIPAL — RED com código actual.
    assert.equal(
      engine.prefetchCalls.length, 0,
      `BUG: prefetchClamav foi chamado após o último looksLikeZip com o scan já cancelado ` +
      `(chamadas: ${engine.prefetchCalls.length}, ` +
      `detalhes: ${JSON.stringify(engine.prefetchCalls)})`,
    );

    assert.equal(finalState.status, "cancelled",
      `estado final tem de ser 'cancelled' (obtido: '${finalState.status}')`);
  });

});
