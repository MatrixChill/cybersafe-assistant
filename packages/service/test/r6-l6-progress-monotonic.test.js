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

describe("R6-L6 — progresso monótono e terminal honesto", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l6-progress-"));
    for (let i = 0; i < 100; i++) {
      await fs.writeFile(path.join(tmp, `file-${i}.txt`), "x");
    }
    await fs.writeFile(path.join(tmp, "cache.tmp"), "x");
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("progress nunca recua durante todo o scan — eventos publicados pela engine", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);
    const ghostDir = path.join(tmp, "ghost");

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed");
    assert.equal(state.progress, 100, "progresso final = 100%");
    assert.equal(state.filesTotal, 102, "total = 100 .txt + 1 .tmp + 1 ghost = 102");

    // Extrair todos os eventos de progresso deste scan em ordem temporal.
    const scanEvents = engine.events.filter((e) => e.id === id);
    assert.ok(scanEvents.length > 0, "pelo menos um evento publicado");

    // Verificar monotonicidade: progress nunca recua.
    let prevProgress = -1;
    let prevRevision = -1;
    const regressions = [];
    for (let i = 0; i < scanEvents.length; i++) {
      const ev = scanEvents[i];
      if (ev.progress < prevProgress) {
        regressions.push({ idx: i, from: prevProgress, to: ev.progress, status: ev.status, phase: ev.phase });
      }
      prevProgress = ev.progress;
      if (ev.revision <= prevRevision) {
        regressions.push({ idx: i, revision: ev.revision, prevRevision, type: "revision_non_increasing" });
      }
      prevRevision = ev.revision ?? -1;
    }
    assert.equal(regressions.length, 0, `progresso recuou ${regressions.length} vezes: ${JSON.stringify(regressions)}`);
  });

  it("o eixo global (scanProgressPercent) também é monótono — 0 ou 100 em terminal", async () => {
    const engine = makeEngine();
    const mgr = new ScanManager(engine);
    const ghostDir = path.join(tmp, "ghost");

    mgr.resolvePathsForScan = async () => [tmp, ghostDir];

    const id = await mgr.startScan("custom", undefined);
    await waitTerminal(mgr, id);

    const scanEvents = engine.events.filter((e) => e.id === id);
    const calcProgress = (ev) => {
      const terminal = ["completed", "cancelled", "failed"].includes(ev.status);
      if (terminal) return ev.progress;
      if (ev.phase === "gathering" || ev.phase === "preparing") return null;
      if (ev.filesTotal && ev.filesTotal > 0) {
        return Math.max(0, Math.min(100, Math.floor((ev.filesScanned / ev.filesTotal) * 100)));
      }
      return null;
    };

    let prevPct = -Infinity;
    for (const ev of scanEvents) {
      const pct = calcProgress(ev);
      if (pct !== null) {
        assert.ok(
          pct >= prevPct,
          `progresso calculado recuou: ${prevPct} -> ${pct} (progress=${ev.progress}, scanned=${ev.filesScanned}, total=${ev.filesTotal}, phase=${ev.phase})`,
        );
        prevPct = pct;
      }
    }

    const final = scanEvents[scanEvents.length - 1];
    const isTerminal = ["completed", "cancelled", "failed"].includes(final.status);
    assert.ok(isTerminal, `estado final é terminal (${final.status})`);
    if (final.status === "completed") {
      assert.equal(final.progress, 100, "scan completo: progresso 100%");
    }
  });

  it("scan sem ficheiros falha imediatamente com motivo explícito (nunca 'a carregar' nem 'completed')", async () => {
    const engine = makeEngine();
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l6-empty-"));
    try {
      const mgr = new ScanManager(engine);
      mgr.resolvePathsForScan = async () => [emptyDir];

      const id = await mgr.startScan("custom", emptyDir);
      const state = await waitTerminal(mgr, id);

      assert.equal(state.status, "failed", "0 ficheiros → failed imediato, nunca 'a carregar'");
      assert.match(state.error ?? "", /Nenhum ficheiro para analisar no alvo selecionado\./);
      assert.ok(state.progress < 100, "scan falhado não afirma 100%");
      assert.equal(state.filesTotal, 0);
      assert.equal(state.filesScanned, 0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
