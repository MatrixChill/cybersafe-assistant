/**
 * TP-PAP-P0-SCAN-LIFECYCLE — contratos de ciclo de vida do ScanManager.
 *
 * Lacuna coberta (não duplicada pelas suites existentes):
 *  - `scan-cancel-mid-batch` / `scan-cancel-edge-cases` fixam o cancelamento
 *    ANTES ou DURANTE o batch, e a idempotência do próprio cancel;
 *  - `scan-cancel-abort-intents` (teste 4) fixa "um único evento completed"
 *    no caminho normal;
 *  - `scan-manager.test.js` fixa `filesInconclusive` no caminho SEM batch.
 *
 * Falta o cruzamento dos dois eixos:
 *  1. cancelamento REENTRANTE (disparado durante a análise do último
 *     ficheiro) a competir com a finalização natural `completed` — o contrato
 *     é UM terminal, e é `cancelled`;
 *  2. `prefetchClamav` presente + veredictos inconclusivos — o terminal não
 *     pode dizer "limpo" (`filesInconclusive` tem de sobreviver ao reconcile
 *     `analisadosNoBatch`);
 *  3. motor indisponível (`spawned:false`) + resultados inconclusivos — o
 *     terminal continua inconclusivo, nunca 0.
 *
 * Nenhum clamscan real, nenhum ficheiro do utilizador: stub de motor e
 * fixtures em diretório temporário próprio.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { ScanManager } = await import("../dist/scan-manager.js");

const TERMINAL = new Set(["completed", "cancelled", "failed"]);

/** Resultado de motor inconclusivo (mesmo shape que o engine devolve). */
function inconclusiveResult(filePath) {
  return {
    results: [{
      fileName: path.basename(filePath),
      size: 1,
      severity: "low",
      confidence: 0.2,
      rulesTriggered: [],
      riskScore: 0,
      verdict: "inconclusive",
      analysisState: "inconclusive",
      sha256: "x",
    }],
    highRiskCount: 0,
    overallSeverity: "low",
    rulesTriggered: [],
    riskScore: 0,
  };
}

function benignResult(filePath) {
  return {
    results: [{
      fileName: path.basename(filePath),
      size: 1,
      severity: "low",
      confidence: 1,
      rulesTriggered: [],
      riskScore: 0,
      verdict: "safe",
      analysisState: "completed",
      sha256: "x",
    }],
    highRiskCount: 0,
    overallSeverity: "low",
    rulesTriggered: [],
    riskScore: 0,
  };
}

/**
 * Motor stub mínimo. `abortEngineWork`/`markScanAborted` contam chamadas para
 * provar que cancelar aborta o trabalho (e só uma vez).
 */
function createStubEngine(scanArtifact) {
  const emitted = [];
  const aborted = [];
  const abortedIntents = [];
  return {
    emitted,
    aborted,
    abortedIntents,
    isExcluded: () => false,
    emitScanProgress: (state) => emitted.push({ ...state }),
    abortEngineWork: (id) => aborted.push(id),
    markScanAborted: (id) => abortedIntents.push(id),
    clearClamavPrefetch: () => {},
    scanArtifact,
  };
}

