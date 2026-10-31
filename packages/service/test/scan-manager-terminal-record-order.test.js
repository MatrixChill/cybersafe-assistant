/**
 * scan-manager-terminal-record-order.test.js
 *
 * #38 (retoma Qoder) — ordem entre o registo persistente e o evento terminal.
 *
 * O fix Kilo (try/finally) garante a tentativa de registo mesmo se
 * emitScanProgress lancar. Mas na ordem original o emit acontecia ANTES do
 * record, e a UI refresca o historico em resposta ao evento terminal
 * (FileScannerPage -> ScanHistoryPanel, via sessionTerminada). A leitura
 * disparada pelo evento podia chegar ao ficheiro antes da linha em curso na
 * chain do record (scan-history.ts: chain.then(run) -> readEntries ->
 * appendFile).
 *
 * Este teste fecha a decisao (a) do QA OpenCode de 16/10: o registo e
 * INICIADO antes da emissao. Asserencias:
 *   1. ordem de INICIO [record, emit] para um estado terminal;
 *   2. o emit NAO espera a resolucao do record (promessa diferida — um
 *      record lento nao atrasa o evento terminal; invariante "o recorder
 *      nunca bloqueia o estado" preservada);
 *   3. um recorder que lanca de forma sincrona nao suprime o evento
 *      terminal (o emit continua a acontecer).
 *
 * ScanHistory.query captura a chain existente ao iniciar e aguarda os registos
 * enfileirados antes de ler. O teste usa uma promise diferida para provar que
 * a consulta disparada pelo evento não lê antes do commit, sem sleeps.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { ScanManager } from "../dist/scan-manager.js";
import { ScanHistory } from "../dist/scan-history.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const FIXTURE_DIR = path.join(os.tmpdir(), "cs-qoder-order-fixture");
const FIXTURE = path.join(FIXTURE_DIR, "benign.txt");

function makeQuietEngine(order, onEmit = () => {}) {
  return {
    isExcluded: () => false,
    exclusionCategory: () => null,
    emitScanProgress(state) {
      order.push("emit:" + state.status);
      onEmit(state);
    },
    async scanArtifact() {
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    clearClamavPrefetch: () => {},
    markScanAborted: () => {},
    abortEngineWork: () => {},
  };
}

async function ensureFixture() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true }).catch(() => {});
  try {
    await fs.writeFile(FIXTURE, "fixture benigno para teste de ordem", "utf8");
  } catch {
    /* ja existe */
  }
}

const terminalUpdates = () => ({
  status: "completed",
  phase: "finalizing",
  progress: 100,
  filesScanned: 1,
  filesAnalyzed: 1,
  filesExcluded: 0,
  filesFailed: 0,
  threatsFound: 0,
  endTime: new Date().toISOString(),
});

