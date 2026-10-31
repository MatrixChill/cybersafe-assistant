import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { NativeEngineBridge } from "../dist/native-engine-bridge.js";

/**
 * RC22 — GUARDA DE INIT DO MOTOR NATIVO.
 *
 * O init do serviço chamava `NativeEngineBridge.probe()` fora de teste, sem
 * negar `CYBERSAFE_DEV_WINDOWS_READONLY=1` nem `CYBERSAFE_REALDEV_FIXTURE_SCAN=1`.
 * O probe spawna `scan-engine.exe`: num Windows real em leitura, ou numa fixture
 * controlada, isso é exactamente a execução que o modo proíbe.
 *
 * Aqui prova-se, sobre o bridge REAL:
 *  - nas duas flags e em teste: `scan` = 0 e `fs.existsSync` = 0 (nada de fs/spawn);
 *  - controlo normal: `scan` = 1 (o probe não ficou desligado por acidente);
 *  - `active` só depois de uma invocação válida — modo bloqueado fica `degraded`.
 */

const FILA = ["CYBERSAFE_DEV_WINDOWS_READONLY", "CYBERSAFE_REALDEV_FIXTURE_SCAN", "NODE_ENV"];
let guardado;

beforeEach(() => {
  guardado = Object.fromEntries(FILA.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of FILA) {
    if (guardado[k] === undefined) delete process.env[k];
    else process.env[k] = guardado[k];
  }
});

function limpar() {
  for (const k of FILA) delete process.env[k];
}

/** Espia o `scan` do bridge (que faria o spawn) e o fs do caminho do probe. */
async function medir() {
  const originalScan = NativeEngineBridge.scan;
  const originalExists = fs.existsSync;
  let scans = 0;
  let stats = 0;
  NativeEngineBridge.scan = async () => {
    scans += 1;
    // Modela a invocação válida que o `scan` real regista; `record` é privado
    // só para o TypeScript, por isso o acesso por índice em teste.
    NativeEngineBridge["record"]({ ok: true, detail: "ok", at: Date.now() });
    return { ok: true, result: { sha256: "0".repeat(64), score: 0 } };
  };
  fs.existsSync = (...args) => {
    stats += 1;
    return originalExists.apply(fs, args);
  };
  try {
    const health = await NativeEngineBridge.probe();
    return { scans, stats, health };
  } finally {
    NativeEngineBridge.scan = originalScan;
    fs.existsSync = originalExists;
  }
}

describe("RC22 guarda de init do motor nativo", () => {
  it("read-only: probe não invoca scan nem toca no fs", async () => {
    limpar();
    process.env.CYBERSAFE_DEV_WINDOWS_READONLY = "1";
    const { scans, stats, health } = await medir();
    assert.equal(scans, 0, "read-only não pode spawnar o motor");
    assert.equal(stats, 0, "nem sequer verificar a existência do binário");
    assert.equal(health.status, "degraded", "sem invocação, `active` seria falso");
    assert.match(health.detail, /read-only|fixture|teste/i);
  });

  it("fixture: probe não invoca scan nem toca no fs", async () => {
    limpar();
    process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN = "1";
    const { scans, stats, health } = await medir();
    assert.equal(scans, 0);
    assert.equal(stats, 0);
    assert.equal(health.status, "degraded");
  });

  it("NODE_ENV=test: também não spawna", async () => {
    limpar();
    process.env.NODE_ENV = "test";
    const { scans, stats } = await medir();
    assert.equal(scans, 0);
    assert.equal(stats, 0);
  });

  it("controlo normal: o probe corre e invoca o scan uma vez", async () => {
    limpar();
    const { scans, health } = await medir();
    assert.equal(scans, 1, "sem as flags o probe tem de continuar a acontecer");
    assert.equal(health.status, "active", "só depois de uma invocação válida");
  });

  it("probePermitida mapeia as flags uma a uma", () => {
    assert.equal(NativeEngineBridge.probePermitida({}), true);
    assert.equal(NativeEngineBridge.probePermitida({ CYBERSAFE_DEV_WINDOWS_READONLY: "1" }), false);
    assert.equal(NativeEngineBridge.probePermitida({ CYBERSAFE_REALDEV_FIXTURE_SCAN: "1" }), false);
    assert.equal(NativeEngineBridge.probePermitida({ NODE_ENV: "test" }), false);
    assert.equal(
      NativeEngineBridge.probePermitida({ CYBERSAFE_DEV_WINDOWS_READONLY: "0", CYBERSAFE_REALDEV_FIXTURE_SCAN: "0" }),
      true,
      "só o valor \"1\" ativa o modo",
    );
  });
});
