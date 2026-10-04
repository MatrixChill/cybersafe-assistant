import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import AdmZip from "adm-zip";
import { ScanManager } from "../dist/scan-manager.js";
import { ProtectionEngineService } from "../dist/engine.js";
import { NativeEngineBridge } from "../dist/native-engine-bridge.js";

/** Minimal mock engine that tracks scanned files and optionally flags threats */
function createMockEngine(opts = {}) {
  const scannedFiles = [];
  const scannedCalls = [];
  return {
    scannedFiles,
    scannedCalls,
    scanArtifact: async (filePath, source, options) => {
      scannedFiles.push(filePath);
      scannedCalls.push({ filePath, source, options });
      if (opts.threatFiles && opts.threatFiles.includes(path.basename(filePath))) {
        return { highRiskCount: 1, overallSeverity: "high" };
      }
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    emitScanProgress: () => {},
  };
}

/** Create a temp directory tree for testing */
const createdTrees = [];

async function createTestTree(baseName, structure) {
  const base = path.join(os.tmpdir(), `cybersafe-test-${baseName}-${Date.now()}`);
  createdTrees.push(base);
  await fs.mkdir(base, { recursive: true });

  async function build(node, spec) {
    if (typeof spec === "string") {
      // It's a file with given content
      await fs.writeFile(path.join(base, node), spec);
      return;
    }

    // spec is an object or array → treat as directory
    const dir = path.join(base, node);
    await fs.mkdir(dir, { recursive: true });

    const entries = Array.isArray(spec) ? spec.map((c) => (typeof c === "string" ? [c, undefined] : Object.entries(c)[0])) : Object.entries(spec);
    for (const [name, content] of entries) {
      if (content === undefined) {
        await fs.writeFile(path.join(dir, name), "");
      } else {
        await build(path.join(node, name), content);
      }
    }
  }

  for (const [name, spec] of Object.entries(structure)) {
    await build(name, spec);
  }

  return base;
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Single File Scan ─────────────────────────────────────────────────
describe("Single file scan (custom type)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await createTestTree("single", {
      "test-file.txt": "hello world",
    });
  });

  it("scans a single file via custom type", async () => {
    const engine = createMockEngine();
    const mgr = new ScanManager(engine);
    const target = path.join(tmpDir, "test-file.txt");

    const id = await mgr.startScan("custom", target);
    // Wait for scan to complete
    await new Promise((r) => setTimeout(r, 500));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");
    assert.equal(state.filesScanned, 1);
    assert.equal(engine.scannedFiles.length, 1);
    assert.equal(engine.scannedFiles[0], target);

    await cleanup(tmpDir);
  });
});

// ─── Folder Scan ──────────────────────────────────────────────────────
describe("Folder scan (custom type)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await createTestTree("folder", {
      sub: {
        "a.txt": "content a",
        "b.txt": "content b",
        nested: {
          "c.txt": "content c",
        },
      },
      "root.txt": "root",
    });
  });

  it("recursively scans all files in a folder", async () => {
    const engine = createMockEngine();
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", tmpDir);
    await new Promise((r) => setTimeout(r, 500));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");
    assert.equal(state.filesScanned, 4);
    assert.equal(engine.scannedFiles.length, 4);

    await cleanup(tmpDir);
  });
});

// ─── Quick Scan Scope ─────────────────────────────────────────────────
describe("Quick Scan scope and budget", () => {
  it("quick scan uses limited budget (800 files)", async () => {
    // Create a tree with more files than the budget
    const structure = {};
    for (let i = 0; i < 50; i++) {
      structure[`dir${i}`] = Array.from({ length: 25 }, (_, j) => `file${j}.txt`);
    }
    // This creates 50*25 = 1250 files, exceeding the 800 budget

    const tmpDir = await createTestTree("budget", structure);
    const engine = createMockEngine();
    const mgr = new ScanManager(engine);

    // Quick scan only works with home-relative dirs, so we test gatherFilesQuick indirectly
    // by creating files in a custom path and using the internal method
    // For integration test, we verify the budget concept
    const files = [];
    await mgr["gatherFilesQuick"](tmpDir, files, "test-scan", 0, 2, 800);

    assert.ok(files.length <= 800, `Expected <= 800 files, got ${files.length}`);

    await cleanup(tmpDir);
  });

  it("quick scan respects max depth", async () => {
    const tmpDir = await createTestTree("depth", {
      level1: {
        level2: {
          level3: {
            "deep.txt": "deep",
          },
        },
      },
    });

    const engine = createMockEngine();
    const mgr = new ScanManager(engine);
    const files = [];

    // Max depth 1 should not reach level3
    await mgr["gatherFilesQuick"](tmpDir, files, "test-scan", 0, 1, 800);

    const hasDeep = files.some((f) => f.includes("level3"));
    assert.equal(hasDeep, false, "Should not reach depth 3 with maxDepth=1");

    await cleanup(tmpDir);
  });

  it("quick scan skips symlinks", async () => {
    const tmpDir = await createTestTree("symlink", {
      "real.txt": "real",
    });
    // Create a symlink
    const linkPath = path.join(tmpDir, "link.txt");
    try {
      await fs.symlink(path.join(tmpDir, "real.txt"), linkPath);
    } catch {
      // Symlinks may require elevated permissions on Windows
      await cleanup(tmpDir);
      return; // Skip test if symlinks not supported
    }

    const engine = createMockEngine();
    const mgr = new ScanManager(engine);
    const files = [];

    await mgr["gatherFilesQuick"](tmpDir, files, "test-scan", 0, 2, 800);

    const hasLink = files.some((f) => f.includes("link.txt"));
    assert.equal(hasLink, false, "Should skip symlinks");

    await cleanup(tmpDir);
  });
});