describe("scan-manager: registo do historico iniciado antes do evento terminal (#38 ordem)", () => {
  it("ordem de inicio: record comeca antes do emit e o emit nao espera pela resolucao do record", async () => {
    await ensureFixture();
    const order = [];
    const writeGate = deferred();
    const recordFinished = deferred();
    const mgr = new ScanManager(makeQuietEngine(order), {
      record: (state) => {
        order.push("record:" + state.status); // inicio sincrono da chamada
        return writeGate.promise.then(() => {
          order.push("record-done");
          recordFinished.resolve();
        });
      },
    });

    const id = await mgr.startScan("quick", FIXTURE);
    assert.ok(id);
    mgr.updateScan(id, { status: "running", phase: "preparing" });
    order.length = 0; // ignorar eventos nao terminais

    mgr.updateScan(id, terminalUpdates());

    // O evento terminal ja foi emitido enquanto o record continua por resolver.
    assert.deepEqual(order, ["record:completed", "emit:completed"], "record inicia antes do emit; o emit nao aguarda a promessa do record");

    writeGate.resolve();
    await recordFinished.promise;
    assert.deepEqual(order, ["record:completed", "emit:completed", "record-done"], "a promessa do record resolve depois, de forma diferida");

    // exactly-once mantido apos a reordenacao: o mesmo scanId nao regista duas vezes.
    assert.equal(order.filter((e) => e.startsWith("record:")).length, 1);
  });

  it("recorder que lanca de forma sincrona nao suprime o evento terminal", async () => {
    await ensureFixture();
    const order = [];
    const mgr = new ScanManager(makeQuietEngine(order), {
      record: () => {
        throw new Error("recorder avariado (throw sincrono)");
      },
    });

    const id = await mgr.startScan("quick", FIXTURE);
    assert.ok(id);
    mgr.updateScan(id, { status: "running", phase: "preparing" });
    order.length = 0;

    let lancou = false;
    try {
      mgr.updateScan(id, terminalUpdates());
    } catch {
      lancou = true;
    }
    assert.equal(lancou, false, "o throw sincrono do recorder nao propaga para o caller");
    assert.deepEqual(order, ["emit:completed"], "o renderer recebe o evento terminal mesmo com recorder avariado");
    assert.equal(mgr.getScan(id).status, "completed", "o estado em memoria fica terminal na mesma");
  });

  it("query iniciada dentro do emit terminal espera o append e devolve a linha persistida", async () => {
    await ensureFixture();
    const historyFile = path.join(FIXTURE_DIR, "query-after-terminal.jsonl");
    await fs.rm(historyFile, { force: true });
    const history = new ScanHistory(historyFile);
    const writeGate = deferred();
    let writeReleased = false;
    // Simula uma escrita já enfileirada e bloqueada, sem timers nem sleeps.
    history.chain = writeGate.promise;

    const readEntries = history.readEntries.bind(history);
    let readBeforeCommit = false;
    history.readEntries = (...args) => {
      if (!writeReleased) readBeforeCommit = true;
      return readEntries(...args);
    };

    let queryPromise;
    let queryResolved = false;
    const mgr = new ScanManager(makeQuietEngine([], (state) => {
      if (state.status === "completed") {
        queryPromise = history.query().then((page) => {
          queryResolved = true;
          return page;
        });
      }
    }), history);

    const id = await mgr.startScan("quick", FIXTURE);
    assert.ok(id);
    mgr.updateScan(id, { status: "running", phase: "preparing" });
    mgr.updateScan(id, terminalUpdates());

    try {
      assert.ok(queryPromise, "o listener inicia a consulta dentro da emissão terminal");
      assert.equal(readBeforeCommit, false, "query não lê o ficheiro antes da chain de escrita terminar");
      assert.equal(queryResolved, false, "query fica pendente enquanto o registo não comita");
    } finally {
      writeReleased = true;
      writeGate.resolve();
    }

    const page = await queryPromise;
    assert.equal(page.entries.filter((entry) => entry.id === id).length, 1, "a query posterior ao commit contém exatamente a linha do scan");
    const persisted = await fs.readFile(historyFile, "utf8");
    assert.equal(persisted.trim().split("\n").length, 1, "o scan é persistido uma única vez");
  });

  it("falha de I/O no histórico não bloqueia o terminal e a query termina", async () => {
    await ensureFixture();
    const blocker = path.join(FIXTURE_DIR, "not-a-directory");
    await fs.writeFile(blocker, "fixture");
    const history = new ScanHistory(path.join(blocker, "scans.jsonl"));
    const mgr = new ScanManager(makeQuietEngine([]), history);
    const id = await mgr.startScan("quick", FIXTURE);
    assert.ok(id);

    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
      assert.doesNotThrow(() => mgr.updateScan(id, terminalUpdates()));
      const page = await history.query();
      assert.deepEqual(page.entries, [], "I/O indisponível resulta em página vazia, sem rejeitar a query");
      assert.equal(mgr.getScan(id).status, "completed", "o estado terminal continua publicado");
      assert.equal(errors.length, 1, "a falha de gravação é registada sem expor caminho");
    } finally {
      console.error = originalError;
    }
  });
});
