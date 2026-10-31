/**
 * TP-RETOMA-01 — frescura de definições POR COMPONENTE.
 *
 * Causa medida em 2026-10-29: `.update-meta.json` era global, escrito quando
 * qualquer componente actualizava. Um YARA que respondesse renovava a data e
 * impedia o freshclam de voltar a tentar durante 6 h; a base ficou com 10 dias
 * e o ClamAV passou a `degraded` apesar de carregar 3.628.169 assinaturas.
 *
 * Este teste prova as propriedades que fecham a causa: um ClamAV velho corre
 * mesmo com YARA/hashes frescos; uma falha do freshclam NÃO renova a prova; a
 * migração de um metadado legado não herda frescura para o ClamAV; e `force`
 * continua a significar os três.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefinitionUpdater, agendadorDefinicoesDeveArrancar } from "../dist/updater.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cs-retoma01-test-"));
const HOUR = 60 * 60 * 1000;
const now = Date.now();

function writeMeta(defs, components) {
  fs.mkdirSync(defs, { recursive: true });
  fs.writeFileSync(
    path.join(defs, ".update-meta.json"),
    JSON.stringify({ timestamp: Math.max(...Object.values(components)), iso: new Date().toISOString(), components }, null, 2),
    "utf8",
  );
}

function writeLegacyMeta(defs, timestamp) {
  fs.mkdirSync(defs, { recursive: true });
  fs.writeFileSync(
    path.join(defs, ".update-meta.json"),
    JSON.stringify({ timestamp, iso: new Date(timestamp).toISOString() }, null, 2),
    "utf8",
  );
}

function readMeta(defs) {
  return JSON.parse(fs.readFileSync(path.join(defs, ".update-meta.json"), "utf8"));
}

function makeUpdater(defs, exitCode = 0) {
  const spawnCalls = [];
  const spawnFreshclam = () => {
    spawnCalls.push(true);
    const child = new EventEmitter();
    child.pid = 41000 + spawnCalls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => child.emit("close", exitCode, null), 5);
    return child;
  };
  const network = { yara: 0, hashes: 0 };
  const updater = new DefinitionUpdater(defs, { spawnFreshclam });
  updater.updateYaraRules = async () => {
    network.yara += 1;
    return { errors: [], warnings: [] };
  };
  updater.updateHashFeed = async () => {
    network.hashes += 1;
  };
  return { updater, network, spawnCalls };
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test("um ClamAV velho é actualizado mesmo com YARA/hashes frescos", async () => {
  const defs = path.join(ROOT, "so-clamav");
  writeMeta(defs, { yara: now - HOUR, hashes: now - HOUR, clamav: now - 10 * 24 * HOUR });
  const { updater, network, spawnCalls } = makeUpdater(defs);

  const result = await updater.checkAndUpdate(false);

  assert.equal(network.yara, 0, "YARA fresco não pode ser re-descarregado");
  assert.equal(network.hashes, 0, "HashDB fresco não pode ser re-descarregado");
  assert.equal(spawnCalls.length, 1, "freshclam tinha de correr exactamente uma vez");
  assert.equal(result.clamUpdated, true);
  assert.equal(result.yaraUpdated, false);
  assert.equal(result.hashesUpdated, false);
  const meta = readMeta(defs);
  assert.ok(meta.components.clamav > now - HOUR);
  assert.equal(meta.components.yara, now - HOUR);
  assert.equal(meta.components.hashes, now - HOUR);
});

test("tudo fresco não faz rede nem freshclam", async () => {
  const defs = path.join(ROOT, "tudo-fresco");
  writeMeta(defs, { yara: now - HOUR, hashes: now - HOUR, clamav: now - HOUR });
  const { updater, network, spawnCalls } = makeUpdater(defs);

  const result = await updater.checkAndUpdate(false);

  assert.equal(network.yara + network.hashes + spawnCalls.length, 0);
  assert.equal(result.yaraUpdated || result.clamUpdated || result.hashesUpdated, false);
});

test("freshclam que falha NÃO renova a prova e é tentado outra vez", async () => {
  const defs = path.join(ROOT, "falha");
  writeMeta(defs, { yara: now - HOUR, hashes: now - HOUR, clamav: now - 10 * 24 * HOUR });
  const { updater, spawnCalls } = makeUpdater(defs, 1);

  const primeira = await updater.checkAndUpdate(false);
  assert.equal(primeira.clamUpdated, false);
  assert.ok(primeira.errors.some((e) => e.startsWith("ClamAV:")));
  assert.equal(readMeta(defs).components.clamav, now - 10 * 24 * HOUR, "falha não é frescura");

  const segunda = await updater.checkAndUpdate(false);
  assert.equal(segunda.clamUpdated, false);
  assert.equal(spawnCalls.length, 2, "sem prova de sucesso o ciclo seguinte volta a tentar");
});

test("falha sem prova própria NÃO herda o timestamp global de outro componente", async () => {
  const defs = path.join(ROOT, "falha-sem-prova");
  // Metadado já migrado: YARA/hashes frescos, ClamAV sem entrada nenhuma.
  writeMeta(defs, { yara: now - HOUR, hashes: now - HOUR });
  const { updater, spawnCalls } = makeUpdater(defs, 1);

  const primeira = await updater.checkAndUpdate(false);
  assert.equal(primeira.clamUpdated, false);
  assert.equal(spawnCalls.length, 1, "a ausência de prova do ClamAV é velhice, não frescura global");

  const segunda = await updater.checkAndUpdate(false);
  assert.equal(segunda.clamUpdated, false);
  assert.equal(spawnCalls.length, 2, "o global de YARA não pode adiar o ClamAV");
  assert.equal(readMeta(defs).components.clamav, undefined, "falha continua sem prova");
});

test("migração de metadado legado tenta o ClamAV já; YARA/hashes herdam o global", async () => {
  const defs = path.join(ROOT, "migracao");
  writeLegacyMeta(defs, now - HOUR);
  const { updater, network, spawnCalls } = makeUpdater(defs);

  const result = await updater.checkAndUpdate(false);

  assert.equal(network.yara, 0, "YARA legado fresco pode herdar o global uma vez");
  assert.equal(network.hashes, 0, "Hashes legados frescos podem herdar o global uma vez");
  assert.equal(spawnCalls.length, 1, "o global legado não é prova de frescura do ClamAV");
  assert.equal(result.clamUpdated, true);
  assert.ok(readMeta(defs).components.clamav > now - HOUR);
});

test("force continua a ser os três componentes", async () => {
  const defs = path.join(ROOT, "force");
  writeMeta(defs, { yara: now - HOUR, hashes: now - HOUR, clamav: now - HOUR });
  const { updater, network, spawnCalls } = makeUpdater(defs);

  const result = await updater.checkAndUpdate(true);

  assert.equal(network.yara, 1);
  assert.equal(network.hashes, 1);
  assert.equal(spawnCalls.length, 1);
  assert.equal(result.yaraUpdated && result.clamUpdated && result.hashesUpdated, true);
});

test("stopScheduler fecha o timer e aborta; o ciclo já não faz rede nem freshclam", async () => {
  const defs = path.join(ROOT, "abort");
  const { updater, spawnCalls } = makeUpdater(defs);
  updater.checkAndUpdate = async () => ({ yaraUpdated: false, clamUpdated: false, hashesUpdated: false, errors: [], warnings: [], timestamp: "" });

  updater.startScheduler();
  assert.ok(updater.timer, "o timer tem de existir enquanto o scheduler está vivo");
  updater.stopScheduler();
  assert.equal(updater.timer, null, "dispose/stop tem de fechar o timer");

  const depois = await updater.checkAndUpdate(true);
  assert.equal(spawnCalls.length, 0, "depois do abort nenhum freshclam pode nascer");
  assert.equal(depois.yaraUpdated || depois.clamUpdated || depois.hashesUpdated, false);
});

test("agendador: readonly, fixture e test não arrancam; regime normal arranca", () => {
  const normal = { NODE_ENV: "production" };
  assert.equal(agendadorDefinicoesDeveArrancar(normal), true);
  assert.equal(agendadorDefinicoesDeveArrancar({ ...normal, CYBERSAFE_DEV_WINDOWS_READONLY: "1" }), false);
  assert.equal(agendadorDefinicoesDeveArrancar({ ...normal, CYBERSAFE_REALDEV_FIXTURE_SCAN: "1" }), false);
  assert.equal(agendadorDefinicoesDeveArrancar({ ...normal, NODE_ENV: "test" }), false);
});
