import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyClamavHealth } from "../dist/clamav.js";
import { YaraEngine } from "../dist/yara.js";
import { YARA_BINARY_ENV } from "../dist/yara-classic.js";
import { batterySourceFor } from "../dist/hardware.js";
import { engineContextCopy, engineUserSummary, plausibleBatteryMinutes } from "@cybersafe/shared-types";

/**
 * Estados Linux dos motores e da bateria (UX Linux, 14/11).
 * «Não instalado» não é «Erro crítico»; o ENOENT bruto não chega à frase
 * principal; a estimativa de bateria absurda não é publicada.
 */

const semMotor = { versionOutput: null, dbDir: null, dbFiles: null };

test("ClamAV ausente (ENOENT) → unavailable + not-installed, frase curta sem ENOENT", () => {
  const { health } = classifyClamavHealth({ ...semMotor, versionError: "spawn clamscan ENOENT" });
  assert.equal(health.status, "unavailable");
  assert.equal(health.reason, "not-installed");
  assert.match(health.detail, /ENOENT/, "o detalhe técnico mantém-se para o diagnóstico");
  const copy = engineContextCopy("clamav", health);
  assert.equal(copy.estado, "Não instalado");
  assert.equal(copy.texto, "ClamAV não instalado neste sistema.");
  assert.doesNotMatch(`${copy.texto} ${copy.contexto ?? ""}`, /ENOENT|spawn|clamscan/);
  assert.equal(engineUserSummary("clamav", health), "ClamAV não instalado");
});

test("ClamAV que existe mas falha a executar (EACCES) → erro ao executar, não «não instalado»", () => {
  const { health } = classifyClamavHealth({ ...semMotor, versionError: "spawn clamscan EACCES" });
  assert.equal(health.reason, "exec-failed");
  assert.equal(engineContextCopy("clamav", health).estado, "Erro ao executar");
});

test("binário Windows recusado em Linux conta como ClamAV (Linux) não instalado", () => {
  const { health } = classifyClamavHealth({
    ...semMotor,
    binarioRecusado: [{ nome: "clamscan.exe", motivo: "é um executável Windows (.exe)" }],
  });
  assert.equal(health.reason, "not-installed");
});

test("YARA sem binários POSIX → unavailable/not-installed e o corpus do utilizador não é reescrito", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-yara-linux-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-yara-bin-vazio-"));
  const rules = path.join(dir, "yara", "default.yar");
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  const corpus = 'rule utilizador { strings: $a = "CYBERSAFE-NEEDLE-LINUX" condition: $a }\n';
  fs.writeFileSync(rules, corpus);
  const anterior = process.env[YARA_BINARY_ENV];
  process.env[YARA_BINARY_ENV] = binDir; // override autoritativo: diretório sem motor
  try {
    const engine = new YaraEngine();
    await engine.load(rules);
    assert.equal(engine.health.status, "unavailable", "não instalado nunca é `error` (Erro crítico)");
    assert.equal(engine.health.reason, "not-installed");
    assert.equal(engine.isAvailable, false);
    assert.equal(fs.readFileSync(rules, "utf8"), corpus, "a falta do binário não pode reescrever as regras");
    assert.equal(engineContextCopy("yara", engine.health).estado, "Não instalado");
  } finally {
    if (anterior === undefined) delete process.env[YARA_BINARY_ENV];
    else process.env[YARA_BINARY_ENV] = anterior;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("origem da bateria: Linux nomeia o kernel; fora de Linux o valor histórico mantém-se", () => {
  assert.equal(batterySourceFor("linux"), "linux:sysfs-power_supply");
  assert.equal(batterySourceFor("win32"), "systeminformation");
});

test("estimativa de bateria: 216 h, zero e incoerências → null; valores normais passam", () => {
  assert.equal(plausibleBatteryMinutes({ minutes: 216 * 60, percent: 80 }), null);
  assert.equal(plausibleBatteryMinutes({ minutes: 0, percent: 80 }), null);
  assert.equal(plausibleBatteryMinutes({ minutes: Number.NaN, percent: 80 }), null);
  assert.equal(plausibleBatteryMinutes({ minutes: 600, percent: 10 }), null, "10 h com 10 % é incoerente");
  assert.equal(plausibleBatteryMinutes({ minutes: 125, percent: 60, isCharging: true }), null);
  assert.equal(plausibleBatteryMinutes({ minutes: 125, percent: 60 }), 125);
});
