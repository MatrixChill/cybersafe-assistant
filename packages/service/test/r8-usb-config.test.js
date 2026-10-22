/**
 * R8 — OPT-IN PERSISTENTE DA PROTECAO USB (service).
 *
 * Contrato (R8-USB-CONTRACT-CODEX-2026-10-12.md):
 *  - `UsbProtectionConfig { version: 1, enabled, updatedAt }` gravado
 *    ATOMICAMENTE no baseDir do servico.
 *  - Ficheiro ausente/corrompido/invalido = DISABLED com motivo.
 *    NUNCA auto-enable.
 *  - A opcao `enabled` e o estado operacional do monitor sao eixos
 *    SEPARADOS (o monitor tem o seu proprio status).
 *
 * Uso: node --test packages/service/test/r8-usb-config.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { UsbConfigStore, validarConfigUsb } from "../src/usb-protection.ts";

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-usb-config-"));
  return { dir, file: path.join(dir, "usb-protection.json") };
}

function config(overrides = {}) {
  return {
    version: 1,
    enabled: true,
    updatedAt: "2026-10-13T07:00:00.000Z",
    ...overrides,
  };
}

test("validarConfigUsb: documento completo e valido e' aceite", () => {
  const leitura = validarConfigUsb(config());
  assert.equal(leitura.estado, "known");
  assert.deepEqual(leitura.config, config());
});

test("validarConfigUsb: ausente/corrompido/invalido NUNCA vira enabled", () => {
  for (const [entrada, motivo] of [
    [null, "documento_ausente"],
    [undefined, "documento_ausente"],
    [{ version: 1, enabled: true }, "documento_invalido"],
    [{ version: 1, enabled: "true", updatedAt: "2026-10-13T07:00:00.000Z" }, "documento_invalido"],
    [{ version: 2, enabled: true, updatedAt: "2026-10-13T07:00:00.000Z" }, "versao_desconhecida"],
    [{ version: 1, enabled: true, updatedAt: "2026-10-13 07:00" }, "documento_invalido"],
    [42, "documento_invalido"],
    [[], "documento_invalido"],
    [{ version: 1, enabled: true, updatedAt: "2026-10-13T07:00:00.000Z", extra: 1 }, "documento_invalido"],
  ]) {
    const leitura = validarConfigUsb(entrada);
    assert.equal(leitura.estado, "unknown", `entrada ${JSON.stringify(entrada)}`);
    assert.equal(leitura.motivo, motivo);
    assert.equal(leitura.enabled, false, "ausencia de config significa DESLIGADO");
  }
});

test("store: ficheiro ausente = disabled com motivo documento_ausente", async () => {
  const { file } = await tempStore();
  const leitura = await new UsbConfigStore(file).ler();
  assert.equal(leitura.estado, "unknown");
  assert.equal(leitura.motivo, "documento_ausente");
  assert.equal(leitura.enabled, false);
  assert.equal(await fs.readFile(file, "utf8").catch(() => null), null, "ler nunca cria ficheiro");
});

test("store: JSON corrompido = disabled com motivo, sem auto-enable", async () => {
  const { file } = await tempStore();
  await fs.writeFile(file, "{ isto nao e json", "utf8");
  const leitura = await new UsbConfigStore(file).ler();
  assert.equal(leitura.estado, "unknown");
  assert.equal(leitura.motivo, "documento_corrompido");
  assert.equal(leitura.enabled, false);
});

test("store: grava e relê o opt-in (enable e disable)", async () => {
  const { file } = await tempStore();
  const store = new UsbConfigStore(file);
  await store.guardar(config({ enabled: true }), null);
  let leitura = await store.ler();
  assert.equal(leitura.estado, "known");
  assert.equal(leitura.config.enabled, true);

  const desligado = config({ enabled: false, updatedAt: "2026-10-13T08:00:00.000Z" });
  await store.guardar(desligado, leitura.config);
  leitura = await store.ler();
  assert.equal(leitura.config.enabled, false);
  assert.equal(leitura.config.updatedAt, "2026-10-13T08:00:00.000Z");
});

test("store: escrita e' atomica (temp + rename; nunca ficheiro truncado a meio)", async () => {
  const { file } = await tempStore();
  const store = new UsbConfigStore(file);
  await store.guardar(config(), null);
  const dir = path.dirname(file);
  const restos = (await fs.readdir(dir)).filter((nome) => nome !== path.basename(file));
  assert.deepEqual(restos, [], `nao podem ficar ficheiros temporarios: ${restos.join(", ")}`);
  const conteudo = await fs.readFile(file, "utf8");
  assert.equal(conteudo, `${JSON.stringify(config())}\n`);
});

test("store: recusa enabled nao booleano sem escrever nada", async () => {
  const { file } = await tempStore();
  const store = new UsbConfigStore(file);
  await assert.rejects(() => store.guardar({ version: 1, enabled: "sim", updatedAt: config().updatedAt }, null));
  assert.equal(await fs.readFile(file, "utf8").catch(() => null), null);
});

test("store: CAS — escrever com expectativa errada falha e nao altera o ficheiro", async () => {
  const { file } = await tempStore();
  const store = new UsbConfigStore(file);
  await store.guardar(config({ enabled: false }), null);
  await assert.rejects(
    () => store.guardar(config({ enabled: true, updatedAt: "2026-10-13T09:00:00.000Z" }), config({ enabled: false, updatedAt: "2026-10-13T06:00:00.000Z" })),
    /conflito/,
  );
  const leitura = await store.ler();
  assert.equal(leitura.config.enabled, false);
});

test("store: relogio recuado e' recusado (a opcao nao viaja no tempo)", async () => {
  const { file } = await tempStore();
  const store = new UsbConfigStore(file);
  await store.guardar(config({ updatedAt: "2026-10-13T10:00:00.000Z" }), null);
  await assert.rejects(
    () => store.guardar(config({ enabled: false, updatedAt: "2026-10-13T09:00:00.000Z" }), config({ updatedAt: "2026-10-13T10:00:00.000Z" })),
    /recuado|conflito/,
  );
});

test("store: escritas concorrentes com a mesma expectativa — uma vence, a outra falha", async () => {
  const { file } = await tempStore();
  const store = new UsbConfigStore(file);
  const resultados = await Promise.allSettled([
    store.guardar(config({ enabled: true, updatedAt: "2026-10-13T07:00:00.000Z" }), null),
    store.guardar(config({ enabled: false, updatedAt: "2026-10-13T07:00:01.000Z" }), null),
  ]);

  const vencedoras = resultados.filter((r) => r.status === "fulfilled");
  const perdedoras = resultados.filter((r) => r.status === "rejected");
  assert.equal(vencedoras.length, 1, "exactamente uma escrita concorrente pode vencer");
  assert.equal(perdedoras.length, 1, "a segunda tem de ser recusada, nao sobrescrever");
  assert.match(perdedoras[0].reason.message, /conflito/);

  const leitura = await store.ler();
  assert.equal(leitura.estado, "known", "o documento final fica valido (nunca a meio de duas escritas)");
  const restos = (await fs.readdir(path.dirname(file))).filter((nome) => nome !== path.basename(file));
  assert.deepEqual(restos, [], `sem temporarios orfaos: ${restos.join(", ")}`);
});

test("store: caminho tem de ser absoluto", async () => {
  assert.throws(() => new UsbConfigStore(path.join("relativo", "usb.json")), /absoluto/);
});
