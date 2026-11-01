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
 *   2. O clamscan reportou 727 linhas de progresso para 728 ficheiros. O numero
 *      da ETAPA reconcilia para 728 (um veredicto terminal por ficheiro pedido),
 *      no tracing opt-in. Desde 2026-10-23 esse numero NAO e' `filesAnalyzed`:
 *      so contam aqui os veredictos que o loop de resultados aceitou.
 *
 * ── Os tres eixos, para nao voltar a confusao ────────────────────────────
 * `filesScanned`/`filesProcessed` — fecho do ciclo, global.
 * `filesInEngineBatch` — quantos estao AGORA dentro do batch; nao e' progresso.
 * `filesAnalyzed` — resultados aceites pelo loop. Nada da etapa entra aqui.
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

/**
 * Onde vive a reconciliacao 727 -> 728, e por que nao no estado publicado.
 *
 * A decisao de 2026-10-23 (`scan-manager.ts:1044-1048`) tirou a etapa do motor de
 * `filesAnalyzed`: um batch cancelado a meio produz veredictos que o loop deita
 * fora, e promo-los a "analisados" seria afirmar cobertura que nao existe. O
 * numero da etapa (`analisadosNoBatch`) passou a ser observavel so no tracing
 * opt-in, na linha `SCANMANAGER_BATCH_END`. Capturar essa linha e' a unica forma
 * de provar a reconciliacao sem escrever no eixo dos aceites.
 *
 * Nota de honestidade: `CYBERSAFE_DEBUG_SCAN` so liga escrita de log; o
 * `scanPerfLog` declara e o codigo confirma que nao altera comportamento.
 */