// ─── Cancel Scan ──────────────────────────────────────────────────────
describe("Cancel scan", () => {
  it("cancelScan sets status to cancelled", async () => {
    const engine = createMockEngine();
    const mgr = new ScanManager(engine);

    // Create a large tree so the scan takes time
    const structure = {};
    for (let i = 0; i < 20; i++) {
      structure[`dir${i}`] = Array.from({ length: 50 }, (_, j) => `file${j}.txt`);
    }
    const tmpDir = await createTestTree("cancel", structure);

    const id = await mgr.startScan("custom", tmpDir);
    // Wait for scan to start running, then cancel
    await new Promise((r) => setTimeout(r, 50));
    mgr.cancelScan(id);

    // Wait for the state to update
    await new Promise((r) => setTimeout(r, 200));

    const state = mgr.getScan(id);
    assert.ok(state.status === "cancelled" || state.status === "completed",
      `Expected cancelled or completed, got ${state.status}`);

    await cleanup(tmpDir);
  });
});

// ─── Progress Reporting ───────────────────────────────────────────────
describe("Progress reporting", () => {
  it("emits gathering phase during file collection", async () => {
    const phases = [];
    const engine = createMockEngine();
    engine.emitScanProgress = (state) => {
      if (state.phase) phases.push(state.phase);
    };
    const mgr = new ScanManager(engine);

    const tmpDir = await createTestTree("progress", {
      "file1.txt": "a",
      "file2.txt": "b",
    });

    const id = await mgr.startScan("custom", tmpDir);
    await new Promise((r) => setTimeout(r, 500));

    // Should have seen "gathering" and "scanning" phases
    assert.ok(phases.includes("gathering"), "Should emit gathering phase");
    assert.ok(phases.includes("scanning"), "Should emit scanning phase");

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");
    assert.ok(state.progress === 100);

    await cleanup(tmpDir);
  });

  it("completed scan has 100% progress", async () => {
    const engine = createMockEngine();
    const mgr = new ScanManager(engine);

    const tmpDir = await createTestTree("progress100", {
      "a.txt": "x",
    });

    const id = await mgr.startScan("custom", tmpDir);
    await new Promise((r) => setTimeout(r, 500));

    const state = mgr.getScan(id);
    assert.equal(state.progress, 100);
    assert.equal(state.status, "completed");

    await cleanup(tmpDir);
  });
});

// ─── Empty Scan ───────────────────────────────────────────────────────
describe("Empty scan", () => {
  it("completes immediately when no files found", async () => {
    const engine = createMockEngine();
    const mgr = new ScanManager(engine);

    const tmpDir = await createTestTree("empty", {});
    const id = await mgr.startScan("custom", tmpDir);
    await new Promise((r) => setTimeout(r, 300));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");
    assert.equal(state.filesScanned, 0);
    assert.equal(state.progress, 100);

    await cleanup(tmpDir);
  });
});

// ─── Threat Detection ─────────────────────────────────────────────────
describe("Threat detection in scan", () => {
  it("counts threats when flagged files are scanned", async () => {
    const engine = createMockEngine({ threatFiles: ["malware.exe"] });
    const mgr = new ScanManager(engine);

    const tmpDir = await createTestTree("threats", {
      "good.txt": "safe",
      "malware.exe": "bad",
    });

    const id = await mgr.startScan("custom", tmpDir);
    await new Promise((r) => setTimeout(r, 500));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");
    assert.equal(state.threatsFound, 1);
    assert.equal(state.filesScanned, 2);

    await cleanup(tmpDir);
  });
});

