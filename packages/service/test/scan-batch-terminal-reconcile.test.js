import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ScanManager } from "../dist/scan-manager.js";

/**
 * P0 SCANNER_728_OF_800 — decomposicao e reconciliacao do batch.
 *
 * Duas verdades que o humano mediu e que ninguem conseguia explicar:
 *
 *   1. SELECTED=800 mas PREFETCH=728. A diferenca tem de ter NOME, nao ser
 *      "provavelmente": remainder = excluded + zip, e os tres somam 800.
 *   2. O clamscan reportou 727 linhas de progresso para 728 ficheiros. O
 *      contador NAO pode ficar preso em 727 se o batch deu 728 veredictos
 *      terminais — um por ficheiro pedido.
 *
 * Estes testes atravessam so o ScanManager (o `prefetchClamav` e' injectado).
 * O core (contagem de linhas `OK`/`FOUND`) ja tem o seu proprio teste.
 *
 * ── A armadilha ───────────────────────────────────────────────────────────
 * "Reconciliar" nao pode significar "inventar". Um motor antigo que devolve
 * `{ spawned: true }` sem `files` continua a mostrar apenas o que o onProgress
 * provou (nunca mais). E o contador nunca pode passar dos candidatos: o batch
 * e' um prefetch, somar contaria os mesmos ficheiros duas vezes.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-reconcile-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function seed(names) {
  const files = [];
  for (const name of names) {
    const p = path.join(tmp, name);
    await fs.writeFile(p, "x", "utf-8");
    files.push(p);
  }
  return files;
}

/**
 * Motor de teste.
 * - `callbacks`: o que o clamscan "escreveu" linha a linha (numeros de onProgress).
 * - `files`: o numero de veredictos terminais que o batch devolve (ou undefined
 *   para simular um motor que nao reporta — o contrato antigo).
 * - `artifact`: "ok" (analisa), "throw" (o loop falha todos), "hold" (fica preso
 *   para observarmos o estado do batch).
 */
