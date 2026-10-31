import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProtectionIntentStore,
  ProtectionStartup,
  protectionIntentPath,
} from "../src/protection-intent.ts";

const instante = "2026-10-18T10:00:00.000Z";
const agora = Date.parse(instante);
const doc = (overrides = {}) => ({
  version: 1, desired: "enabled", pausedUntil: null, updatedAt: instante, ...overrides,
});

/** BaseDir real em mkdtemp; nada de watchers, motores nem proteção verdadeira. */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-startup-"));
  t.after(async () => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("cybersafe-startup-"));
    await fs.rm(target, { recursive: true, force: true });
  });
  const file = protectionIntentPath(dir);
  const io = {
    readFile: (f, enc) => fs.readFile(f, enc),
    writeFile: (f, data, options) => fs.writeFile(f, data, options),
    rename: (a, b) => fs.rename(a, b),
    unlink: (f) => fs.unlink(f),
  };
  return { dir, file, store: new ProtectionIntentStore(file, io) };
}

/** Coordenador com arranque espionado; `iniciar` devolve o que o serviço confirmar. */
function coordinador(store, { agoraFn = () => agora, iniciado = true, rejeitar = false } = {}) {
  const chamadas = [];
  const startup = new ProtectionStartup({
    store,
    agora: agoraFn,
    iniciar: async () => {
      chamadas.push("iniciar");
      if (rejeitar) throw new Error("motor indisponível");
      return iniciado;
    },
  });
  return { startup, chamadas };
}

test("protectionIntentPath devolve um caminho absoluto dentro da baseDir", async t => {
  const { dir } = await fixture(t);
  const file = protectionIntentPath(dir);
  assert.ok(path.isAbsolute(file));
  assert.equal(path.dirname(file), dir);
  assert.equal(path.basename(file), "protection-intent.json");
});

test("documento ausente: não inicia e reporta unknown", async t => {
  const { store, file } = await fixture(t);
  const { startup, chamadas } = coordinador(store);
  const resultado = await startup.avaliarAoArrancar();
  assert.deepEqual(chamadas, [], "iniciar() não pode ser chamado sem intenção registada");
  assert.equal(resultado.iniciado, false);
  assert.equal(resultado.decisao, "unknown");
  assert.equal(resultado.motivo, "documento_ausente");
  assert.equal(await fs.stat(file).catch(() => null), null, "a ausência não pode ser materializada pelo arranque");
});

test("desired disabled ao arrancar: não inicia e devolve off_manual", async t => {
  const { store } = await fixture(t);
  await store.guardar(doc({ desired: "disabled" }), null);
  const { startup, chamadas } = coordinador(store);
  const resultado = await startup.avaliarAoArrancar();
  assert.deepEqual(chamadas, []);
  assert.equal(resultado.iniciado, false);
  assert.equal(resultado.decisao, "ficar_desligado");
  assert.equal(resultado.motivo, "off_manual");
});

test("desired enabled sem pausa: inicia exatamente uma vez", async t => {
  const { store } = await fixture(t);
  await store.guardar(doc(), null);
  const { startup, chamadas } = coordinador(store);
  const resultado = await startup.avaliarAoArrancar();
  assert.deepEqual(chamadas, ["iniciar"]);
  assert.equal(resultado.iniciado, true);
  assert.equal(resultado.decisao, "arrancar");
});

test("pausa em curso ao arrancar: não inicia", async t => {
  const { store } = await fixture(t);
  await store.guardar(doc({ pausedUntil: "2026-10-18T10:05:00.000Z" }), null);
  const { startup, chamadas } = coordinador(store);
  const resultado = await startup.avaliarAoArrancar();
  assert.deepEqual(chamadas, []);
  assert.equal(resultado.iniciado, false);
  assert.equal(resultado.motivo, "pausa_em_curso");
});

test("pausa expirada ao arrancar: retoma", async t => {
  const { store } = await fixture(t);
  await store.guardar(doc({ pausedUntil: "2026-10-18T09:00:00.000Z" }), null);
  const { startup, chamadas } = coordinador(store);
  const resultado = await startup.avaliarAoArrancar();
  assert.deepEqual(chamadas, ["iniciar"]);
  assert.equal(resultado.iniciado, true);
  assert.equal(resultado.decisao, "retomar_pausa_expirada");
});

