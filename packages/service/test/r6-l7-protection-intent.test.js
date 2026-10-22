import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtectionIntentStore, decidirArranque, validarIntencao } from "../src/protection-intent.ts";

const instante = "2026-10-12T10:00:00.000Z";
const agora = Date.parse(instante);
const doc = (overrides = {}) => ({ version: 1, desired: "enabled", pausedUntil: null, updatedAt: instante, ...overrides });
async function fixture(t, io) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-r6-l7-"));
  t.after(async () => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("cybersafe-r6-l7-"));
    await fs.rm(target, { recursive: true, force: true });
  });
  const file = path.join(dir, "intent.json");
  return { dir, file, store: new ProtectionIntentStore(file, io) };
}

test("roundtrip e nova instância preservam intenção sem guardar saúde operacional", async t => {
  const { file, store } = await fixture(t);
  await store.guardar(doc(), null);
  assert.deepEqual(await new ProtectionIntentStore(file).ler(), { estado: "known", intencao: doc() });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), doc());
});

test("off manual prevalece sobre prazo expirado e relógio recuado não o ativa", () => {
  const off = doc({ desired: "disabled", pausedUntil: "2026-10-12T09:00:00.000Z" });
  assert.deepEqual(decidirArranque(off, agora), { decisao: "ficar_desligado", motivo: "off_manual" });
  assert.notEqual(decidirArranque(off, agora - 1).decisao, "arrancar");
});

test("enabled sem pausa permite arrancar; pausa futura espera; expirada retoma", () => {
  assert.deepEqual(decidirArranque(doc(), agora), { decisao: "arrancar", motivo: "intencao_enabled" });
  assert.deepEqual(decidirArranque(doc({ pausedUntil: "2026-10-12T10:01:00.000Z" }), agora), { decisao: "ficar_desligado", motivo: "pausa_em_curso" });
  assert.deepEqual(decidirArranque(doc({ pausedUntil: instante }), agora), { decisao: "retomar_pausa_expirada", motivo: "prazo_expirado" });
});

test("relógio inválido ou anterior a updatedAt exige recuperação", () => {
  for (const clock of [NaN, Infinity, agora - 1]) {
    assert.equal(decidirArranque(doc({ pausedUntil: "2026-10-12T09:00:00.000Z" }), clock).decisao, "unknown");
  }
});

test("documentos inválidos, ausentes ou legados nunca ativam silenciosamente", () => {
  for (const value of [null, undefined, {}, { ...doc(), version: 0 }, { ...doc(), version: 2 },
    doc({ desired: "active" }), doc({ pausedUntil: "ontem" }), doc({ updatedAt: "2026-02-30T10:00:00.000Z" }),
    doc({ pausedUntil: "2026-10-12" }), { ...doc(), protectionEnabled: true }, []]) {
    assert.equal(validarIntencao(value).estado, "unknown");
    assert.equal(decidirArranque(value, agora).decisao, "unknown");
  }
});

test("missing/corrupt/legacy em disco devolvem unknown sem reescrever", async t => {
  const { store, file } = await fixture(t);
  assert.deepEqual(await store.ler(), { estado: "unknown", motivo: "documento_ausente" });
  for (const [raw, motivo] of [["{", "documento_corrompido"], ['{"desired":"enabled"}', "documento_legado"]]) {
    await fs.writeFile(file, raw);
    assert.deepEqual(await store.ler(), { estado: "unknown", motivo });
    await assert.rejects(store.guardar(doc(), null), /conflito/);
    assert.equal(await fs.readFile(file, "utf8"), raw);
  }
});

