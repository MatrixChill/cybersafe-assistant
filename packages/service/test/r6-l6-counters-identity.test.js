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

function makeEngine(opts = {}) {
  const events = [];
  const excludedExtensions = new Set(opts.excludedExtensions ?? [".tmp", ".log"]);
  return {
    events,
    emitScanProgress: (state) => events.push({ ...state }),
    isExcluded: (filePath) => excludedExtensions.has(path.extname(filePath).toLowerCase()),
    exclusionCategory: (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".tmp") return { reason: "extension", detail: ".tmp" };
      if (ext === ".log") return { reason: "extension", detail: ".log" };
      return null;
    },
    clearClamavPrefetch: () => {},
    markScanAborted: () => {},
    abortEngineWork: () => {},
    async scanArtifact() {
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
  };
}

describe("R6-L6 — identidade dos contadores", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l6-counters-"));

    // 5 ficheiros acessíveis .txt → analisados
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `file-${i}.txt`), "x");
    }
    // 3 ficheiros .tmp → excluídos
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmp, `cache-${i}.tmp`), "x");
    }
    // 2 ficheiros .log → excluídos
    for (let i = 0; i < 2; i++) {
      await fs.writeFile(path.join(tmp, `debug-${i}.log`), "x");
    }
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("filesScanned = filesAnalyzed + filesExcluded + filesFailed (identidade canónica)", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);
    const ghostDir = path.join(tmp, "does-not-exist");

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    assert.ok(id, "startScan deve devolver um id");

    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed", `esperava completed, obtive ${state.status}`);
    assert.equal(state.filesTotal, 11, "total = 11 (10 acessíveis + 1 inacessível)");
    assert.equal(state.filesScanned, 11, "todos os candidatos fecham o pipeline");
    assert.equal(state.filesAnalyzed, 5, "só os .txt chegam aos motores");
    assert.equal(state.filesExcluded, 5, "3 .tmp + 2 .log excluídos");
    assert.equal(state.filesFailed, 1, "ghost dir contado como falhado");
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
      "IDENTIDADE: considerados = analisados + excluídos + falhados",
    );
  });

  it("contagem separada: inacessíveis NÃO entram em filesExcludedBy", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);
    const ghostDir = path.join(tmp, "does-not-exist");

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    const excludedByTotal = (state.filesExcludedBy ?? []).reduce((sum, e) => sum + e.count, 0);
    assert.equal(
      excludedByTotal,
      state.filesExcluded,
      "soma dos motivos de exclusão == filesExcluded",
    );
    assert.equal(
      excludedByTotal,
      5,
      "exclusivamente os 5 ficheiros .tmp/.log, não o ghost dir",
    );
    assert.equal(state.filesFailed, 1, "inacessível contado à parte, não como excluído");
  });

  it("sem inacessíveis: identidade mantida (regressão)", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);
    mgr.resolvePathsForScan = async () => [tmp];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed");
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
      "identidade fechada mesmo sem inacessíveis",
    );
  });
});