test("relógio inválido com enabled: fail closed, não inicia", async t => {
  const { store } = await fixture(t);
  await store.guardar(doc(), null);
  const { startup, chamadas } = coordinador(store, { agoraFn: () => Number.NaN });
  const resultado = await startup.avaliarAoArrancar();
  assert.deepEqual(chamadas, []);
  assert.equal(resultado.iniciado, false);
  assert.equal(resultado.decisao, "unknown");
});

test("documento corrompido em disco: não inicia e não reescreve o ficheiro", async t => {
  const { file, store } = await fixture(t);
  await fs.writeFile(file, "{", "utf8");
  const { startup, chamadas } = coordinador(store);
  const resultado = await startup.avaliarAoArrancar();
  assert.deepEqual(chamadas, []);
  assert.equal(resultado.motivo, "documento_corrompido");
  assert.equal(await fs.readFile(file, "utf8"), "{", "o arranque não pode silenciar um registo ilegível");
});

test("avaliarAoArrancar é leitura pura: não altera o registo persistido", async t => {
  const { file, store } = await fixture(t);
  await store.guardar(doc(), null);
  const antes = await fs.readFile(file, "utf8");
  const { startup } = coordinador(store);
  await startup.avaliarAoArrancar();
  assert.equal(await fs.readFile(file, "utf8"), antes,
    "escrever intenção no arranque equivaleria a inferir consentimento do monitor.start");
});

test("iniciar() a rejeitar: iniciado false e sem exceção para fora", async t => {
  const { store } = await fixture(t);
  await store.guardar(doc(), null);
  const { startup } = coordinador(store, { rejeitar: true });
  const resultado = await startup.avaliarAoArrancar();
  assert.equal(resultado.iniciado, false);
  assert.equal(resultado.decisao, "arrancar");
  assert.equal(typeof resultado.falha, "string");
});

test("iniciar() devolve false: o serviço nega o arranque e nada é afirmado", async t => {
  const { store } = await fixture(t);
  await store.guardar(doc(), null);
  const { startup } = coordinador(store, { iniciado: false });
  const resultado = await startup.avaliarAoArrancar();
  assert.equal(resultado.iniciado, false);
});

test("definirOptin(true) grava e confirma apenas quando está em disco", async t => {
  const { file, store } = await fixture(t);
  const { startup } = coordinador(store);
  const resultado = await startup.definirOptin(true);
  assert.equal(resultado.ok, true);
  assert.equal(resultado.guardado, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).desired, "enabled");
});

test("definirOptin(false) grava disabled", async t => {
  const { file, store } = await fixture(t);
  const { startup } = coordinador(store);
  const resultado = await startup.definirOptin(false);
  assert.equal(resultado.guardado, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).desired, "disabled");
});

test("falha de escrita não pode afirmar preferência guardada", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-startup-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ioQueFalhaEscrever = {
    readFile: (f, enc) => fs.readFile(f, enc),
    writeFile: async () => { throw Object.assign(new Error("EDQUOT"), { code: "EDQUOT" }); },
    rename: (a, b) => fs.rename(a, b),
    unlink: (f) => fs.unlink(f),
  };
  const store = new ProtectionIntentStore(protectionIntentPath(dir), ioQueFalhaEscrever);
  const { startup } = coordinador(store);
  const resultado = await startup.definirOptin(true);
  assert.equal(resultado.ok, false, "sem escrita confirmada não há ok");
  assert.equal(resultado.guardado, false, "guardado:false é a única resposta honesta");
});

test("documento corrompido: definirOptin recusa sem sobrescrever", async t => {
  const { file, store } = await fixture(t);
  await fs.writeFile(file, "{", "utf8");
  const { startup } = coordinador(store);
  const resultado = await startup.definirOptin(true);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.guardado, false);
  assert.equal(await fs.readFile(file, "utf8"), "{", "não se pisa um registo ilegível à cega");
});

test("OFF manual revoga a retoma: desired fica disabled em disco", async t => {
  const { file, store } = await fixture(t);
  const { startup } = coordinador(store);
  await startup.definirOptin(true);
  const revogacao = await startup.registrarOffManual();
  assert.equal(revogacao.guardado, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).desired, "disabled");
  const { startup: relido } = coordinador(store);
  assert.equal((await relido.avaliarAoArrancar()).decisao, "ficar_desligado");
});

