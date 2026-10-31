import { describe, it, before, after } from "node:test";
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
    await sleep(5);
  }
  throw new Error(`scan ${id} não atingiu estado terminal em ${timeoutMs} ms`);
}

/** Motor que analisa tudo com sucesso e regista os eventos publicados. */
function makeOkEngine(events) {
  return {
    events,
    isExcluded: () => false,
    exclusionCategory: () => null,
    emitScanProgress: (state) => events.push({ ...state }),
    async scanArtifact() {
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    clearClamavPrefetch: () => {},
    markScanAborted: () => {},
    abortEngineWork: () => {},
  };
}

/**
 * PERSISTÊNCIA do resultado após o scan fechar.
 *
 * O serviço é um processo de vida longa; o renderer reabre (remount,
 * navegação, restart da app). O contrato: o resultado CONCLUÍDO fica
 * consultável e IMUTÁVEL por id, nada publica sobre ele depois do
 * terminal, e o lock de scan único liberta para uma nova análise.
 */
describe("R6-L11 — persistência do resultado após o scan fechar", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l11-per-"));
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(path.join(tmp, `doc-${i}.txt`), "conteudo");
    }
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("getScan(id) retém o resultado concluído intacto depois do terminal", async () => {
    const events = [];
    const mgr = new ScanManager(makeOkEngine(events));

    const id = await mgr.startScan("custom", tmp);
    const final = await waitTerminal(mgr, id);
    assert.equal(final.status, "completed");

    // O snapshot concluído é retido — um reader que reabre e pede o
    // mesmo id vê os mesmos números, sem mutação.
    const snapshot = { ...final };
    const retained = mgr.getScan(id);
    assert.equal(retained.status, "completed");
    assert.equal(retained.progress, 100);
    assert.equal(retained.filesScanned, 4);
    assert.equal(retained.filesAnalyzed, 4);
    assert.ok(retained.endTime, "resultado concluído tem endTime");
    assert.deepEqual({ ...retained }, snapshot, "nenhuma mutação após o terminal");
  });

  it("nenhum evento é publicado sobre um scan já terminal (heartbeat cala)", async () => {
    const events = [];
    const mgr = new ScanManager(makeOkEngine(events));

    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    const atTerminal = events.filter((e) => e.id === id).length;
    assert.ok(atTerminal > 0, "houve eventos durante o scan");

    // Dar tempo ao heartbeat (1 s) e ao ciclo de publicação: nada
    // pode tocar num scan concluído.
    await sleep(2_500);
    const after = events.filter((e) => e.id === id).length;
    assert.equal(after, atTerminal, `eventos congelados no terminal (antes=${atTerminal}, depois=${after})`);
  });

  it("cancel tardio sobre um scan concluído não muda o estado", async () => {
    const events = [];
    const mgr = new ScanManager(makeOkEngine(events));

    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    mgr.cancelScan(id);
    const state = mgr.getScan(id);
    assert.equal(state.status, "completed", "terminal é terminal: cancel não reabre nem reescreve");
    assert.equal(state.progress, 100);
  });

  it("getActiveScan() devolve null quando nada corre — reabrir não finge scan", async () => {
    const events = [];
    const mgr = new ScanManager(makeOkEngine(events));

    assert.equal(mgr.getActiveScan(), null, "sem scans: nada ativo");

    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    assert.equal(mgr.getActiveScan(), null, "concluído não é 'ativo' — a UI abre em idle, não em recuperação");
    assert.ok(mgr.getScan(id), "mas o resultado continua consultável por id");
  });

  it("lock de scan único liberta após concluir — nova análise aceita e o registo antigo fica intacto", async () => {
    const events = [];
    const mgr = new ScanManager(makeOkEngine(events));

    const id1 = await mgr.startScan("custom", tmp);
    const final1 = await waitTerminal(mgr, id1);
    const snapshot1 = { ...final1 };

    // O scan fechou: o lock liberta e um novo scan é aceite (não null).
    const id2 = await mgr.startScan("custom", tmp);
    assert.ok(id2, "após concluir, startScan aceita uma nova análise");
    assert.notEqual(id2, id1);

    const final2 = await waitTerminal(mgr, id2);
    assert.equal(final2.status, "completed");
    assert.equal(final2.filesScanned, 4);

    // O registo do primeiro scan sobrevive ao segundo, intacto.
    assert.deepEqual({ ...mgr.getScan(id1) }, snapshot1, "resultado do scan 1 persiste inalterado");
  });
});
