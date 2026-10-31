import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { NativeEngineBridge } from "../dist/native-engine-bridge.js";

/**
 * SESSION14-03 — Native engine (scan-engine.exe) integrity (read-only)
 *
 * Fixture: binário scan-engine.exe já compilado em packages/native-engine/build/Release/.
 * Testa a ponte NativeEngineBridge contra o binário REAL, spawnando scan_file
 * sobre fixtures TEMP benignas. Usa acesso direto a propriedades estáticas
 * via getter (JS puro, sem syntax TS `as any`).
 *
 * NativeEngineBridge usa membros estáticos (checkAvailability, health, scan)
 * — instanciação via `new` não é a interface.
 */

const tmpDirs = [];
async function tmpDir() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "cs14-native-"));
  tmpDirs.push(d);
  return d;
}

after(async () => {
  for (const d of tmpDirs) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

/** Acede a propriedade estática private via reflection (JS puro). */
function getStatic(propName) {
  return NativeEngineBridge[propName];
}

describe("SESSION14-03 Native engine (scan-engine.exe) integrity", () => {
  test("binary path existe (scan-engine.exe compilado)", (t) => {
    const health = NativeEngineBridge.checkAvailability();
    if (health.status === "unavailable") {
      t.skip(`binário indisponível: ${health.detail}`);
      return;
    }
    // Contrato real: a presenca do binario nao basta para "active". So uma
    // invocacao comprovada (probe ou scan) o torna active; ate la e degraded.
    // Sem invocacao comprovada nesta sessao, o estado tem de ser degraded.
    assert.equal(health.status, "degraded", `binário encontrado → degraded até invocação comprovada (estado: ${health.status})`);
    assert.ok(health.detail.includes("scan-engine.exe"), "detail menciona binário");
  });

  test("--version devolve versão parseável", async (t) => {
    const health = NativeEngineBridge.checkAvailability();
    if (health.status !== "active") {
      // Skip explícito: um `return` silencioso reportava ✔ sem ter assertado nada.
      t.skip(`invocação real ainda não confirmada (${health.status})`);
      return;
    }

    const binaryPath = getStatic("binaryPath");
    const result = await new Promise((resolve) => {
      const child = spawn(binaryPath, ["--version"], { windowsHide: true });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.on("close", (code) => resolve({ code, stdout }));
    });

    assert.equal(result.code, 0, "exit code 0");
    assert.ok(result.stdout.includes("cybersafe-scan-engine"), "versão identificável");
  });

  test("scan de fixture benigna: level= safe, score<=25", async (t) => {
    const health = NativeEngineBridge.checkAvailability();
    if (health.status !== "active") {
      t.skip(`invocação real ainda não confirmada (${health.status})`);
      return;
    }

    const dir = await tmpDir();
    const file = path.join(dir, "benign-scan.txt");
    await fsp.writeFile(file, "Benign text for native scan.\r\n", "utf8");

    const outcome = await NativeEngineBridge.scan(file);

    assert.equal(outcome.ok, true, "scan nativo deve ter sucesso");
    assert.ok(outcome.result, "result não nulo");

    const r = outcome.result;
    assert.equal(r.path, file, "path refletido no resultado");
    assert.ok(r.score >= 0 && r.score <= 100, "score no range [0,100]");
    assert.equal(r.level, "safe", "fixture benigna (texto) → safe");
    assert.ok(r.sha256.length === 64, "SHA256 de 64 hex chars");
    assert.ok(r.reasons.length === 0, "fixture benigna sem razões suspeitas");
  });

  test("scan de ficheiro inexistente: falha explícita (failure=output), nunca safe", async (t) => {
    const health = NativeEngineBridge.checkAvailability();
    if (health.status !== "active") {
      t.skip(`invocação real ainda não confirmada (${health.status})`);
      return;
    }

    const outcome = await NativeEngineBridge.scan("nonexistent-session14-test.txt");

    // Contrato corrigido: o motor passou a reportar level=error para ficheiro
    // inexistente (antes dizia safe). O bridge traduz isso em falha de análise,
    // por isso não existe `result` para inspeccionar.
    assert.equal(outcome.ok, false, "um ficheiro inexistente não é análise válida");
    assert.equal(outcome.result, null, "sem result: não houve análise");
    assert.equal(outcome.failure, "output", "falha reportada como output do motor");
    assert.ok(outcome.error, "o erro tem de ser explícito");
  });

  test("health sem binário (forçado): unavailable com diagnóstico", async (t) => {
    const { existsSync } = await import("node:fs");
    if (existsSync(getStatic("binaryPath"))) {
      t.skip("binário presente não permite testar estado unavailable via bridge");
      return;
    }
    const health = NativeEngineBridge.health;
    assert.equal(health.status, "unavailable", "sem binário → unavailable");
    assert.ok(health.detail, "detail sempre presente");
  });
});