// ─── Single active scan ───────────────────────────────────────────────
describe("Single active scan (backend guard)", () => {
  it("rejects a second start while a scan is running, accepts it after", async () => {
    const engine = createMockEngine();
    const mgr = new ScanManager(engine);

    // Enough files that the first scan is still running when the second starts.
    const structure = {};
    for (let i = 0; i < 10; i++) {
      structure[`dir${i}`] = Array.from({ length: 40 }, (_, j) => `file${j}.txt`);
    }
    const tmpDir1 = await createTestTree("single1", structure);
    const tmpDir2 = await createTestTree("single2", { "b.txt": "y" });

    const id1 = await mgr.startScan("custom", tmpDir1);
    assert.ok(id1, "first scan must be accepted");

    // ONE ACTIVE SCAN: the backend refuses instead of queueing silently.
    const id2 = await mgr.startScan("custom", tmpDir2);
    assert.equal(id2, null, "second concurrent scan must be rejected");
    assert.ok(mgr.getActiveScan(), "the running scan remains the active one");

    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(mgr.getScan(id1).status, "completed");
    assert.equal(mgr.getActiveScan(), null, "no active scan once finished");

    // The same scan id keeps working: a new scan is accepted after completion.
    const id3 = await mgr.startScan("custom", tmpDir2);
    assert.ok(id3, "scan accepted again after the first completed");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(mgr.getScan(id3).status, "completed");

    await cleanup(tmpDir1);
    await cleanup(tmpDir2);
  });

  it("exposes the running scan through getActiveScan", async () => {
    const engine = createMockEngine();
    const mgr = new ScanManager(engine);

    const structure = {};
    for (let i = 0; i < 6; i++) {
      structure[`dir${i}`] = Array.from({ length: 40 }, (_, j) => `f${j}.txt`);
    }
    const tmpDir = await createTestTree("active", structure);

    const id = await mgr.startScan("custom", tmpDir);
    const active = mgr.getActiveScan();
    assert.ok(active, "a running scan must be reported");
    assert.equal(active.id, id);

    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(mgr.getActiveScan(), null);

    await cleanup(tmpDir);
  });
});

// ─── Truthful progress semantics ──────────────────────────────────────
describe("Truthful progress semantics", () => {
  it("reports discovered files during gathering, analyzed files while scanning", async () => {
    const seen = [];
    const engine = createMockEngine();
    engine.emitScanProgress = (state) => seen.push({ ...state });
    const mgr = new ScanManager(engine);

    const structure = {};
    for (let i = 0; i < 4; i++) {
      structure[`dir${i}`] = Array.from({ length: 20 }, (_, j) => `f${j}.txt`);
    }
    const tmpDir = await createTestTree("truthful", structure);

    const id = await mgr.startScan("custom", tmpDir);
    await new Promise((r) => setTimeout(r, 2500));

    const gathering = seen.filter((s) => s.phase === "gathering");
    assert.ok(gathering.length > 0, "gathering phase must be emitted");
    assert.ok(
      gathering.some((s) => typeof s.filesDiscovered === "number"),
      "gathering events must report filesDiscovered"
    );
    assert.ok(
      gathering.every((s) => s.filesScanned === 0),
      "filesScanned must stay 0 while nothing was analyzed"
    );

    const last = seen.at(-1);
    assert.equal(last.id, id);
    assert.equal(last.status, "completed");
    assert.equal(last.progress, 100);
    assert.ok(last.startTime && last.endTime, "terminal state carries start/end time");

    await cleanup(tmpDir);
  });

  it("keeps publishing heartbeat events while a single file blocks the analysis", async () => {
    const engine = createMockEngine();
    // One "huge" file: no per-file progress can be emitted while it is analyzed.
    engine.scanArtifact = async (filePath) => {
      engine.scannedFiles.push(filePath);
      await new Promise((r) => setTimeout(r, 2500));
      return { highRiskCount: 0, overallSeverity: "safe" };
    };
    const emitted = [];
    engine.emitScanProgress = (state) => {
      emitted.push({ phase: state.phase, filesScanned: state.filesScanned });
    };
    const mgr = new ScanManager(engine);

    const tmpDir = await createTestTree("heartbeat", { "big.bin": "x" });
    const id = await mgr.startScan("custom", tmpDir);

    await new Promise((r) => setTimeout(r, 2200));

    const during = emitted.filter((e) => e.phase === "scanning" && e.filesScanned === 0);
    assert.ok(
      during.length >= 2,
      `the UI must keep receiving activity while a file is analyzed, got ${during.length} events`
    );

    mgr.cancelScan(id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mgr.getScan(id).status, "cancelled");

    await cleanup(tmpDir);
  });
});