function waitTerminal(mgr, id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const state = mgr.getScan(id);
      if (state && TERMINAL.has(state.status)) return resolve(state);
      if (Date.now() > deadline) {
        return reject(new Error(`timeout à espera do terminal (estado: ${state?.status ?? "ausente"})`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("TP-PAP-P0-SCAN-LIFECYCLE — terminal único em corrida cancel/complete", () => {
  let tmpDir;
  let files;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-scan-lifecycle-"));
    files = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(tmpDir, `lifecycle-${i}.bin`);
      await fs.writeFile(p, `lifecycle-${i}`);
      files.push(p);
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /** ScanManager com walk controlado e sem ZIP real. */
  function createManager(engine, history) {
    const mgr = new ScanManager(engine, history);
    mgr.gatherFiles = async (_root, output) => output.push(...files);
    mgr.looksLikeZip = async () => false;
    return mgr;
  }

  it("cancelar durante a análise do último ficheiro deixa UM terminal: cancelled", async () => {
    let firstId = null;
    let resolveId;
    const idReady = new Promise((r) => { resolveId = r; });

    const engine = createStubEngine(async (filePath, _tipo, options) => {
      // O cancelamento dispara na análise do ÚLTIMO ficheiro — o cenário em
      // que o utilizador carrega em Cancelar quando a finalização `completed`
      // já está a caminho.
      if (options?.scanId === firstId && filePath === files[files.length - 1]) {
        await idReady;
        mgr.cancelScan(firstId);
      }
      return benignResult(filePath);
    });
    // O stub de scanArtifact é criado antes do manager; fecha sobre `mgr`.
    let mgr;
    const records = [];
    const history = { record: async (state) => { records.push({ ...state }); } };
    mgr = createManager(engine, history);

    firstId = await mgr.startScan("custom", tmpDir);
    assert.ok(firstId, "o scan tem de arrancar");
    resolveId();

    const finalState = await waitTerminal(mgr, firstId);
    assert.equal(finalState.status, "cancelled", "o terminal tem de ser cancelled, não completed");

    const events = engine.emitted.filter((e) => e.id === firstId);
    const terminals = events.filter((e) => TERMINAL.has(e.status));
    assert.equal(terminals.length, 1, `um único evento terminal (obtidos: ${terminals.length})`);
    assert.equal(terminals[0].status, "cancelled");

    const terminalIdx = events.findIndex((e) => TERMINAL.has(e.status));
    const afterTerminal = events.slice(terminalIdx + 1);
    assert.deepEqual(
      afterTerminal.filter((e) => e.status === "running" || e.status === "queued"),
      [],
      "nenhum progresso tardio pode ser publicado depois do terminal",
    );

    assert.deepEqual(engine.aborted, [firstId], "cancelar aborta o motor exactamente uma vez");
    assert.deepEqual(engine.abortedIntents, [firstId], "a intenção de abort é registada exactamente uma vez");

    const terminalRecords = records.filter((r) => TERMINAL.has(r.status));
    assert.equal(terminalRecords.length, 1, "o histórico regista o terminal exactamente uma vez");
    assert.equal(terminalRecords[0].status, "cancelled");
  });

  it("batch presente com veredictos inconclusivos: o terminal não fica 'limpo'", async () => {
    const engine = createStubEngine(async (filePath) => inconclusiveResult(filePath));
    let onProgressCalls = 0;
    engine.prefetchClamav = async (paths, _scanId, onProgress) => {
      for (let n = 1; n <= paths.length; n++) {
        onProgressCalls++;
        onProgress?.(n);
      }
      // Reconcile de cima: um veredicto terminal por ficheiro pedido.
      return { spawned: true, files: paths.length };
    };

    const mgr = createManager(engine);
    const id = await mgr.startScan("custom", tmpDir);
    assert.ok(id, "o scan tem de arrancar");

    const state = await waitTerminal(mgr, id);
    assert.equal(state.status, "completed");
    assert.ok(onProgressCalls > 0, "o prefetch do batch tem de ter corrido");
    assert.equal(state.filesAnalyzed, files.length, "todos os ficheiros entraram no eixo analisado");
    assert.equal(
      state.filesInconclusive,
      files.length,
      "cada veredicto inconclusivo conta como inconclusivo — nunca como limpo",
    );
    assert.equal(state.threatsFound, 0);
  });

  it("motor indisponível (spawned:false): inconclusivo sobrevive ao terminal", async () => {
    const engine = createStubEngine(async (filePath) => inconclusiveResult(filePath));
    engine.prefetchClamav = async () => ({ spawned: false, error: "engine unavailable" });

    const mgr = createManager(engine);
    const id = await mgr.startScan("custom", tmpDir);
    assert.ok(id, "o scan tem de arrancar");

    const state = await waitTerminal(mgr, id);
    assert.equal(state.status, "completed");
    assert.equal(
      state.filesInconclusive,
      files.length,
      "sem motor não há veredicto limpo: filesInconclusive tem de ser N, nunca 0",
    );
    assert.equal(state.threatsFound, 0);
  });
});
