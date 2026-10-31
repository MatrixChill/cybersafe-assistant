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

function makeExcludingEngine() {
  const events = [];
  const excludedExtensions = new Set([".tmp", ".log", ".cache"]);
  return {
    events,
    isExcluded: (filePath) => excludedExtensions.has(path.extname(filePath).toLowerCase()),
    exclusionCategory: (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".tmp") return { reason: "extension", detail: ".tmp" };
      if (ext === ".log") return { reason: "extension", detail: ".log" };
      if (ext === ".cache") return { reason: "extension", detail: ".cache" };
      return null;
    },
    emitScanProgress: (state) => events.push({ ...state }),
    async scanArtifact() {
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    clearClamavPrefetch: () => {},
    markScanAborted: () => {},
    abortEngineWork: () => {},
  };
}

describe("R6-L6 — exclusões com motivo visível e inacessíveis contados à parte", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l6-excluded-"));
    // Files that will be analyzed (come to engine)
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `doc-${i}.txt`), "content");
    }
    // Files excluded by extension
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmp, `cache-${i}.tmp`), "temp");
    }
    for (let i = 0; i < 2; i++) {
      await fs.writeFile(path.join(tmp, `debug-${i}.log`), "log");
    }
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(path.join(tmp, `build-${i}.cache`), "cache");
    }
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("filesExcludedBy traz o motivo de cada categoria, com contagens correctas", async () => {
    const engine = makeExcludingEngine();
    const mgr = new ScanManager(engine);
    const ghostDir = path.join(tmp, "ghost");

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed");
    assert.equal(state.filesExcluded, 9, "3 .tmp + 2 .log + 4 .cache = 9 excluídos");

    const excludedBy = state.filesExcludedBy ?? [];
    const totalByReason = excludedBy.reduce((sum, e) => sum + e.count, 0);
    assert.equal(
      totalByReason,
      state.filesExcluded,
      "a soma de filesExcludedBy == filesExcluded",
    );

    const tmpEntry = excludedBy.find((e) => e.reason === "extension" && e.detail === ".tmp");
    const logEntry = excludedBy.find((e) => e.reason === "extension" && e.detail === ".log");
    const cacheEntry = excludedBy.find((e) => e.reason === "extension" && e.detail === ".cache");

    assert.ok(tmpEntry, "motivo .tmp presente");
    assert.equal(tmpEntry.count, 3, "3 ficheiros .tmp excluídos");
    assert.ok(logEntry, "motivo .log presente");
    assert.equal(logEntry.count, 2, "2 ficheiros .log excluídos");
    assert.ok(cacheEntry, "motivo .cache presente");
    assert.equal(cacheEntry.count, 4, "4 ficheiros .cache excluídos");
  });

  it("inacessíveis contam para filesFailed, NÃO para filesExcluded", async () => {
    const engine = makeExcludingEngine();
    const mgr = new ScanManager(engine);
    const ghostDir = path.join(tmp, "ghost");

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.filesFailed, 1, "ghost dir = 1 falhado");
    assert.equal(state.filesExcluded, 9, "excluídos mantidos separados");

    const failedByReason = state.failedByReason ?? {};
    const failedReasonKeys = Object.keys(failedByReason);
    assert.ok(failedReasonKeys.length > 0, "failedByReason tem de estar povoado");
    const totalByReason = failedReasonKeys.reduce((sum, k) => sum + failedByReason[k], 0);
    assert.equal(totalByReason, state.filesFailed, "soma dos motivos de falha == filesFailed");
    assert.equal(failedByReason.not_found, 1, "ghost dir classificado como not_found");
  });

  it("nenhum motivo de exclusão inventado para inacessíveis", async () => {
    const engine = makeExcludingEngine();
    const mgr = new ScanManager(engine);
    const ghostDir = path.join(tmp, "ghost");

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    const excludedBy = state.filesExcludedBy ?? [];
    assert.equal(
      excludedBy.length,
      3,
      "exatamente 3 categorias de exclusão (.tmp, .log, .cache) — nem uma a mais",
    );
  });
});