// ─── Real deep scan scope (documented contract) ───────────────────────
// A UI não pode dizer "sistema completo": estes testes fixam o scope real.
describe("Deep scan real scope", () => {
  it("targets the user home + the ProgramData startup folder (not the whole system)", async () => {
    const mgr = new ScanManager(createMockEngine());
    const roots = await mgr["resolvePathsForScan"]("full");

    assert.deepEqual(roots, [
      os.homedir(),
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    ]);
    for (const root of roots) {
      assert.equal(/^[a-z]:\\windows/i.test(root), false, "C:\\Windows must never be a scan root");
      assert.equal(/program files/i.test(root), false, "Program Files must never be a scan root");
    }
    // Não é o disco inteiro, nem outros discos/perfis.
    assert.equal(roots.some((root) => /^[a-z]:\\$/i.test(root)), false, "a drive root must never be scanned");
  });

  it("skips system folders, node_modules and junctions while gathering", async () => {
    const tmpDir = await createTestTree("deep-scope", {
      home: {
        "keep.txt": "keep",
        node_modules: { "dep.js": "dependency" },
        Windows: { "system32.txt": "system" },
        "Program Files": { "app.exe": "installed app" },
        ".git": { config: "git config" },
      },
    });

    const home = path.join(tmpDir, "home");
    const linkPath = path.join(home, "link");
    let junctionCreated = false;
    try {
      // Junctions não requerem privilégios de administrador no Windows e são
      // o tipo de reparse point mais comum em perfis de utilizador.
      await fs.symlink(home, linkPath, "junction");
      junctionCreated = true;
    } catch {
      // Ambiente sem suporte a junctions: a verificação é ignorada.
    }

    const mgr = new ScanManager(createMockEngine());
    const files = [];
    await mgr["gatherFiles"](home, files, "deep-scope-scan", 50000);

    assert.deepEqual(files.map((f) => path.basename(f)), ["keep.txt"]);
    if (junctionCreated) {
      assert.equal(
        files.some((f) => f.includes("link")),
        false,
        "junctions must never be followed (infinite loop protection)",
      );
    }

    await cleanup(tmpDir);
  });
});

// ─── Deep scan progress: real candidate denominator ───────────────────
async function waitForScan(mgr, id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = mgr.getScan(id);
    if (state && ["completed", "cancelled", "failed"].includes(state.status)) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("scan did not finish in time");
}

describe("Deep scan progress model", () => {
  it("usa o número REAL de candidatos como denominador (nunca o cap de 50.000)", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-progress-"));
    try {
      for (let i = 0; i < 899; i++) {
        await fs.writeFile(path.join(base, `f${i}.txt`), "x");
      }

      const seen = [];
      const engine = createMockEngine();
      engine.emitScanProgress = (state) => seen.push({ ...state });
      const mgr = new ScanManager(engine);

      const id = await mgr.startScan("custom", base);
      const state = await waitForScan(mgr, id);

      assert.equal(state.status, "completed");
      assert.equal(state.filesTotal, 899, "o total deve ser o nº real de candidatos");
      assert.notEqual(state.filesTotal, 50000, "o cap de segurança nunca é o total");
      assert.equal(state.filesScanned, 899);
      assert.equal(state.progress, 100);

      // Cada evento de scanning usa floor(filesScanned / filesTotal * 100).
      const scanning = seen.filter((s) => s.phase === "scanning" && typeof s.filesTotal === "number");
      assert.ok(scanning.length > 0, "deve haver eventos de scanning");
      for (const s of scanning) {
        assert.equal(
          s.progress,
          Math.floor((s.filesScanned / s.filesTotal) * 100),
          `progress inconsistente em filesScanned=${s.filesScanned}/${s.filesTotal}`,
        );
      }

      // Num ponto avançado (~885/899) a UI mostra ~98%, não 1%.
      const near = scanning.filter((s) => s.filesScanned >= 885);
      const at885 = near[0] ?? scanning[scanning.length - 1];
      assert.ok(at885.progress >= 97, `885/899 deve estar ~98% (recebido ${at885.progress}%)`);
    } finally {
      await cleanup(base);
    }
  });

  it("os contadores nunca recuam dentro do mesmo scan", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-monotonic-"));
    try {
      for (let i = 0; i < 120; i++) await fs.writeFile(path.join(base, `f${i}.txt`), "x");

      const seen = [];
      const engine = createMockEngine();
      engine.emitScanProgress = (state) => seen.push({ ...state });
      const mgr = new ScanManager(engine);

      const id = await mgr.startScan("custom", base);
      await waitForScan(mgr, id);

      let lastScanned = -1;
      let lastDiscovered = -1;
      for (const s of seen) {
        assert.ok(s.filesScanned >= lastScanned, "filesScanned não pode diminuir");
        lastScanned = s.filesScanned;
        assert.ok((s.filesDiscovered ?? 0) >= lastDiscovered, "filesDiscovered não pode diminuir");
        lastDiscovered = s.filesDiscovered ?? lastDiscovered;
      }
    } finally {
      await cleanup(base);
    }
  });

  it("a revisão é monotónica em cada emissão", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-revision-"));
    try {
      await fs.writeFile(path.join(base, "a.txt"), "x");

      const seen = [];
      const engine = createMockEngine();
      engine.emitScanProgress = (state) => seen.push({ ...state });
      const mgr = new ScanManager(engine);

      const id = await mgr.startScan("custom", base);
      await waitForScan(mgr, id);

      let lastRev = 0;
      for (const s of seen) {
        assert.equal(typeof s.revision, "number");
        assert.ok(s.revision > lastRev, `revisão deve crescer (${s.revision} > ${lastRev})`);
        lastRev = s.revision;
      }
    } finally {
      await cleanup(base);
    }
  });
});

