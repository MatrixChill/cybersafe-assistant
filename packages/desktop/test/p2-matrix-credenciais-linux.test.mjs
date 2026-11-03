import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  classificaMecanismoCredenciais,
  mecanismoPermiteCifra,
} from "../src/mecanismo-credenciais.ts";
import {
  createAiCredentialsStore,
  RecusaArmazenamento,
} from "../src/ai-credentials-store.ts";
import { registerAiCredentialsIpc } from "../src/ai-credentials-ipc.ts";

const secret = "synthetic-fixture-not-a-provider-key";
const aes = randomBytes(32);

/** O mesmo cifrador do ag36: o que importa aqui é o MECANISMO declarado. */
const cifra = (backend) => ({
  isEncryptionAvailable: () => true,
  ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
  encryptString(texto) {
    const iv = randomBytes(12);
    const cifrador = createCipheriv("aes-256-gcm", aes, iv);
    const dados = Buffer.concat([cifrador.update(texto), cifrador.final()]);
    return Buffer.concat([iv, cifrador.getAuthTag(), dados]);
  },
  decryptString(dados) {
    const decifrador = createDecipheriv("aes-256-gcm", aes, dados.subarray(0, 12));
    decifrador.setAuthTag(dados.subarray(12, 28));
    return Buffer.concat([decifrador.update(dados.subarray(28)), decifrador.final()]).toString();
  },
});

function pasta(t, prefixo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** `assert.throws` não devolve o erro; sem capturar, o código do erro fica invisível. */
function lanca(fn) {
  let erro = null;
  try {
    fn();
  } catch (causa) {
    erro = causa;
  }
  assert.ok(erro instanceof RecusaArmazenamento, `esperava RecusaArmazenamento, obtive ${String(erro)}`);
  return erro;
}

test("Windows e macOS afirmam o seu mecanismo; Linux precisa de nomear o backend", () => {
  assert.equal(
    classificaMecanismoCredenciais({ plataforma: "win32", cifradoDisponivel: true }).rotulo,
    "DPAPI (Windows)",
  );
  assert.equal(
    classificaMecanismoCredenciais({ plataforma: "darwin", cifradoDisponivel: true }).nivel,
    "seguro",
  );
  // O `basic_text` está disponível, mas cifra com chave fixa do código.
  const basico = classificaMecanismoCredenciais({
    plataforma: "linux", cifradoDisponivel: true, backend: "basic_text",
  });
  assert.equal(basico.nivel, "nao-seguro");
  assert.match(basico.rotulo, /basic_text/);
  assert.ok(basico.remedio, "tem de dizer o remédio");
  assert.equal(
    classificaMecanismoCredenciais({ plataforma: "linux", cifradoDisponivel: true, backend: "gnome_libsecret" }).nivel,
    "seguro",
  );
  assert.equal(
    classificaMecanismoCredenciais({ plataforma: "linux", cifradoDisponivel: true, backend: "kwallet6" }).rotulo,
    "KWallet 6",
  );
  // Disponível mas sem backend reconhecido (chamada antes do ready) não é prova.
  assert.equal(
    classificaMecanismoCredenciais({ plataforma: "linux", cifradoDisponivel: true, backend: "unknown" }).nivel,
    "desconhecido",
  );
  assert.equal(
    classificaMecanismoCredenciais({ plataforma: "linux", cifradoDisponivel: true }).nivel,
    "desconhecido",
    "API ausente não autoriza a afirmação «cifrada»",
  );
  assert.equal(
    classificaMecanismoCredenciais({ plataforma: "linux", cifradoDisponivel: false }).rotulo,
    "sem mecanismo seguro de armazenamento",
  );
  assert.equal(mecanismoPermiteCifra(classificaMecanismoCredenciais({ plataforma: "linux", cifradoDisponivel: true })), false);
});

test("Linux sem keyring recusa a cifra e não escreve nada em disco", (t) => {
  const dir = pasta(t, "cs-p2-creds-basic-");
  const store = createAiCredentialsStore(dir, cifra("basic_text"), { plataforma: "linux" });
  const erro = lanca(() => store.writeKey(secret, "groq"));
  assert.equal(erro.codigo, "mecanismo-insuficiente");
  assert.match(erro.message, /Sem mecanismo seguro de armazenamento/);
  assert.match(erro.message, /basic_text/, "diz qual o mecanismo, não uma falha genérica");
  assert.equal(fs.existsSync(path.join(dir, "secrets")), false, "recusa antes de tocar no disco");
});

test("Linux com keyring usa a cifra e o estado diz «cifrado»", (t) => {
  const dir = pasta(t, "cs-p2-creds-libsecret-");
  const store = createAiCredentialsStore(dir, cifra("gnome_libsecret"), { plataforma: "linux" });
  store.writeKey(secret, "openai");
  const activo = path.join(dir, "secrets", "ai-credentials.bin");
  assert.ok(fs.existsSync(activo));
  assert.equal(fs.readFileSync(activo).includes(secret), false, "o ficheiro cifrado não contém a chave");
  const estado = createAiCredentialsStore(dir, cifra("gnome_libsecret"), { plataforma: "linux" }).estado();
  assert.deepEqual(
    { hasKey: estado.hasKey, provider: estado.provider, origem: estado.origem, nivel: estado.mecanismo.nivel },
    { hasKey: true, provider: "openai", origem: "cifrado", nivel: "seguro" },
  );
});

test("a guarda local exige consentimento e nunca acontece com mecanismo seguro", (t) => {
  const dir = pasta(t, "cs-p2-creds-consent-");
  const semCifra = createAiCredentialsStore(dir, cifra("basic_text"), { plataforma: "linux" });
  const semConsentimento = lanca(() => semCifra.writeKeyLocalProtegido(secret, "groq", false));
  assert.equal(semConsentimento.codigo, "sem-consentimento");
  assert.equal(fs.existsSync(path.join(dir, "secrets")), false);

  const comKeyring = createAiCredentialsStore(dir, cifra("kwallet5"), { plataforma: "linux" });
  const recusado = lanca(() => comKeyring.writeKeyLocalProtegido(secret, "groq", true));
  assert.equal(recusado.codigo, "cifra-segura-disponivel", "não se desce para texto puro quando há cifra");
  assert.equal(fs.existsSync(path.join(dir, "secrets", "ai-credentials.local")), false);
});

test("a guarda local consentida fica 0600, sobrevive ao reinício e é declarada sem cifra", (t) => {
  const dir = pasta(t, "cs-p2-creds-local-");
  const store = createAiCredentialsStore(dir, cifra("basic_text"), { plataforma: "linux" });
  store.writeKeyLocalProtegido(secret, "openai", true);
  const local = path.join(dir, "secrets", "ai-credentials.local");
  assert.ok(fs.existsSync(local));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(local).mode & 0o777, 0o600, "só o utilizador lê a chave em texto puro");
    assert.equal(fs.statSync(path.join(dir, "secrets")).mode & 0o777, 0o700);
  }
  const relido = createAiCredentialsStore(dir, cifra("basic_text"), { plataforma: "linux" });
  assert.equal(relido.readKey(), secret);
  const estado = relido.estado();
  assert.equal(estado.origem, "local-protegido");
  assert.equal(estado.mecanismo.nivel, "nao-seguro", "o estado continua a dizer que não está cifrado");
  assert.equal(fs.readFileSync(local, "utf8").includes(secret), true, "é mesmo texto puro — o ecrã não pode chamar-lhe cifra");
});

