import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ScanManager } from "../dist/scan-manager.js";

/**
 * P0 SCANNER_REAL_BATCH_STALL — o progresso REAL do batch chega ao consumidor.
 *
 * `clamav-batch-progress-honest.test.js` fixa o contrato antigo e continua
 * verdadeiro: um prefetch que não diz nada deixa `filesAnalyzed` a 0. Este
 * ficheiro fixa o contrato NOVO, o outro lado da mesma honestidade: quando o
 * clamscan DIZ quantos ficheiros já varreu, o ScanManager tem de publicar esse
 * número.
 *
 * A cadeia que estes testes atravessam, ponta a ponta:
 *
 *   clamscan (linhas `OK`/`FOUND`)
 *     -> ClamavBridge.onProgress          (packages/core/test/clamav-batch-progress.test.js)
 *       -> prefetchClamav(..., onProgress) (packages/service/src/engine.ts)
 *         -> ScanManager.updateScan       (packages/service/src/scan-manager.ts)
 *           -> emitScanProgress(state)    (e o que a UI consome)
 *
 * Sem o último salto, a correcção do core não mudava nada no ecrã.
 *
 * ── A armadilha que estes testes têm de evitar ────────────────────────────
 * A primeira versão aceitava só `filesAnalyzed > 0` e PASSAVA mesmo com a
 * ligação ao `onProgress` cortada (medido: RC=0 sem a ligação). Motivo: o loop
 * por ficheiro também incrementa `filesAnalyzed`, e como o motor de teste é
 * rápido, o número subia pouco depois do batch. Falso positivo.
 *
 * Por isso TODA a asserção de progresso aqui exige `filesInEngineBatch > 0` EM
 * SIMULTÂNEO. Com o batch a correr, a única fonte possível de um
 * `filesAnalyzed > 0` é o que o clamscan reportou — não o loop. É o que
 * diferencia "o motor contou" de "o loop contou".
 *
 * Nenhum clamscan real: o `prefetchClamav` é injectado.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-batchpipe-"));
  for (let i = 0; i < 6; i++) {
    await fs.writeFile(path.join(tmp, `f${i}.txt`), `conteudo benigno ${i}`, "utf-8");
  }
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/**
 * Motor de teste. `progresso` é o que o prefetch reporta: `null` = não reporta
 * nada (o contrato antigo), uma lista de números = o que o clamscan disse.
 */
function makeEngine({ progresso = null, fatiaMs = 60 } = {}) {
  const events = [];
  return {
    events,
    prefetchClamavCalls: 0,
    isExcluded: () => false,
    emitScanProgress: (state) => events.push({ ...state }),
    async prefetchClamav(filePaths, scanId, onProgress) {
      this.prefetchClamavCalls++;
      if (!progresso || typeof onProgress !== "function") {
        await sleep(fatiaMs);
        return { spawned: true };
      }
      // O clamscan escreve as linhas ao ritmo a que varre os ficheiros.
      for (const n of progresso) {
        await sleep(fatiaMs / 4);
        onProgress(n);
      }
      return { spawned: true };
    },
    clearClamavPrefetch: () => {},
    async scanArtifact(filePath) {
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

async function waitTerminal(mgr, id) {
  for (let i = 0; i < 400; i++) {
    const s = mgr.getScan(id);
    if (s && (s.status === "completed" || s.status === "failed")) return s;
    await sleep(25);
  }
  throw new Error("o scan não terminou");
}

/** Só conta um evento como "progresso do batch" se o batch estiver a correr. */
const duranteOBatch = (e) => (e.filesInEngineBatch ?? 0) > 0 && (e.filesAnalyzed ?? 0) > 0;

describe("P0 SCANNER_REAL_BATCH_STALL — o progresso do batch chega ao consumidor", () => {
  it("publica filesAnalyzed > 0 ENQUANTO o batch decorre", async () => {
    const engine = makeEngine({ progresso: [1, 2, 3, 4, 5, 6], fatiaMs: 160 });
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", tmp);

    let viuProgresso = null;
    for (let i = 0; i < 80; i++) {
      const s = mgr.getScan(id);
      if (s && duranteOBatch({ filesInEngineBatch: s.filesInEngineBatch, filesAnalyzed: s.filesAnalyzed })) {
        viuProgresso = { filesAnalyzed: s.filesAnalyzed, progress: s.progress, status: s.status };
        break;
      }
      await sleep(20);
    }

    assert.ok(
      viuProgresso,
      "o batch reportou ficheiros analisados mas o ScanManager não publicou nada durante o batch — a UI ficaria 0/N",
    );
    assert.ok(viuProgresso.filesAnalyzed > 0, `filesAnalyzed = ${viuProgresso.filesAnalyzed}`);
    assert.equal(
      viuProgresso.status,
      "running",
      "o progresso só conta se o scan ainda está a correr (e não depois de terminar)",
    );

    await waitTerminal(mgr, id);
  });

  it("os eventos de progresso do batch levam o id do scan certo", async () => {
    const engine = makeEngine({ progresso: [1, 3, 6], fatiaMs: 160 });
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    const comProgresso = engine.events.filter(duranteOBatch);
    assert.ok(comProgresso.length > 0, "não houve nenhum evento de progresso durante o batch");
    for (const e of comProgresso) {
      assert.equal(e.id, id, `evento com id errado: ${e.id} != ${id}`);
    }
  });

  it("o contador do batch NUNCA recua e NUNCA passa do total", async () => {
    const engine = makeEngine({ progresso: [1, 2, 3, 4, 5, 6], fatiaMs: 140 });
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    const doBatch = engine.events.filter((e) => (e.filesInEngineBatch ?? 0) > 0);
    assert.ok(doBatch.length > 0, "o batch não emitiu nada");
    let anterior = 0;
    for (const e of doBatch) {
      const a = e.filesAnalyzed ?? 0;
      assert.ok(a >= anterior, `filesAnalyzed recuou: ${anterior} -> ${a}`);
      anterior = a;
      const p = e.progress ?? 0;
      assert.ok(p >= 0 && p <= 100, `progresso fora de [0,100]: ${p}`);
    }
    assert.ok(anterior > 0, "o batch nunca reportou ficheiros analisados");
  });

  it("um scan NÃO recebe o progresso de outro", async () => {
    const engine = makeEngine({ progresso: [1, 2, 3, 4, 5, 6], fatiaMs: 140 });
    const mgr = new ScanManager(engine);
    const idA = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, idA);
    const totalA = engine.events.length;

    const idB = await mgr.startScan("custom", tmp);
    assert.notEqual(idA, idB, "dois scans precisam de ids diferentes");
    await waitTerminal(mgr, idB);

    const deB = engine.events.slice(totalA);
    assert.ok(deB.length > 0, "o segundo scan não emitiu nada");
    for (const e of deB) {
      assert.equal(e.id, idB, `o scan B recebeu um evento do scan A (${e.id})`);
    }
  });

  it("um prefetch que NÃO reporta nada continua a dar 0 (não se inventa)", async () => {
    const engine = makeEngine({ progresso: null, fatiaMs: 160 });
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    assert.ok(
      !engine.events.some(duranteOBatch),
      "o prefetch não reportou nada e mesmo assim apareceu 'analisado' durante o batch",
    );
  });

  it("o prefetch recebe mesmo o callback de progresso", async () => {
    const engine = makeEngine({ progresso: [6], fatiaMs: 80 });
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", tmp);
    await waitTerminal(mgr, id);

    assert.equal(engine.prefetchClamavCalls, 1, "o prefetch tem de ser chamado uma vez");
  });
});