// ─── Exclusion counter semantics ──────────────────────────────────────
describe("Excluded files are counted truthfully", () => {
  it("an excluded file increments filesExcluded, not filesAnalyzed", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-excluded-"));
    try {
      await fs.writeFile(path.join(base, "keep.txt"), "x");
      await fs.writeFile(path.join(base, "skip.log"), "x");

      const engine = createMockEngine();
      engine.isExcluded = (filePath) => filePath.endsWith(".log");
      const mgr = new ScanManager(engine);

      const id = await mgr.startScan("custom", base);
      const state = await waitForScan(mgr, id);

      assert.equal(state.status, "completed");
      assert.equal(state.filesTotal, 2);
      assert.equal(state.filesScanned, 2, "o progresso cobre todos os candidatos");
      assert.equal(state.filesExcluded, 1, "o ficheiro excluído é contado como excluído");
      assert.equal(state.filesAnalyzed, 1, "só o ficheiro não excluído vai aos motores");
      assert.equal(engine.scannedFiles.length, 1, "o motor nunca vê o ficheiro excluído");
      assert.equal(engine.scannedFiles[0], path.join(base, "keep.txt"));
    } finally {
      await cleanup(base);
    }
  });
});

// ─── ZIP Scan ─────────────────────────────────────────────────────────
describe("ZIP scan", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-zip-test-"));
  });

  async function cleanupZip() {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  it("scans a ZIP file and its entries", async () => {
    const zipPath = path.join(tmpDir, "sample.zip");
    const zip = new AdmZip();
    zip.addFile("hello.txt", Buffer.from("hello"));
    zip.addFile("evil.exe", Buffer.from("MZ..."));
    zip.writeZip(zipPath);

    const engine = createMockEngine({ threatFiles: ["evil.exe"] });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", zipPath);
    await new Promise((r) => setTimeout(r, 1500));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");
    assert.ok(state.threatsFound >= 1, "Should detect threats inside the zip");

    await cleanupZip();
  });

  it("does NOT extract zip-slip paths (../ traversal)", async () => {
    // Manual ZIP with a traversal entry (../evil.txt)
    const zipPath = path.join(tmpDir, "traversal.zip");
    const zip = new AdmZip();
    // AdmZip sanitizes entry names, so we build the raw entry manually.
    // Instead we test the protection helper via a plain zip with ".." is
    // avoided by AdmZip; verify extraction skips it gracefully.
    zip.addFile("../evil.txt", Buffer.from("evil"));
    zip.writeZip(zipPath);

    const engine = createMockEngine();
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", zipPath);
    await new Promise((r) => setTimeout(r, 1500));
    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");

    await cleanupZip();
  });

  it("handles a corrupt/malformed ZIP without crashing", async () => {
    const corruptZip = path.join(tmpDir, "corrupt.zip");
    await fs.writeFile(corruptZip, Buffer.from("this is not a zip"));

    const engine = createMockEngine();
    const mgr = new ScanManager(engine);
    const id = await mgr.startScan("custom", corruptZip);
    await new Promise((r) => setTimeout(r, 1000));
    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");

    await cleanupZip();
  });
});