test("cifra e ficheiro local coexistem: a cifra ganha e o clear remove os dois", (t) => {
  const dir = pasta(t, "cs-p2-creds-dup-");
  createAiCredentialsStore(dir, cifra("basic_text"), { plataforma: "linux" })
    .writeKeyLocalProtegido(secret, "groq", true);
  createAiCredentialsStore(dir, cifra("gnome_libsecret"), { plataforma: "linux" })
    .writeKey("outra-chave-sintetica-1234", "openai");
  const guardado = createAiCredentialsStore(dir, cifra("gnome_libsecret"), { plataforma: "linux" });
  assert.equal(guardado.readKey(), "outra-chave-sintetica-1234");
  assert.equal(guardado.estado().origem, "cifrado");
  guardado.clear();
  assert.equal(fs.existsSync(path.join(dir, "secrets", "ai-credentials.bin")), false);
  assert.equal(fs.existsSync(path.join(dir, "secrets", "ai-credentials.local")), false);
});

test("IPC: o estado publica o mecanismo e a recusa diz porquê, sem chave", async (t) => {
  const dir = pasta(t, "cs-p2-creds-ipc-");
  const store = createAiCredentialsStore(dir, cifra("basic_text"), { plataforma: "linux" });
  const handlers = new Map();
  registerAiCredentialsIpc((canal, listener) => handlers.set(canal, listener), () => store, async () => true);

  const estado = handlers.get("ai-credentials:get-status")();
  assert.equal(estado.mecanismo.nivel, "nao-seguro");
  assert.equal(estado.origem, null);
  assert.equal(estado.state, "unverified");

  const recusado = await handlers.get("ai-credentials:save")({}, secret, "groq", false);
  assert.equal(recusado.ok, false);
  assert.equal(recusado.codigo, "mecanismo-insuficiente");
  assert.match(recusado.error, /Sem mecanismo seguro/);
  assert.equal(JSON.stringify(recusado).includes(secret), false, "a resposta nunca ecoa a chave");
  assert.equal(fs.existsSync(path.join(dir, "secrets")), false);

  const guardado = await handlers.get("ai-credentials:save")({}, secret, "groq", true);
  assert.equal(guardado.ok, true);
  assert.equal(guardado.origem, "local-protegido");
  assert.equal(guardado.mecanismo.nivel, "nao-seguro");
  assert.equal(JSON.stringify(guardado).includes(secret), false);
});

test("IPC em Windows: a chave cifrada continua a ir pelo caminho de cifra", async (t) => {
  const dir = pasta(t, "cs-p2-creds-ipc-win-");
  const store = createAiCredentialsStore(dir, cifra(), { plataforma: "win32" });
  const handlers = new Map();
  registerAiCredentialsIpc((canal, listener) => handlers.set(canal, listener), () => store, async () => true);
  const guardado = await handlers.get("ai-credentials:save")({}, secret, "groq", true);
  assert.equal(guardado.ok, true);
  assert.equal(guardado.origem, "cifrado", "o consentimento não desce o Windows para texto puro");
  assert.equal(guardado.mecanismo.rotulo, "DPAPI (Windows)");
  assert.ok(fs.existsSync(path.join(dir, "secrets", "ai-credentials.bin")));
  assert.equal(fs.existsSync(path.join(dir, "secrets", "ai-credentials.local")), false);
});
