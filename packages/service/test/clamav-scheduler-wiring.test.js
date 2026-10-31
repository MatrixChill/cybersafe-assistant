/**
 * TP-RETOMA-01 — wiring do agendador de definições no MOTOR.
 *
 * O teste de componente prova a frescura; este prova que o motor usa a guarda
 * certa e que o ciclo de vida fecha o agendador:
 *   - `initInternal` chama o ÚNICO método que liga o agendador;
 *   - `startProtection` já não o liga (não contorna readonly);
 *   - readonly/fixture/test não ligam;
 *   - `dispose()` para o scheduler (e aborta downloads em voo).
 *
 * Sem `init()`: como no c4-option-a, o motor é construído com um root próprio
 * e os subsistemas são duplos. Nenhum watcher/ETW/AMSI/rede/binary real corre.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cs-clamav-wiring-"));

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function makeEngine() {
  const engine = new ProtectionEngineService(path.join(ROOT, "engine"));
  let started = 0;
  let stopped = 0;
  engine.updater.startScheduler = () => {
    started += 1;
  };
  engine.updater.stopScheduler = () => {
    stopped += 1;
  };
  for (const name of ["watcher", "processMonitor", "etwConsumer", "wfpFilter", "amsiProvider"]) {
    engine[name].stop = async () => {};
  }
  engine.windowsHealth.dispose = () => {};
  engine.usbRuntime.dispose = () => {};
  engine.hardware.dispose = () => {};
  return { engine, counts: () => ({ started, stopped }) };
}

const ENV_KEYS = ["NODE_ENV", "CYBERSAFE_DEV_WINDOWS_READONLY", "CYBERSAFE_REALDEV_FIXTURE_SCAN"];

function withEnv(patch, fn) {
  const saved = ENV_KEYS.map((key) => process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, patch);
  try {
    return fn();
  } finally {
    ENV_KEYS.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
}

test("init wiring: o único startScheduler vive no método guardado chamado por initInternal", () => {
  const built = fs.readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  assert.equal(
    (built.match(/this\.updater\.startScheduler\(\)/g) ?? []).length,
    1,
    "só pode haver um caminho que liga o agendador",
  );
  assert.match(built, /this\.agendarDefinicoesSePermitido\(\);/);
  assert.match(
    built,
    /agendarDefinicoesSePermitido\(\)\s*\{\s*if \(!agendadorDefinicoesDeveArrancar\(\)\)/,
    "o método chamado por initInternal tem de consultar a guarda",
  );
});

test("guarda: test/readonly/fixture não ligam; regime normal liga uma vez", () => {
  const { engine, counts } = makeEngine();

  withEnv({ NODE_ENV: "test" }, () => {
    assert.equal(engine.agendarDefinicoesSePermitido(), false);
  });
  withEnv({ NODE_ENV: "production", CYBERSAFE_DEV_WINDOWS_READONLY: "1" }, () => {
    assert.equal(engine.agendarDefinicoesSePermitido(), false);
  });
  withEnv({ NODE_ENV: "production", CYBERSAFE_REALDEV_FIXTURE_SCAN: "1" }, () => {
    assert.equal(engine.agendarDefinicoesSePermitido(), false);
  });
  assert.equal(counts().started, 0, "nenhum modo fechado pode ter ligado o agendador");

  withEnv({ NODE_ENV: "production" }, () => {
    assert.equal(engine.agendarDefinicoesSePermitido(), true);
  });
  assert.equal(counts().started, 1);
});

test("stopProtection não para nem religa o agendador; dispose para o scheduler", async () => {
  const { engine, counts } = makeEngine();
  engine.protectionState = true;

  await engine.stopProtection();
  assert.equal(counts().stopped, 0, "parar a proteção não pode matar as definições");
  assert.equal(counts().started, 0, "parar a proteção não pode religar o agendador");

  await engine.dispose();
  assert.equal(counts().stopped, 1, "dispose tem de fechar o timer");
});