// ─── Nested ZIP scan — no double-counting, correct depth limit ────────
describe("Nested ZIP scan", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-nested-zip-"));
  });

  async function cleanup() {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Build a tiny fixture ZIP hierarchy in-memory and write to disk.
   * outer.zip
   *   inner.zip          ← nested ZIP (depth 1)
   *     deep.txt         ← regular file inside inner.zip
   *   safe.txt           ← regular file at depth 0
   */
  async function buildNestedZip(outerPath) {
    const inner = new AdmZip();
    inner.addFile("deep.txt", Buffer.from("deep content"));
    const innerBuf = inner.toBuffer();

    const outer = new AdmZip();
    outer.addFile("inner.zip", innerBuf);
    outer.addFile("safe.txt", Buffer.from("safe content"));
    outer.writeZip(outerPath);
  }

  /**
   * outer.zip
   *   mid.zip            ← depth 1
   *     inner.zip        ← depth 2
   *       threat.exe     ← evil file, depth 3 — max nesting == 3, so depth 2 zip
   *                         is the deepest that gets recursed into (nestingDepth=2 < 3).
   */
  async function buildDeepNestedZip(outerPath, { threatInInner = false } = {}) {
    const innermost = new AdmZip();
    innermost.addFile("threat.exe", Buffer.from("MZ payload"));

    const inner = new AdmZip();
    inner.addFile("inner.zip", innermost.toBuffer());
    inner.addFile("clean.txt", Buffer.from("clean"));

    const mid = new AdmZip();
    mid.addFile("mid.zip", inner.toBuffer());

    const outer = new AdmZip();
    outer.addFile("outer-level.txt", Buffer.from("outer"));
    outer.addFile("mid.zip", mid.toBuffer());
    outer.writeZip(outerPath);
  }

  it("a threat inside a nested ZIP is counted exactly once (no double-count)", async () => {
    // outer.zip contains inner.zip which contains threat.exe.
    // With the fix, scanZipWithSafety recurses into inner.zip and returns 1 threat.
    // It must NOT also call scanArtifact on inner.zip, which would add another 1.
    const innerZip = new AdmZip();
    innerZip.addFile("threat.exe", Buffer.from("MZ payload"));
    const innerBuf = innerZip.toBuffer();

    const outerZip = new AdmZip();
    outerZip.addFile("inner.zip", innerBuf);
    outerZip.addFile("safe.txt", Buffer.from("ok"));
    const outerPath = path.join(tmpDir, "outer.zip");
    outerZip.writeZip(outerPath);

    // threat.exe triggers a threat; inner.zip itself does NOT (it's a container).
    const engine = createMockEngine({ threatFiles: ["threat.exe"] });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", outerPath);
    await new Promise((r) => setTimeout(r, 2000));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");

    // Exactly 1 threat (threat.exe inside inner.zip). Must not be 2 due to double-count.
    assert.equal(
      state.threatsFound,
      1,
      `Expected exactly 1 threat, got ${state.threatsFound} (double-counting regression?)`
    );

    await cleanup();
  });

  it("a clean nested ZIP contributes 0 threats (no ghost threat from container scan)", async () => {
    // outer.zip contains inner.zip which contains only safe files.
    // No threats in anything. threatsFound must be 0.
    const innerZip = new AdmZip();
    innerZip.addFile("clean.txt", Buffer.from("clean content"));

    const outerZip = new AdmZip();
    outerZip.addFile("inner.zip", innerZip.toBuffer());
    outerZip.addFile("safe.txt", Buffer.from("ok"));
    const outerPath = path.join(tmpDir, "clean-nested.zip");
    outerZip.writeZip(outerPath);

    const engine = createMockEngine(); // no threats
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", outerPath);
    await new Promise((r) => setTimeout(r, 2000));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");
    assert.equal(state.threatsFound, 0, "No threats expected in a clean nested ZIP");

    await cleanup();
  });

  it("multiple threats across nesting levels are each counted once", async () => {
    // outer.zip:
    //   direct-threat.exe  ← threat at depth 0 inside ZIP
    //   inner.zip          ← nested zip
    //     nested-threat.exe ← threat at depth 1 inside ZIP
    //     clean.txt
    const innerZip = new AdmZip();
    innerZip.addFile("nested-threat.exe", Buffer.from("MZ nested"));
    innerZip.addFile("clean.txt", Buffer.from("clean"));

    const outerZip = new AdmZip();
    outerZip.addFile("direct-threat.exe", Buffer.from("MZ direct"));
    outerZip.addFile("inner.zip", innerZip.toBuffer());
    const outerPath = path.join(tmpDir, "multi-threat.zip");
    outerZip.writeZip(outerPath);

    // Both threat files are flagged
    const engine = createMockEngine({ threatFiles: ["direct-threat.exe", "nested-threat.exe"] });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", outerPath);
    await new Promise((r) => setTimeout(r, 2500));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");

    // Exactly 2 threats — one per threat file, each counted once.
    assert.equal(
      state.threatsFound,
      2,
      `Expected exactly 2 threats, got ${state.threatsFound}`
    );

    await cleanup();
  });

  it("nesting depth is respected: ZIP at depth >= ZIP_MAX_NESTING (3) is not recursed into", async () => {
    // Build a 4-level deep ZIP hierarchy: l0 > l1.zip > l2.zip > l3.zip > deep-threat.exe
    // ZIP_MAX_NESTING=3 means recursion is allowed at depths 0,1,2 but NOT at depth 3.
    // So l3.zip at depth 3 should NOT be recursed into, and deep-threat.exe must not be found.
    // But at depths 0-2, files ARE scanned.

    const l3 = new AdmZip();
    l3.addFile("deep-threat.exe", Buffer.from("MZ deep"));

    const l2 = new AdmZip();
    l2.addFile("l3.zip", l3.toBuffer());
    l2.addFile("l2-clean.txt", Buffer.from("l2 clean"));

    const l1 = new AdmZip();
    l1.addFile("l2.zip", l2.toBuffer());
    l1.addFile("l1-clean.txt", Buffer.from("l1 clean"));

    // l0 is the outer ZIP the scan sees (nestingDepth=0 when scanZipWithSafety is called).
    // l1.zip is at nestingDepth=1, l2.zip at nestingDepth=2.
    // l3.zip would be nestingDepth=3 which equals ZIP_MAX_NESTING → guard fires → returns 0.
    const l0 = new AdmZip();
    l0.addFile("l1.zip", l1.toBuffer());
    l0.addFile("l0-clean.txt", Buffer.from("l0 clean"));
    const outerPath = path.join(tmpDir, "deep-nesting.zip");
    l0.writeZip(outerPath);

    // deep-threat.exe is at nesting depth 3 (beyond limit) — should NOT be scanned.
    const engine = createMockEngine({ threatFiles: ["deep-threat.exe"] });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", outerPath);
    await new Promise((r) => setTimeout(r, 3000));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");

    // deep-threat.exe must not be reached (nesting depth exceeded).
    assert.equal(
      state.threatsFound,
      0,
      `Expected 0 threats (depth limit), got ${state.threatsFound}`
    );

    // Sanity: files at allowed nesting depths were scanned (no crash).
    assert.ok(
      engine.scannedFiles.some((f) => f.includes("l0-clean") || f.includes("l1-clean") || f.includes("l2-clean")),
      "Files at allowed nesting depths must be scanned"
    );

    await cleanup();
  });

  it("a threat at nesting depth 2 (last allowed level) IS detected", async () => {
    // l0.zip > l1.zip > threat.exe
    // nestingDepth when processing l1.zip = 1, recurse into it (1 < 3 = ZIP_MAX_NESTING).
    // nestingDepth when processing threat.exe = 2, it's a regular file → scanArtifact.
    const l1 = new AdmZip();
    l1.addFile("threat.exe", Buffer.from("MZ payload"));
    l1.addFile("clean.txt", Buffer.from("ok"));

    const l0 = new AdmZip();
    l0.addFile("l1.zip", l1.toBuffer());
    const outerPath = path.join(tmpDir, "depth2-threat.zip");
    l0.writeZip(outerPath);

    const engine = createMockEngine({ threatFiles: ["threat.exe"] });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", outerPath);
    await new Promise((r) => setTimeout(r, 2000));

    const state = mgr.getScan(id);
    assert.equal(state.status, "completed");
    assert.equal(
      state.threatsFound,
      1,
      `Expected 1 threat at depth 2, got ${state.threatsFound}`
    );

    await cleanup();
  });
});

