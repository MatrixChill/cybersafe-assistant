/**
 * R8 — HANDLERS USB INTEGRADOS NO ENGINE (`usb.getState` / `usb.configure`).
 *
 * Prova que a integração no servico existe e e' honesta, sem subir o pipe:
 *  - `usb.getState` devolve o snapshot real (desligado por omissão);
 *  - `usb.configure` grava o opt-in no baseDir (version 1) e o estado
 *    seguinte reflecte-o;
 *  - a preferência NAO toca na proteção/firewall (`protection.getState`
 *    mantém-se desligado);
 *  - validação estrita no servico: payload inválido (incluindo com caminhos)
 *    é recusado e NADA é gravado;
 *  - durante o encerramento o opt-in é recusado (nada de trabalho novo),
 *    mas a LEITURA continua a responder.
 *
 * O poll nativo (PowerShell/CIM) não arranca em teste — é por isso que o
 * `monitorStatus` fica em `starting` sem `init()`.
 *
 * Uso: node --test packages/service/test/r8-usb-engine-handlers.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProtectionEngineService } from "../dist/engine.js";

/** Raiz de dados INJETADA (nunca o home real do utilizador). */
function baseTemporaria(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "cybersafe-r8-usb-handlers-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

const ficheiroConfig = (base) => path.join(base, "usb-protection.json");
const lerConfig = (base) => fs.readFile(ficheiroConfig(base), "utf8").catch(() => null);

test("usb.getState devolve o estado real, desligado por omissão (sem opt-in)", async (t) => {
  const base = baseTemporaria(t);
  const engine = new ProtectionEngineService(base);

  const snapshot = await engine.dispatch("usb.getState", undefined);

  assert.equal(snapshot.enabled, false, "a proteção USB nasce desligada");
  assert.equal(snapshot.monitorStatus, "starting", "sem arranque do runtime não há poll nenhum");
  assert.deepEqual(snapshot.devices, []);
  assert.equal(typeof snapshot.updatedAt, "string");
  assert.equal(await lerConfig(base), null, "ler o estado nunca cria configuração");
});

test("usb.configure grava atomicamente no baseDir e não toca na proteção", async (t) => {
  const base = baseTemporaria(t);
  const engine = new ProtectionEngineService(base);

  const ligado = await engine.dispatch("usb.configure", { enabled: true });
  assert.equal(ligado.enabled, true);

  const guardado = JSON.parse(await lerConfig(base));
  assert.deepEqual(Object.keys(guardado).sort(), ["enabled", "updatedAt", "version"]);
  assert.equal(guardado.version, 1);
  assert.equal(guardado.enabled, true);

  assert.equal((await engine.dispatch("usb.getState", undefined)).enabled, true);
  const protecao = await engine.dispatch("protection.getState", undefined);
  assert.equal(protecao.protectionEnabled, false, "a preferência USB não liga a proteção nem o firewall");

  const desligado = await engine.dispatch("usb.configure", { enabled: false });
  assert.equal(desligado.enabled, false);
  assert.equal(JSON.parse(await lerConfig(base)).enabled, false);
});

test("usb.configure valida estritamente: payload inválido não grava nada", async (t) => {
  const base = baseTemporaria(t);
  const engine = new ProtectionEngineService(base);

  for (const payload of [
    { enabled: "sim" },
    { enabled: 1 },
    {},
    { rootPath: "E:\\" },
    { enabled: true, rootPath: "E:\\" },
    { enabled: true, targetPath: "E:\\" },
    [],
    null,
    "sim",
  ]) {
    await assert.rejects(
      () => engine.dispatch("usb.configure", payload),
      /boolean|obrigatório|único campo/i,
      `payload ${JSON.stringify(payload)} devia ser recusado`,
    );
  }
  assert.equal(await lerConfig(base), null, "input inválido nunca escreve configuração");
});

test("durante o encerramento o opt-in é recusado e a leitura continua a responder", async (t) => {
  const base = baseTemporaria(t);
  const engine = new ProtectionEngineService(base);
  engine.isShuttingDown = true;

  await assert.rejects(() => engine.dispatch("usb.configure", { enabled: true }), /a encerrar/i);
  assert.equal(await lerConfig(base), null);

  const snapshot = await engine.dispatch("usb.getState", undefined);
  assert.equal(snapshot.enabled, false, "a leitura não cria trabalho novo e continua a responder");
});
