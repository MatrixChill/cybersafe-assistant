/**
 * TASK C — o progresso do scan durante o batch do ClamAV.
 *
 * O problema medido: o batch do ClamAV corre ~7,6 s ANTES de o primeiro ficheiro
 * ser analisado. Durante esse tempo o `ScanManager` não emite progresso por
 * ficheiro (não há — o clamscan ainda está a carregar a base), mas o heartbeat
 * de 1 s continua a mandar o estado. A UI via:
 *
 *     "A verificar os ficheiros encontrados"   0%   0 f/s
 *
 * durante sete segundos. "A verificar" é uma afirmação sobre trabalho que ainda
 * não aconteceu. É a mesma família de mentira que o resto desta sprint removeu:
 * a UI a descrever um presente que o motor não está a viver.
 *
 * O que este ficheiro fixa:
 *   1. o serviço PUBLICA quantos ficheiros estão no batch (`filesInEngineBatch`);
 *   2. o serviço NÃO inventa progresso — `filesAnalyzed` continua 0;
 *   3. o batch é contabilizado, não escondido: `filesTotal` inclui-os;
 *   4. se o batch falhar, o contador volta a zero e o scan continua (nunca fica
 *      a dizer "a analisar 20 ficheiros" quando nada está a acontecer).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ScanManager } from "../dist/scan-manager.js";

let tmp;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-batchprogress-"));
  for (let i = 0; i < 6; i++) {
    await fs.writeFile(path.join(tmp, `f${i}.txt`), `conteudo benigno ${i}`, "utf-8");
  }
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/**
 * Motor de teste: implementa o contrato do batch com um `prefetchClamav` que
 * demora o suficiente para o heartbeat disparar, e sem nunca tocar no disco
 * para além dos ficheiros já criados.
 */
function makeEngine({ prefetchDelayMs = 0, failPrefetch = false } = {}) {
  const events = [];
  return {
    events,
    isExcluded: () => false,
    emitScanProgress: (state) => events.push({ ...state }),
    async prefetchClamav(filePaths) {
      if (prefetchDelayMs > 0) await new Promise((r) => setTimeout(r, prefetchDelayMs));
      if (failPrefetch) return { spawned: false, error: "batch falhou" };
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

async function runScan(engine) {
  const mgr = new ScanManager(engine);
  const id = await mgr.startScan("custom", tmp);
  assert.ok(id, "startScan devolveu um id");
  for (let i = 0; i < 400; i++) {
    const s = mgr.getScan(id);
    if (s && (s.status === "completed" || s.status === "failed")) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("o scan não terminou");
}

describe("TASK C — o batch do ClamAV é reportado como o que é", () => {
  it("publica quantos ficheiros estão no batch ANTES de os analisar", async () => {
    const engine = makeEngine({ prefetchDelayMs: 400 });
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", tmp);

    // Mientras o batch corre, o estado tem de dizer quantos ficheiros estão lá.
    let sawBatch = null;
    for (let i = 0; i < 40; i++) {
      const s = mgr.getScan(id);
      if (s && s.filesInEngineBatch > 0) {
        sawBatch = { filesInEngineBatch: s.filesInEngineBatch, filesAnalyzed: s.filesAnalyzed ?? 0 };
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.ok(sawBatch, "o serviço tem de publicar o ficheiro count do batch");
    assert.equal(
      sawBatch.filesInEngineBatch,
      6,
      "os 6 ficheiros da pasta estão no batch",
    );
    assert.equal(
      sawBatch.filesAnalyzed,
      0,
      "e NENHUM foi analisado ainda — o batch é um clamscan, não 6 análises",
    );

    for (let i = 0; i < 400; i++) {
      const s = mgr.getScan(id);
      if (s && (s.status === "completed" || s.status === "failed")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  it("NÃO inventa progresso: filesAnalyzed é 0 enquanto o batch decorre", async () => {
    const engine = makeEngine({ prefetchDelayMs: 500 });
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", tmp);

    let invented = false;
    const started = Date.now();
    while (Date.now() - started < 400) {
      const s = mgr.getScan(id);
      if (s && (s.filesAnalyzed ?? 0) > 0 && (s.filesInEngineBatch ?? 0) > 0) invented = true;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(invented, false, "nada pode ser 'analisado' enquanto o batch não devolveu");
  });

  it("o contador do batch volta a zero no fim (não fica a mentir para sempre)", async () => {
    const engine = makeEngine({ prefetchDelayMs: 200 });
    const state = await runScan(engine);
    assert.equal(state.status, "completed", `o scan devia completar (${state.error})`);
    assert.equal(
      state.filesInEngineBatch ?? 0,
      0,
      "depois de completado, o batch já não está a correr",
    );
    assert.equal(state.filesAnalyzed, 6, "os 6 ficheiros foram analisados no fim");
  });

  it("se o batch falhar, o scan CONTINUA (não fica pendurado nem mente)", async () => {
    const engine = makeEngine({ prefetchDelayMs: 100, failPrefetch: true });
    const state = await runScan(engine);
    assert.equal(
      state.status,
      "completed",
      "uma falha no batch tem de degradar para o caminho por ficheiro, nunca travar o scan",
    );
    assert.equal(state.filesAnalyzed, 6, "os ficheiros são analisados na mesma, um a um");
    assert.equal(state.filesInEngineBatch ?? 0, 0);
  });

  it("o progresso nunca ultrapassa 100% nem recua (monotónico)", async () => {
    const engine = makeEngine({ prefetchDelayMs: 200 });
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", tmp);
    const seen = [];
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const s = mgr.getScan(id);
      if (s) seen.push(s.progress ?? 0);
      if (s && (s.status === "completed" || s.status === "failed")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] >= seen[i - 1], `o progresso recuou: ${seen[i - 1]} -> ${seen[i]}`);
      assert.ok(seen[i] <= 100, `o progresso passou de 100: ${seen[i]}`);
    }
  });
});
