/**
 * scan-manager-terminal-history-race.test.js
 *
 * Reproduz a corrida "terminal vs history.record" em
 * packages/service/src/scan-manager.ts:updateScan (linha ~305-316):
 *
 *   this.activeScans.set(id, updated);        // estado terminal na memoria
 *   this.engine.emitScanProgress(updated);    // emissao sincronica (pode lancar)
 *   if (TERMINAL.includes(updated.status)) {  // historia persistente
 *     void this.history?.record(updated).catch(() => undefined);  // fire-and-forget
 *   }
 *
 * Se emitScanProgress lancar, o estado fica terminal na memoria mas
 * history.record nunca e chamado: inconsistencia terminal vs history.
 *
 * Contrato a proteger: uma vez que o estado e' terminal na memoria, o registo
 * no historico deve ser tentado exactamente-once por scanId, mesmo que a
 * emissao de progresso falhe.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { ScanManager } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ficheiro de fixture benigno em temp isolado (nunca pastas pessoais reais).
const FIXTURE_DIR = path.join(os.tmpdir(), "cs-k1-fixture");
const FIXTURE = path.join(FIXTURE_DIR, "benign.txt");

// Engine duplo: emitScanProgress LANCA quando recebe um estado terminal.
function makeFailingTerminalEngine() {
  return {
    isExcluded: () => false,
    exclusionCategory: () => null,
    emitScanProgress(state) {
      if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") {
        throw new Error("emissao de progresso falhou (estado terminal)");
      }
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
    await fs.writeFile(FIXTURE, "ficheiro de fixture benigno para regressao K1", "utf8");
  } catch {
    /* ja existe */
  }
}

describe("scan-manager: estado terminal e historial persistente (race terminal vs history.record)", () => {
  it("registra o estado terminal no historial mesmo que a emissao de progresso lance", async () => {
    await ensureFixture();
    const historyCalls = [];
    const engine = makeFailingTerminalEngine();
    const mgr = new ScanManager(engine, {
      record: async (state) => { historyCalls.push(state); },
    });

    const id = await mgr.startScan("quick", FIXTURE);
    assert.ok(id, "startScan deve devolver um id");

    // Leva o estado a "running" (acesso privado via cast: testes JS sobre TS compilado).
    mgr.updateScan(id, { status: "running", phase: "preparing" });
    assert.equal(historyCalls.length, 0, "um estado não terminal não é registado no histórico");

    // Estado terminal: emitScanProgress deve lancar. O historial deve ser registado mesmo assim.
    let lancou = false;
    try {
      mgr.updateScan(id, {
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
    } catch (erro) {
      lancou = true;
    }
    assert.equal(lancou, true, "emitScanProgress deve ter lancado (setup do RED)");

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed", "o estado em memoria deve ficar terminal");
    assert.equal(historyCalls.length, 1, "history.record deve ser chamado exactamente uma vez");
    assert.equal(historyCalls[0].id, id);
    assert.equal(historyCalls[0].status, "completed");
  });

  it("estado terminal ja em memoria nao e reescrito nem gera registo duplicado no historial", async () => {
    await ensureFixture();
    const historyCalls = [];
    const engine = makeFailingTerminalEngine();
    const mgr = new ScanManager(engine, {
      record: async (state) => { historyCalls.push(state); },
    });

    const id = await mgr.startScan("quick", FIXTURE);
    assert.ok(id);

    let lancou1 = false;
    try {
      mgr.updateScan(id, { status: "completed", progress: 100, endTime: new Date().toISOString() });
    } catch (erro) {
      lancou1 = true;
    }
    assert.equal(lancou1, true, "emitScanProgress deve lancar na primeira chamada terminal");
    const primeira = mgr.getScan(id);
    assert.equal(primeira.status, "completed");

    // Segunda chamada terminal a partir do mesmo estado ja-terminal: guarda terminal impede reescrita e duplo registo.
    let lancou2 = false;
    try {
      mgr.updateScan(id, { status: "failed", progress: 100, endTime: new Date().toISOString() });
    } catch (erro) {
      lancou2 = true;
    }
    assert.equal(lancou2, false, "guarda terminal bloqueia antes de emitScanProgress (nao lancou)");

    const estadoFinal = mgr.getScan(id);
    assert.equal(estadoFinal.status, "completed", "o primeiro terminal vence; nao e sobreescrito");
    assert.equal(historyCalls.length, 1, "nao ha registo duplicado no historial para o mesmo scanId");
    assert.equal(historyCalls[0].status, "completed");
  });
});