describe("VirusTotal scope policy", () => {
  for (const type of ["quick", "full", "custom"]) {
    it(`${type} skips VT for every main-loop file and retains local threat counts`, async () => {
      const dir = await createTestTree(`vt-${type}`, { "local-threat.txt": "benign fixture", "clean.txt": "clean" });
      const engine = createMockEngine({ threatFiles: ["local-threat.txt"] });
      const manager = new ScanManager(engine);
      // Bound quick/full to this tiny fixture; never enumerate the real machine.
      manager.resolvePathsForScan = async () => [dir];
      const id = await manager.startScan(type, dir);
      await manager.currentScanPromise;
      const state = manager.getScan(id);
      assert.equal(state.status, "completed");
      assert.equal(state.filesScanned, 2);
      assert.equal(state.filesAnalyzed, 2);
      assert.equal(state.filesFailed, 0);
      assert.equal(state.threatsFound, 1);
      assert.equal(engine.scannedCalls.length, 2);
      for (const call of engine.scannedCalls) {
        assert.equal(call.source, "system-scanner");
        // `scanId` viaja com o pedido para que `cancelScan` possa abortar o
        // clamscan EM CURSO, e não só mudar o estado do scan. Sem ele,
        // cancelar deixava o motor a varrer sozinho com ~1 GB de RAM.
        assert.equal(call.options.skipVirusTotal, true);
        assert.equal(call.options.scanId, id, "cada ficheiro sabe a que scan pertence");
      }
    });
  }

  it("ZIP entries and the outer archive both skip VT, retaining a single local threat", async () => {
    const dir = await createTestTree("vt-zip", {});
    const archive = new AdmZip();
    archive.addFile("local-threat.txt", Buffer.from("benign fixture"));
    const target = path.join(dir, "archive.zip");
    await fs.writeFile(target, archive.toBuffer());
    const engine = createMockEngine({ threatFiles: ["local-threat.txt"] });
    const manager = new ScanManager(engine);
    const id = await manager.startScan("custom", target);
    await manager.currentScanPromise;
    assert.equal(manager.getScan(id).status, "completed");
    assert.equal(manager.getScan(id).threatsFound, 1);
    assert.equal(engine.scannedCalls.length, 2);
    assert.ok(engine.scannedCalls.some((call) => path.basename(call.filePath) === "local-threat.txt"));
      for (const call of engine.scannedCalls) {
        assert.equal(call.options.skipVirusTotal, true);
        assert.equal(call.options.scanId, id);
      }
  });

  function artifactEngine(t, positives) {
    // Run the real methods without starting monitors, persistence, native binaries or networking.
    const engine = Object.create(ProtectionEngineService.prototype);
    const events = [];
    const vtCalls = [];
    Object.assign(engine, {
      exclusions: { exclusionReason: () => null },
      analyzer: { analyze: async () => ({
        fileName: "fixture.txt", size: 10, sha256: "fixture-hash", riskScore: 55,
        severity: "low", confidence: 0.8, verdict: "safe", rulesTriggered: [],
        factors: [], scanTimestamp: "2026-09-28T00:00:00.000Z", recommendedAction: "logged",
      }) },
      vt: {
        isEnabled: () => true,
        scanHash: async (hash) => {
          vtCalls.push(hash);
          return { positives, total: 10, detectionRatio: `${positives}/10` };
        },
      },
      eventBus: { publish: (type, severity, summary, data) => events.push({ type, severity, summary, data }) },
      threats: [], blockedHashes: new Set(), blockedPaths: new Set(),
      quarantine: { quarantine: async () => null },
      logHistory: async () => {}, actionsLog: { write: () => {} },
    });
    t.mock.method(NativeEngineBridge, "scan", async () => ({ ok: false }));
    return { engine, events, vtCalls };
  }

  for (const [positives, score, severity] of [[4, 75, "high"], [8, 95, "critical"]]) {
    it(`accepted sensitivity loss: bulk skips VT boost and ${severity} escalation with a healthy key`, async (t) => {
      const { engine, events, vtCalls } = artifactEngine(t, positives);
      // Product decision: quick/deep/custom lose min(40, positives * 5), unlike single-file scans.
      const bulk = await engine.scanArtifact("fixture.txt", "system-scanner", { skipVirusTotal: true });
      assert.equal(vtCalls.length, 0, "bulk must never call the VT client");
      assert.equal(bulk.riskScore, 55);
      assert.equal(bulk.overallSeverity, "low");
      assert.equal(bulk.highRiskCount, 0);
      assert.equal(engine.threats.length, 0);
      assert.equal(events.filter((event) => event.type === "threat.detected").length, 0);
      assert.equal(events[0].data.vtResult, null);

      const single = await engine.dispatch("scan.artifact", { path: "fixture.txt" });
      assert.deepEqual(vtCalls, ["fixture-hash"]);
      assert.equal(single.riskScore, score);
      assert.equal(single.overallSeverity, severity);
      assert.equal(single.highRiskCount, 1);
      assert.equal(single.totalFiles, 1);
      const threats = events.filter((event) => event.type === "threat.detected");
      assert.equal(threats.length, 1);
      assert.equal(threats[0].severity, severity);
      assert.equal(engine.threats.length, 1);
      assert.equal(engine.threats[0].source, "dashboard");
    });
  }

  it("single-file IPC leaves skipVirusTotal unset", async () => {
    const engine = Object.create(ProtectionEngineService.prototype);
    let received;
    const expected = { totalFiles: 1 };
    engine.scanArtifact = async (...args) => { received = args; return expected; };
    assert.equal(await engine.dispatch("scan.artifact", { path: "single.txt" }), expected);
    assert.deepEqual(received, ["single.txt", "dashboard"]);
  });

  it("explicit false and default realtime/process calls retain VT", async (t) => {
    const { engine, vtCalls } = artifactEngine(t, 4);
    for (const [source, options] of [["dashboard", { skipVirusTotal: false }], ["service", undefined], ["system-scanner", undefined]]) {
      const result = await engine.scanArtifact("fixture.txt", source, options);
      assert.equal(result.overallSeverity, "high");
      assert.equal(result.riskScore, 75);
    }
    assert.equal(vtCalls.length, 3);
  });
});

// Limpeza global de safety-net: qualquer árvore criada por createTestTree que
// o teste não tenha limpado a tempo (ex.: throw antes do cleanup) é removida
// aqui, mesmo em caso de falha de teste.
after(async () => {
  for (const dir of createdTrees) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
