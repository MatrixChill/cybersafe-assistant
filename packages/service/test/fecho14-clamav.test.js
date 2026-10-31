import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, classifyClamavHealth, parseClamavOutput } from "@cybersafe/core";

/**
 * FECHO14 — ClamAV engine integrity (read-only)
 *
 * Fixture: ficheiro texto benigno em TEMP.
 *
 * Casos testáveis SEM binário clamscan real:
 *  1. Binário indisponível — classifyClamavHealth retorna unavailable/degraded, nunca active
 *  2. ScanFile sem DB — runScanHoldingLease:3193 (_hasSignatures=false) → verdict error, NÃO clean
 *  3. parseClamavOutput invariant — exit 2 sem FOUND nunca é clean (puro, sem clamscan)
 *  4. parseClamavOutput invariant — exit 0 + FOUND → detected (pura lógica de parse)
 *
 * Caso 5 (clean comprovado via spawn mock) e Caso 6 (detected via spawn)
 * — marcados como "não testável sem binário + DB real": isAvailable() roda
 * execFileAsync real (sem seam). Documentado em SESSION14-ENGINES-KILO.md §CLA-02.
 */

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fecho14-clamav-"));
});

after(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function makeFakeChild(pid, code, stdout, stderr) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  const state = { died: false, killCalls: 0 };
  child.state = state;
  child.kill = () => {
    state.killCalls++;
    if (!state.died) child.die(code);
    return true;
  };
  child.die = (c) => {
    if (state.died) return;
    state.died = true;
    if (stdout) child.stdout.push(stdout);
    if (stderr) child.stderr.push(stderr);
    child.stdout.push(null);
    child.stderr.push(null);
    setImmediate(() => child.emit("close", c));
  };
  if (stdout) child.stdout.push(stdout);
  if (stderr) child.stderr.push(stderr);
  child.stdout.push(null);
  child.stderr.push(null);
  setImmediate(() => child.emit("spawn"));
  return child;
}

describe("FECHO14 — ClamAV engine integrity", () => {
  it("Caso 1: classifyClamavHealth sem clamscan → unavailable/degraded, NUNCA active", () => {
    const { available, health } = classifyClamavHealth({
      versionOutput: null,
      versionError: "not found",
      dbDir: null,
      dbFiles: null,
    });
    assert.equal(available, false, "sem clamscan → não available");
    assert.notEqual(health.status, "active", "invariante: nunca active sem binary");
    assert.ok(
      health.status === "unavailable" || health.status === "degraded",
      "deve ser unavailable/degraded",
    );
    assert.ok(health.detail, "sempre inclui diagnóstico");
  });

  it("Caso 2: ClamavBridge sem DB → scanFile verdict=error, NÃO clean", async () => {
    const bridge = new ClamavBridge({
      dbDir: "/nonexistent/clamav-db",
      spawn: () => {
        throw new Error("ENOENT");
      },
      spawnSync: () => {
        throw new Error("ENOENT");
      },
    });

    const file = path.join(tmpDir, "benign.txt");
    await fs.writeFile(file, "benign content\n");

    const result = await bridge.scanFile(file);
    assert.equal(result.detected, false, "não detecta sem DB");
    assert.equal(result.verdict, "error", "sem DB → error");
    assert.notEqual(result.verdict, "clean", "INVARIANT: NUNCA clean sem escaneio");
  });

  it("Caso 3: ClamavBridge health inicial — unavailable", () => {
    const bridge = new ClamavBridge();
    assert.notEqual(bridge.health.status, "active", "sem init → não active");
  });

  it("Caso 4: parseClamavOutput — exit 2 sem FOUND NUNCA é clean (invariant)", () => {
    // Puro: recebe output, devolve veredicto. Não spawn, não toca disco.
    const out = parseClamavOutput({
      files: ["C:\\tmp\\missing.txt"],
      stdout: "",
      stderr: "clamscan: WARNING: Cannot access file",
      code: 2,
      fileExists: (f) => f.endsWith("missing.txt"),
    });
    assert.equal(out.files[0].verdict, "error", "exit 2 sem FOUND → error");
    assert.notEqual(out.files[0].verdict, "clean", "exit 2 NUNCA clean");
    assert.equal(out.detected, false, "sem FOUND → não detected");
  });

  it("Caso 5: parseClamavOutput — exit 0 sem FOUND → clean comprovado", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\safe.txt"],
      stdout: "----------- SCAN SUMMARY ----------\nKnown viruses: 1\nScanned files: 1\nInfected files: 0\n",
      stderr: "",
      code: 0,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "clean", "exit 0 sem FOUND → clean");
    assert.equal(out.detected, false, "sem detecção → não detected");
  });

  it("Caso 6: parseClamavOutput — FOUND no stdout → detected (invariant)", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\eicar.txt"],
      stdout: "C:\\tmp\\eicar.txt: Eicar-Signature FOUND\n",
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "detected", "FOUND → detected");
    assert.equal(out.detected, true, "FOUND → detected=true");
    assert.equal(out.files[0].signature, "Eicar-Signature", "signature preservada");
  });

  it(
    "Caso 7: clean via spawn mock — NÃO TESTÁVEL sem DB real (isAvailable usa execFileAsync sem seam)",
    { skip: "CLA-02: isAvailable() sem seam injection → _hasSignatures=false, scanFile retorna error antes do spawn mockado" },
    async () => {
      // Placeholder: o spawn mockado nunca é atingido porque probe() falha
      // antes (execFileAsync clamscan --version). Documentado, não testado.
      assert.fail("skip esperado");
    },
  );
});
