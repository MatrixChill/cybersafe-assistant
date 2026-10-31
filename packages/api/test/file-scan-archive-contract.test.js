import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

/**
 * Contrato de recusa do /api/file-scan (R4).
 *
 * O defeito reproduzido na revisão: uma entrada ZIP com 409 601 bytes
 * declarados caía no catch genérico e devolvia 500 + "Failed to scan file" +
 * "Error ARCHIVE_ENTRY_LIMIT". Um limite é uma recusa previsível, não uma
 * avaria. Aqui exercita-se a ROTA REAL (app Express exportada, listener
 * efémero em loopback, DB sintética) e o classificador que a rota usa.
 *
 * Nada de ZIP bombs: as fixtures são pequenas e os limites usam tamanhos
 * declarados. Nenhum servidor global, provider, rede externa ou DB pessoal.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-r4-file-scan-"));
process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = tmpDir;
process.env.CYBERSAFE_API_PORT = "4192";
process.env.CYBERSAFE_DB_PATH = path.join(tmpDir, "cybersafe.db");
process.env.CYBERSAFE_API_NO_LISTEN = "1";
process.env.JWT_SECRET = `r4-fixture-${Math.random().toString(36).slice(2)}${Date.now()}`;
delete process.env.CYBERSAFE_API_ALLOWED_ORIGINS;
delete process.env.CYBERSAFE_API_ALLOW_NULL_ORIGIN;

const { app, fileScanFailure } = await import("../dist/index.js");
const { closeDb } = await import("../dist/db.js");
const { ARCHIVE_MAX_ENTRY_BYTES } = await import("@cybersafe/core/dist/archive-limits.js");

let server;
let baseUrl;
let token;

const zipBuffer = (entries) => {
  const zip = new AdmZip();
  for (const [name, data] of entries) zip.addFile(name, data);
  return zip.toBuffer();
};

/** Conteúdo incompressível: prova que o limite vem do tamanho declarado, não da rácio. */
function incompressible(bytes) {
  const data = Buffer.alloc(bytes);
  let state = 123456789;
  for (let i = 0; i < bytes; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    data[i] = state >>> 24;
  }
  return data;
}

async function upload(buffer, name = "fixture.zip") {
  const form = new FormData();
  form.append("file", new Blob([buffer]), name);
  return fetch(`${baseUrl}/api/file-scan`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

async function bodyOf(response) {
  const body = await response.json();
  return { status: response.status, body };
}

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "R4 Fixture", email: "r4@cybersafe.local", password: "password123", type: "personal" }),
  });
  assert.equal(res.status, 201, "fixture: conta sintética");
  token = (await res.json()).token;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("orçamento de entrada — o mesmo 400 KiB da análise de fundo", () => {
  test("o limite é 400 KiB e é o mesmo export usado pelo Scanner", () => {
    assert.equal(ARCHIVE_MAX_ENTRY_BYTES, 400 * 1024);
  });

  test("409 601 bytes declarados → 413 sanitizado, sem resultados nem exceção", async () => {
    const declared = ARCHIVE_MAX_ENTRY_BYTES + 1;
    const { status, body } = await bodyOf(await upload(zipBuffer([["big.bin", incompressible(declared)]])));
    assert.equal(status, 413);
    assert.equal(body.code, "archive_limit_exceeded");
    assert.equal(body.message, "O arquivo excede os limites de análise permitidos.");
    assert.equal("results" in body, false, "uma recusa nunca devolve resultados");
    assert.doesNotMatch(JSON.stringify(body), /ARCHIVE_|C:\\|\/tmp|Error/);
  });

  test("entrada no limite continua aceite (fronteira exata)", async () => {
    const { status, body } = await bodyOf(await upload(zipBuffer([["limit.bin", incompressible(ARCHIVE_MAX_ENTRY_BYTES)]])));
    assert.equal(status, 200);
    assert.equal(body.totalFiles, 1);
  });
});

describe("entradas perigosas e arquivo inválido", () => {
  test("path traversal → 422 archive_entry_rejected", async () => {
    // AdmZip normaliza o nome em addFile; o nome hostil é escrito no header
    // depois de criada a entrada, para o parser receber mesmo "../".
    const zip = new AdmZip();
    zip.addFile("escape.txt", Buffer.from("x"));
    zip.getEntries()[0].entryName = "../escape.txt";
    const { status, body } = await bodyOf(await upload(zip.toBuffer()));
    assert.equal(status, 422);
    assert.equal(body.code, "archive_entry_rejected");
  });

  test("nomes duplicados → 422 archive_entry_rejected", async () => {
    const zip = new AdmZip();
    zip.addFile("dup.txt", Buffer.from("a"));
    zip.addFile("DUP.txt", Buffer.from("b"));
    const { status, body } = await bodyOf(await upload(zip.toBuffer()));
    assert.equal(status, 422);
    assert.equal(body.code, "archive_entry_rejected");
  });

  test("bytes que não são ZIP → 422 archive_invalid", async () => {
    const { status, body } = await bodyOf(await upload(Buffer.from("not a zip at all"), "broken.zip"));
    assert.equal(status, 422);
    assert.equal(body.code, "archive_invalid");
  });
});

describe("fluxo benigno e pré-condições preservadas", () => {
  test("ZIP pequeno benigno continua 200 com os resultados reais", async () => {
    const { status, body } = await bodyOf(await upload(zipBuffer([["relatorio.txt", Buffer.from("conteúdo benigno")]])));
    assert.equal(status, 200);
    assert.equal(body.totalFiles, 1);
    assert.equal(body.results[0].fileName, "relatorio.txt");
  });

  test("sem autenticação → 401 antes de tocar no upload", async () => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("x")]), "x.txt");
    const res = await fetch(`${baseUrl}/api/file-scan`, { method: "POST", body: form });
    assert.equal(res.status, 401);
  });

  test("sem ficheiro → 400 file_required", async () => {
    const res = await fetch(`${baseUrl}/api/file-scan`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, "file_required");
  });
});

describe("classificador — avaria não classificada fica 500 seguro", () => {
  test("erro com mensagem a imitar código de limite não é promovido a 413", () => {
    const failure = fileScanFailure(Object.assign(new Error("C:\\segredo\\ARCHIVE_ENTRY_LIMIT"), { code: "ARCHIVE_ENTRY_LIMIT" }));
    assert.equal(failure.status, 500);
    assert.deepEqual(failure.body, { code: "scan_failed", message: "Não foi possível concluir a análise do ficheiro." });
    assert.doesNotMatch(JSON.stringify(failure.body), /segredo|ARCHIVE_/);
  });
});

test("diretório central corrompido → 422 archive_invalid sem exceção", async () => {
  const buffer = zipBuffer([["benign.txt", Buffer.from("hello")]]);
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  buffer.writeUInt32LE(0, central);
  const { status, body } = await bodyOf(await upload(buffer));
  assert.equal(status, 422);
  assert.deepEqual(body, { code: "archive_invalid", message: "O arquivo não pôde ser lido como um ZIP válido." });
  assert.equal(Object.hasOwn(body, "results"), false);
});
