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
  const excludedExtensions = new Set(opts.excludedExtensions ?? [".tmp"]);
  return {
    events,
    emitScanProgress: (state) => events.push({ ...state }),
    isExcluded: (filePath) => excludedExtensions.has(path.extname(filePath).toLowerCase()),
    exclusionCategory: (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".tmp") return { reason: "extension", detail: ".tmp" };
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

describe("R6-L6 — finalização: estado persistido e consistente", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l6-finalize-"));
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(tmp, `doc-${i}.txt`), "x");
    }
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmp, `cache-${i}.tmp`), "x");
    }
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("estado final persistido com endTime, phase e contadores consistentes", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);
    const ghostDir = path.join(tmp, "ghost");

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed", "estado final é completed");
    assert.ok(state.endTime, "endTime presente no terminal");
    assert.equal(state.phase, "finalizing", "fase final é finalizing");
    assert.equal(state.progress, 100, "progresso 100%");
    assert.equal(state.filesTotal, 14, "10 + 3 .tmp + 1 ghost = 14");

    const sum = state.filesAnalyzed + state.filesExcluded + state.filesFailed;
    assert.equal(sum, state.filesScanned, "identidade nos contadores do terminal");

    const considered = state.filesTotal;
    assert.equal(state.filesAnalyzed + state.filesExcluded + state.filesFailed, considered, "identidade via filesTotal");
  });

  it("estado persistido é estável — getScan devolve os mesmos valores pós-terminal", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);
    mgr.resolvePathsForScan = async () => [tmp];

    const id = await mgr.startScan("custom", undefined);
    const terminal = await waitTerminal(mgr, id);
    await sleep(100);

    const after = mgr.getScan(id);
    assert.ok(after, "estado persistido no Map");
    assert.equal(after?.status, "completed");
    assert.equal(after?.filesScanned, terminal.filesScanned, "filesScanned estável");
    assert.equal(after?.filesAnalyzed, terminal.filesAnalyzed, "filesAnalyzed estável");
    assert.equal(after?.filesExcluded, terminal.filesExcluded, "filesExcluded estável");
    assert.equal(after?.filesFailed, terminal.filesFailed, "filesFailed estável");
    assert.equal(after?.progress, terminal.progress, "progress estável");
    assert.equal(after?.endTime, terminal.endTime, "endTime estável");
  });

  it("scan cancelado persiste estado consistente (não inventa completed)", async () => {
    const engine = makeEngine();
    engine.scanArtifact = async () => {
      await sleep(10);
      return { highRiskCount: 0, overallSeverity: "safe" };
    };
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 100; i++) output.push(path.join(tmp, `doc-${i}.txt`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);

    // Esperar até que realmente este a 'running' e ter processado alguns ficheiros.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const st = mgr.getScan(id);
      if (st?.status === "running" && (st?.filesScanned ?? 0) >= 4) break;
      await sleep(5);
    }
    assert.equal(mgr.getScan(id)?.status, "running", "pré-condição: scan running antes do cancel");

    mgr.cancelScan(id);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "cancelled", "cancelado NÃO vira completed");
    assert.ok(state.endTime, "cancelado tem endTime (terminal)");
  });

  it("erros per-ficheiro contam para filesFailed mantendo status completed", async () => {
    const engine = makeEngine();
    engine.scanArtifact = async () => {
      throw new Error("motor simulado falhou");
    };
    const mgr = new ScanManager(engine);
    mgr.resolvePathsForScan = async () => [tmp];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed", "erros per-ficheiro não falham o scan");
    assert.ok(state.filesFailed > 0, "filesFailed regista os erros");
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
      "identidade mantida com erros per-ficheiro",
    );
  });

  it("erro fatal do motor (prefetchClamav lança) → status 'failed' com mensagem", async () => {
    const engine = makeEngine();
    engine.prefetchClamav = async () => {
      throw new Error("clamav indisponível");
    };
    engine.scanArtifact = async () => ({ highRiskCount: 0, overallSeverity: "safe" });
    const mgr = new ScanManager(engine);
    mgr.resolvePathsForScan = async () => [tmp];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "failed", "erro fatal → status 'failed'");
    assert.ok(state.error, "mensagem de erro presente");
    assert.ok(state.endTime, "endTime presente no failed");
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
      "identidade mantida mesmo em failed",
    );
  });
});