test("escrita inválida é recusada antes de criar ficheiro", async t => {
  const { store, dir } = await fixture(t);
  await assert.rejects(store.guardar(doc({ pausedUntil: "inválido" }), null), /inválida/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("falha de escrita preserva documento anterior e remove só temp próprio", async t => {
  const { store, file, dir } = await fixture(t);
  await store.guardar(doc(), null);
  const failing = new ProtectionIntentStore(file, { ...fs, writeFile: async (p, data, opts) => {
    await fs.writeFile(p, data.slice(0, 10), opts);
    throw Object.assign(new Error("fixture write failed"), { code: "ENOSPC" });
  } });
  await assert.rejects(failing.guardar(doc({ desired: "disabled" }), doc()), /fixture write failed/);
  assert.deepEqual(await store.ler(), { estado: "known", intencao: doc() });
  assert.deepEqual(await fs.readdir(dir), ["intent.json"]);
});

test("rename falhado preserva last-known-good e permite tentativa seguinte", async t => {
  const { file, store, dir } = await fixture(t);
  await store.guardar(doc(), null);
  const failing = new ProtectionIntentStore(file, { ...fs, rename: async () => { throw new Error("fixture rename failed"); } });
  await assert.rejects(failing.guardar(doc({ desired: "disabled" }), doc()), /fixture rename failed/);
  assert.deepEqual(await store.ler(), { estado: "known", intencao: doc() });
  assert.deepEqual(await fs.readdir(dir), ["intent.json"]);
  await store.guardar(doc({ desired: "disabled" }), doc());
  assert.equal((await store.ler()).intencao.desired, "disabled");
});

test("temp órfão após interrupção não substitui documento confirmado", async t => {
  const { store, file } = await fixture(t);
  await store.guardar(doc(), null);
  const orphan = `${file}.interrupted.tmp`;
  await fs.writeFile(orphan, JSON.stringify(doc({ desired: "disabled" })));
  assert.deepEqual(await new ProtectionIntentStore(file).ler(), { estado: "known", intencao: doc() });
  assert.equal(await fs.readFile(orphan, "utf8"), JSON.stringify(doc({ desired: "disabled" })));
});

test("off manual confirmado impede comando de timer antigo com snapshot obsoleto", async t => {
  const { store } = await fixture(t);
  const paused = doc({ pausedUntil: "2026-10-12T10:01:00.000Z" });
  await store.guardar(paused, null);
  const off = doc({ desired: "disabled", updatedAt: "2026-10-12T10:00:01.000Z" });
  await store.guardar(off, paused);
  await assert.rejects(store.guardar(doc({ updatedAt: "2026-10-12T10:02:00.000Z" }), paused), /conflito/);
  assert.deepEqual(decidirArranque((await store.ler()).intencao, agora + 120000), { decisao: "ficar_desligado", motivo: "off_manual" });
});

test("dois comandos concorrentes em instâncias distintas não perdem update confirmado", async t => {
  const { store, file } = await fixture(t);
  await store.guardar(doc(), null);
  const other = new ProtectionIntentStore(file);
  const results = await Promise.allSettled([
    store.guardar(doc({ desired: "disabled" }), doc()),
    other.guardar(doc({ pausedUntil: "2026-10-12T11:00:00.000Z" }), doc()),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /conflito/);
  assert.equal((await other.ler()).intencao.desired, "disabled");
});

test("updatedAt recuado não substitui intenção mais recente", async t => {
  const { store } = await fixture(t);
  await store.guardar(doc(), null);
  await assert.rejects(store.guardar(doc({ updatedAt: "2026-10-12T09:59:00.000Z" }), doc()), /relógio/);
  assert.equal((await store.ler()).intencao.updatedAt, instante);
});

test("erro de leitura é unknown e não permite inicialização sobre dados inacessíveis", async t => {
  const { file } = await fixture(t);
  const io = { ...fs, readFile: async () => { throw Object.assign(new Error("fixture denied"), { code: "EACCES" }); } };
  const store = new ProtectionIntentStore(file, io);
  assert.deepEqual(await store.ler(), { estado: "unknown", motivo: "leitura_falhou" });
  await assert.rejects(store.guardar(doc(), null), /conflito/);
});

test("novo processo Node lê intenção persistida após o writer terminar", async t => {
  const { file, store } = await fixture(t);
  await store.guardar(doc({ desired: "disabled" }), null);
  const { execFileSync } = await import("node:child_process");
  const moduleUrl = new URL("../src/protection-intent.ts", import.meta.url).href;
  const code = `const {ProtectionIntentStore}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await new ProtectionIntentStore(process.argv[1]).ler()));`;
  const read = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, file], { encoding: "utf8" }));
  assert.deepEqual(read, { estado: "known", intencao: doc({ desired: "disabled" }) });
});

test("leitores só veem documento antigo até ao rename confirmar o novo", async t => {
  const { file, store } = await fixture(t);
  await store.guardar(doc(), null);
  let signalReady, releaseRename;
  const ready = new Promise(resolve => { signalReady = resolve; });
  const release = new Promise(resolve => { releaseRename = resolve; });
  const writer = new ProtectionIntentStore(file, { ...fs, rename: async (from, to) => {
    signalReady();
    await release;
    await fs.rename(from, to);
  } });
  const pending = writer.guardar(doc({ desired: "disabled" }), doc());
  try {
    await ready;
    assert.deepEqual(await store.ler(), { estado: "known", intencao: doc() });
  } finally {
    releaseRename();
    await pending;
  }
  assert.equal((await store.ler()).intencao.desired, "disabled");
});
