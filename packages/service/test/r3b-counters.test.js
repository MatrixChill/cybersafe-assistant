import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ScanManager } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTerminal(mgr, id, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(10);
  }
  throw new Error(`scan ${id} não atingiu estado terminal em ${timeoutMs} ms`);
}

/**
 * R3-B — Contadores fecham incluindo directórios inacessíveis no gathering.
 *
 * P0 SCANNER_RUNTIME_ZERO_PROGRESS — o contrato canónico:
 *   considerados (filesScanned) = analisados + excluídos + falhados
 *
 * Antes do fix: gatherFiles/gatherFilesQuick faziam `.catch(() => null)` e
 * `.catch(() => [])` nos stat/readdir de directórios inacessíveis, silenciosamente
 * descartando entradas. Estes ficheiros/directórios desapareciam de TODOS os
 * contadores — nem sequer entravam em filesScanned — e a identidade não fechava.
 *
 * O fix: gatherFilesQuick e gatherFiles recebem um objecto `stats` mutável
 * (`{ failed: number }`) e incrementam `stats.failed` cada vez que stat ou
 * readdir falham. runScanLoop inicializa `scanned` e `filesFailed` com esse
 * valor antes do loop principal, e inclui-o em `totalFiles`.
 *
 * Este fixture:
 * - 1 ficheiro acessível .txt  → analisado
 * - 1 ficheiro acessível .tmp  → excluído
 * - 1 directório inacessível  → falhado (ENOENT, caminho ghost)
 *
 * Identidade esperada: 1 + 1 + 1 = 3 = filesScanned
 */

function makeEngine() {
  const events = [];
  const excluiTmp = new Set();
  return {
    events,
    emitScanProgress: (state) => events.push({ ...state }),
    isExcluded: (filePath) => {
      const excluded = path.extname(filePath).toLowerCase() === ".tmp";
      if (excluded) excluiTmp.add(filePath);
      return excluded;
    },
    exclusionCategory: (filePath) =>
      path.extname(filePath).toLowerCase() === ".tmp"
        ? { reason: "extension", detail: ".tmp" }
        : null,
    async scanArtifact() {
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    clearClamavPrefetch: () => {},
    markScanAborted: () => {},
    abortEngineWork: () => {},
  };
}

describe("R3-B — contadores fecham com directórios inacessíveis no gathering", () => {
  let tmp;
  let ghostDir;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r3b-counters-"));

    await fs.writeFile(path.join(tmp, "accessible.txt"), "x");
    await fs.writeFile(path.join(tmp, "cache.tmp"), "x");

    ghostDir = path.join(tmp, "does-not-exist");
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("identidade: filesScanned = analyzed + excluded + failed (com inaccessible no gathering)", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    assert.ok(id, "startScan deve devolver um id");

    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed", `esperava completed, obtive ${state.status}`);
    assert.equal(state.filesTotal, 3, "total inclui inacessível do gathering");
    assert.equal(state.filesScanned, 3, "todos os candidatos fecham o pipeline");
    assert.equal(state.filesAnalyzed, 1, "só accessible.txt chega aos motores");
    assert.equal(state.filesExcluded, 1, "cache.tmp excluído");
    assert.equal(state.filesFailed, 1, "directório inacessível contado como falhado");
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
      "considerados = analisados + excluídos + falhados",
    );
  });

  it("identidade: todos inacessíveis (filesList vazio) não cai no zero-files completed", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);

    mgr.resolvePathsForScan = async () => [ghostDir];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed", `esperava completed, obtive ${state.status}`);
    assert.equal(state.filesTotal, 1, "total = 1 (só o inaccessible)");
    assert.equal(state.filesScanned, 1);
    assert.equal(state.filesAnalyzed, 0);
    assert.equal(state.filesExcluded, 0);
    assert.equal(state.filesFailed, 1, "inacessível é falhado, não desaparece");
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
      "identidade mantida mesmo com só inacessíveis",
    );
  });

  it("identidade: sem inacessíveis (regressão) — comportamento anterior mantido", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);

    const onlyAccessible = path.join(tmp, "accessible.txt");
    mgr.resolvePathsForScan = async () => [onlyAccessible];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed");
    assert.equal(state.filesScanned, 1);
    assert.equal(state.filesAnalyzed, 1);
    assert.equal(state.filesExcluded, 0);
    assert.equal(state.filesFailed, 0);
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
      "identidade fechada quando não há inacessíveis",
    );
  });
});