function captureBatchEnd() {
  const linhas = [];
  const original = console.log;
  process.env.CYBERSAFE_DEBUG_SCAN = "1";
  console.log = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("SCANMANAGER_BATCH_END")) linhas.push(args[0]);
    else original(...args);
  };
  return {
    linha: () => {
      assert.equal(linhas.length, 1, `esperava 1 linha de fim de batch, vieram ${linhas.length}`);
      return linhas[0];
    },
    stop() {
      console.log = original;
      delete process.env.CYBERSAFE_DEBUG_SCAN;
    },
  };
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

  it("o batch devolve 8 veredictos com 7 linhas de progresso: reconcilia para 8 no eixo da etapa", async () => {
    const names = [];
    for (let i = 0; i < 8; i++) names.push(`f${i}.txt`);
    await seed(names);

    // 7 linhas de progresso para 8 ficheiros; o batch da 8 veredictos terminais.
    // O loop falha todos, por isso NADA e' aceite — e e' exatamente isso que a
    // decisao de 2026-10-23 quer que `filesAnalyzed` diga.
    const callbacks = [1, 2, 3, 4, 5, 6, 7];
    const engine = makeEngine({ callbacks, files: 8, artifact: "throw" });
    const mgr = manager(engine);
    const perf = captureBatchEnd();
    let state;
    try {
      const id = await mgr.startScan("custom", tmp);
      state = await waitTerminal(mgr, id);
    } finally {
      perf.stop();
    }

    // EIXO DA ETAPA: a reconciliacao 7 -> 8 existe e e' medida, nao inferida.
    const linha = perf.linha();
    assert.match(linha, /\boutcomes=8\b/, `o batch reportou 8 terminais: ${linha}`);
    assert.match(linha, /\banalyzedInBatch=8\b/, `a etapa reconciliou para cima (7 -> 8): ${linha}`);
    assert.doesNotMatch(linha, /\banalyzedInBatch=7\b/);

    // EIXO GLOBAL: nenhum ficheiro desaparece, e a falha tem nome.
    assert.equal(state.filesScanned, 8, "todos os 8 fecharam o ciclo");
    assert.equal(state.filesProcessed, 8);
    assert.equal(state.filesFailed, 8, "o loop falhou todos os 8");

    // EIXO DOS ACEITES: zero, e isto NAO e' o bug que a versao anterior deste
    // teste procurava. Promover os 8 do batch para aqui diria "8 verificados"
    // quando o scanner deitou os 8 fora.
    assert.equal(
      state.filesAnalyzed,
      0,
      `nenhum veredicto foi aceite; afirmar cobertura aqui seria mentira (${state.filesAnalyzed})`,
    );
    assert.equal(
      state.filesScanned,
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      "invariante do contrato: scanned = analisados + excluidos + falhados",
    );
    assert.equal(state.filesInEngineBatch, 0, "sem batch a correr o contador de etapa e' zero");
  });

  it("durante o batch publica-se quantos estao no motor (5), e os aceites ficam a zero ate' o loop comer", async () => {
    const names = [];
    for (let i = 0; i < 5; i++) names.push(`g${i}.txt`);
    await seed(names);

    let release;
    const hold = { promise: new Promise((r) => { release = r; }) };
    const callbacks = [1, 2, 3, 4]; // 4 linhas para 5 ficheiros
    const engine = makeEngine({ callbacks, files: 5, artifact: "hold", hold });
    const mgr = manager(engine);
    const id = await mgr.startScan("custom", tmp);

    try {
      // (1)_batch em curso: o numero publicado e' o dos candidatos dentro do
      // clamscan — nao a ultima linha (4). E' o que a UI mostra como "em curso".
      let emCurso = null;
      for (let i = 0; i < 150 && !emCurso; i++) {
        const s = mgr.getScan(id);
        if (s && s.filesInEngineBatch === 5) emCurso = s;
        else await sleep(20);
      }
      assert.ok(emCurso, "o batch publicou os 5 candidatos em curso");
      assert.ok(
        (emCurso.filesAnalyzed ?? 0) === 0,
        `com o loop preso nada foi aceite, mas ` +
          `filesAnalyzed=${emCurso.filesAnalyzed} — a etapa nao pode promover-se a cobertura`,
      );

      // (2) batch resolvido, loop ainda preso: o contador de etapa tem de voltar
      // a zero. Ficar a dizer "5 no batch" quando nada la esta e' pior do que 0.
      let resolvido = null;
      for (let i = 0; i < 150 && !resolvido; i++) {
        const s = mgr.getScan(id);
        if (s && s.filesInEngineBatch === 0) resolvido = s;
        else await sleep(20);
      }
      assert.ok(resolvido, "o fim do batch zera o contador de etapa (finally em scan-manager.ts:1078)");
      assert.equal(resolvido.filesAnalyzed ?? 0, 0, "5 veredictos do batch, 0 aceites: os 5 ainda nao passaram pelo loop");
    } finally {
      release();
    }

    // (3) com o loop libertado, os mesmos 5 sao efectivamente aceites — uma vez.
    const final = await waitTerminal(mgr, id);
    assert.equal(final.filesScanned, 5);
    assert.equal(final.filesAnalyzed, 5, "aceites so quando o loop os comeu");
    assert.ok(final.filesAnalyzed <= 5, "sem double count: batch + loop nao somam 10");
  });

  it("um motor que nao reporta o count NAO inventa numeros (contrato antigo intacto)", async () => {
    const names = [];
    for (let i = 0; i < 8; i++) names.push(`h${i}.txt`);
    await seed(names);

    // Sem `files`: so vale o que o onProgress provou. O loop falha todos.
    const callbacks = [1, 2, 3, 4, 5, 6];
    const engine = makeEngine({ callbacks, files: undefined, artifact: "throw" });
    const mgr = manager(engine);
    const perf = captureBatchEnd();
    let state;
    try {
      const id = await mgr.startScan("custom", tmp);
      state = await waitTerminal(mgr, id);
    } finally {
      perf.stop();
    }

    const linha = perf.linha();
    assert.match(linha, /\boutcomes=n\/a\b/, `o motor nao reportou count: ${linha}`);
    assert.match(
      linha,
      /\banalyzedInBatch=6\b/,
      `sem count do batch a etapa fica no que o onProgress provou (6), nao sobe aos 8 candidatos: ${linha}`,
    );

    assert.equal(state.filesScanned, 8);
    assert.equal(state.filesFailed, 8);
    assert.equal(state.filesAnalyzed, 0, "nada foi aceite, e o numero provado da etapa nao vira cobertura");
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