function makeEngine({ callbacks = [], files, artifact = "ok", hold } = {}) {
  const events = [];
  const prefetchCalls = [];
  return {
    events,
    prefetchCalls,
    isExcluded: (filePath) => path.extname(filePath).toLowerCase() === ".tmp",
    emitScanProgress: (state) => events.push({ ...state }),
    async prefetchClamav(filePaths, scanId, onProgress) {
      this.prefetchCalls.push({ count: filePaths.length, scanId });
      for (const n of callbacks) {
        await sleep(2);
        if (typeof onProgress === "function") onProgress(n);
      }
      const result = { spawned: true };
      if (typeof files === "number") result.files = files;
      return result;
    },
    clearClamavPrefetch: () => {},
    async scanArtifact(filePath) {
      if (artifact === "hold" && hold) await hold.promise;
      if (artifact === "throw") throw new Error("engine down");
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

function manager(engine) {
  const mgr = new ScanManager(engine);
  mgr.looksLikeZip = async () => false;
  return mgr;
}

async function waitTerminal(mgr, id) {
  for (let i = 0; i < 400; i++) {
    const s = mgr.getScan(id);
    if (s && (s.status === "completed" || s.status === "failed" || s.status === "cancelled")) return s;
    await sleep(25);
  }
  throw new Error("o scan nao terminou");
}

describe("P0 SCANNER_728_OF_800 — o remainder tem nome e o contador reconcilia", () => {
  it("800 selecionados = 728 candidatos + 72 excluidos, sem ficheiros a desaparecer", async () => {
    const names = [];
    for (let i = 0; i < 728; i++) names.push(`doc-${i}.txt`);
    for (let i = 0; i < 72; i++) names.push(`cache-${i}.tmp`);
    const files = await seed(names);
    assert.equal(files.length, 800);

    // O clamscan perde a ultima linha: 727 linhas para 728 ficheiros.
    const callbacks = [];
    for (let n = 1; n <= 727; n++) callbacks.push(n);
    const engine = makeEngine({ callbacks, files: 728, artifact: "ok" });
    const mgr = manager(engine);
    const id = await mgr.startScan("custom", tmp);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.filesTotal, 800, "denominador = todos os selecionados");
    assert.equal(engine.prefetchCalls.length, 1);
    assert.equal(engine.prefetchCalls[0].count, 728, "o batch so recebe os 728 candidatos");

    assert.equal(state.filesExcluded, 72, "os 72 sao excluidos, nao desaparecem");
    assert.equal(state.filesScanned, 800, "todos os 800 chegam a outcome terminal");
    assert.equal(state.filesProcessed, 800);
    assert.equal(
      state.filesProcessed,
      state.filesScanned,
      "o contador principal de terminal e' unico e chega a 800",
    );
    assert.equal(state.filesFailed, 0);
    assert.equal(state.status, "completed");
    assert.equal(state.progress, 100);
  });

  it("o contador nao fica preso em 727 quando o batch devolveu 728 veredictos", async () => {
    const names = [];
    for (let i = 0; i < 8; i++) names.push(`f${i}.txt`);
    await seed(names);

    // 7 linhas de progresso para 8 ficheiros; o batch diz que analisou 8.
    // O loop falha todos: sem reconciliacao o final recuava para 0.
    const callbacks = [1, 2, 3, 4, 5, 6, 7];
    const engine = makeEngine({ callbacks, files: 8, artifact: "throw" });
    const mgr = manager(engine);
    const id = await mgr.startScan("custom", tmp);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.filesScanned, 8);
    assert.equal(state.filesFailed, 8, "o loop falhou todos os 8");
    assert.equal(
      state.filesAnalyzed,
      8,
      `o batch provou 8 terminais; o contador nao pode recuar para ${state.filesAnalyzed}`,
    );
    assert.ok(state.filesAnalyzed <= 8, "nunca conta mais do que os candidatos (sem double count)");
  });

  it("durante o batch publica o numero terminal de outcomes, nao a ultima linha (727 -> 728)", async () => {
    const names = [];
    for (let i = 0; i < 5; i++) names.push(`g${i}.txt`);
    await seed(names);

    let release;
    const hold = { promise: new Promise((r) => { release = r; }) };
    const callbacks = [1, 2, 3, 4]; // 4 linhas para 5 ficheiros
    const engine = makeEngine({ callbacks, files: 5, artifact: "hold", hold });
    const mgr = manager(engine);
    const id = await mgr.startScan("custom", tmp);

    // Espera que o batch resolva e a reconciliacao publique, com o loop preso.
    let visto = null;
    try {
      for (let i = 0; i < 100; i++) {
        const s = mgr.getScan(id);
        if (s && (s.filesInEngineBatch ?? 0) === 0 && (s.filesAnalyzed ?? 0) >= 5) {
          visto = s;
          break;
        }
        await sleep(20);
      }
      assert.ok(visto, "o batch reconciliou para 5 outcomes terminais (nao ficou em 4)");
      assert.equal(visto.filesAnalyzed, 5);
      assert.ok(visto.filesAnalyzed <= 5, "sem double count");
    } finally {
      release();
      await waitTerminal(mgr, id);
    }
  });

  it("um motor que nao reporta o count NAO inventa numeros (contrato antigo intacto)", async () => {
    const names = [];
    for (let i = 0; i < 8; i++) names.push(`h${i}.txt`);
    await seed(names);

    // Sem `files`: so vale o que o onProgress provou. O loop falha todos.
    const callbacks = [1, 2, 3, 4, 5, 6];
    const engine = makeEngine({ callbacks, files: undefined, artifact: "throw" });
    const mgr = manager(engine);
    const id = await mgr.startScan("custom", tmp);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.filesScanned, 8);
    assert.equal(
      state.filesAnalyzed,
      6,
      `sem count do batch o contador fica no que foi provado (6), mas veio ${state.filesAnalyzed}`,
    );
  });

  it("o loop que re-analisa os mesmos ficheiros nao conta a dobrar", async () => {
    const names = [];
    for (let i = 0; i < 8; i++) names.push(`k${i}.txt`);
    await seed(names);

    // Batch devolve 8; o loop analisa os mesmos 8 com sucesso.
    // O total tem de ser 8, nunca 16.
    const callbacks = [1, 2, 3, 4, 5, 6, 7];
    const engine = makeEngine({ callbacks, files: 8, artifact: "ok" });
    const mgr = manager(engine);
    const id = await mgr.startScan("custom", tmp);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.filesScanned, 8);
    assert.equal(state.filesAnalyzed, 8, `esperado 8 (sem soma batch+loop), veio ${state.filesAnalyzed}`);
  });
});