test("registrarPausa grava o prazo e mantém a intenção de retoma", async t => {
  const { file, store } = await fixture(t);
  const { startup } = coordinador(store);
  await startup.definirOptin(true);
  const prazo = "2026-10-18T10:30:00.000Z";
  const guardado = await startup.registrarPausa(prazo);
  assert.equal(guardado.guardado, true);
  const escrito = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(escrito.pausedUntil, prazo);
  assert.equal(escrito.desired, "enabled");
});

test("registrarPausa(null) limpa o prazo sem apagar a intenção", async t => {
  const { file, store } = await fixture(t);
  const { startup } = coordinador(store);
  await startup.definirOptin(true);
  await startup.registrarPausa("2026-10-18T10:30:00.000Z");
  await startup.registrarPausa(null);
  const escrito = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(escrito.pausedUntil, null);
  assert.equal(escrito.desired, "enabled");
});

test("estado para a UI: opt-in conhecido não afirma proteção ativa", async t => {
  const { store } = await fixture(t);
  const { startup } = coordinador(store);
  await startup.definirOptin(true);
  const estado = await startup.estado();
  assert.equal(estado.optin, "enabled");
  assert.equal(estado.registoConhecido, true);
  assert.equal(estado.protecaoAtiva, false, "estado persistido não é evidência de proteção operacional");
});

test("estado com registo ilegível: optin unknown e a UI não recebe enabled", async t => {
  const { file, store } = await fixture(t);
  await fs.writeFile(file, "{", "utf8");
  const { startup } = coordinador(store);
  const estado = await startup.estado();
  assert.equal(estado.optin, "unknown");
  assert.equal(estado.registoConhecido, false);
  assert.equal(estado.motivo, "documento_corrompido");
});

// ── OFF manual: o estado observado e a persistência são duas coisas ──────────
// Um OFF que não se consegue gravar tem de continuar a dizer `protectionEnabled:
// false` (é o que o motor observa) sem jamais afirmar que a revogação ficou em
// disco — caso contrário um `enabled` anterior sobrevive e a proteção volta a
// ligar-se sozinha no próximo arranque, contra a vontade do utilizador.

test("OFF manual com escrita saudável revoga e confirma", async t => {
  const { store } = await fixture(t);
  const { startup } = coordinador(store);
  await startup.definirOptin(true);
  const vivo = { ok: true, protectionEnabled: false };
  const resposta = await startup.ofManualConfirmado(vivo);
  assert.deepEqual({ ok: resposta.ok, protectionEnabled: resposta.protectionEnabled }, vivo,
    "o estado observado pelo motor não é reescrito pela persistência");
  assert.equal(resposta.revogacaoRetoma, "confirmada");
});

test("falha de IO no OFF manual: revogação NÃO confirmada, sem afirmar persistência", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-startup-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ioQueFalha = {
    readFile: (f, enc) => fs.readFile(f, enc),
    writeFile: async () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); },
    rename: (a, b) => fs.rename(a, b),
    unlink: (f) => fs.unlink(f),
  };
  const store = new ProtectionIntentStore(protectionIntentPath(dir), ioQueFalha);
  const { startup } = coordinador(store);
  const resposta = await startup.ofManualConfirmado({ ok: true, protectionEnabled: false });
  assert.equal(resposta.protectionEnabled, false, "o OFF aconteceu no motor");
  assert.equal(resposta.revogacaoRetoma, "nao_confirmada", "mas a revogação não pode ser dada como guardada");
  assert.equal(typeof resposta.motivoRevogacao, "string");
});

test("escrita saudável mas conteúdo ilegível: revogação não confirmada e ficheiro preservado", async t => {
  const { file, store } = await fixture(t);
  await fs.writeFile(file, "{", "utf8");
  const { startup } = coordinador(store);
  const resposta = await startup.ofManualConfirmado({ ok: true, protectionEnabled: false });
  assert.equal(resposta.revogacaoRetoma, "nao_confirmada");
  assert.equal(await fs.readFile(file, "utf8"), "{", "um registo ilegível não é pisado por um OFF");
});

test("sem registo anterior, OFF manual cria disabled e confirma", async t => {
  const { file, store } = await fixture(t);
  const { startup } = coordinador(store);
  const resposta = await startup.ofManualConfirmado({ ok: true, protectionEnabled: false });
  assert.equal(resposta.revogacaoRetoma, "confirmada");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).desired, "disabled");
});
