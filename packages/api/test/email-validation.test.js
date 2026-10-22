import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── EMAIL-16-10 — o caso `gmail.c` no endpoint real ──
// O regex antigo (app e API) aceitava TLD incompleto (`gmail.c`) e domínios
// mal formados. A validação vive agora em @cybersafe/shared-types
// (isValidEmailFormat), usada pelos dois lados; este teste fixa o
// comportamento do /auth/register verdadeiro. Formato válido NÃO é email
// confirmado — a API não confirma nada e a resposta não pode dizê-lo.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-email-"));
process.env.CYBERSAFE_DB_PATH = path.join(tmpDir, "cybersafe.db");
process.env.CYBERSAFE_API_NO_LISTEN = "1";
process.env.JWT_SECRET = `test-secret-email-${Math.random().toString(36).slice(2)}${Date.now()}`;

const { closeDb } = await import("../dist/db.js");
const { app } = await import("../dist/index.js");

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // a limpeza do tmp não deve esconder o resultado real dos testes
  }
});

function registar(email) {
  return fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Teste Email", email, password: "password123", type: "personal" }),
  });
}

describe("EMAIL-16-10 — formato de email no registo real", () => {
  const VALIDOS = [
    "ana@exemplo.pt",
    "a+alias@sub.dominio.co.uk",
    "Nome.Sobrenome@GMAIL.com",
    "user@exemplo.xn--p1ai",
  ];

  const INVALIDOS = [
    ["caioc@gmail.c", "caso reportado: TLD de 1 letra"],
    ["gmail.c", "sem @ nem TLD"],
    ["a@gmail", "sem TLD"],
    ["a@.com", "etiqueta vazia"],
    ["a@com.", "TLD vazio"],
    ["a..b@x.com", "pontos consecutivos na parte local"],
    [".a@x.com", "ponto inicial na parte local"],
    ["a.@x.com", "ponto final na parte local"],
    ["a@b..com", "pontos consecutivos no domínio"],
    ["a@-b.com", "etiqueta a começar em -"],
    ["a@b-.com", "etiqueta a acabar em -"],
    ["a b@x.com", "espaço no meio"],
    ["a@@x.com", "dois @"],
    ["a@x.c0m", "TLD com dígito (não punycode)"],
  ];

  for (const email of VALIDOS) {
    test(`aceita ${email}`, async () => {
      const res = await registar(email);
      assert.equal(res.status, 201, `${email} devia ser aceite`);
      const json = await res.json();
      assert.equal(json.user.email, email, "o email guardado tem de ser o enviado");
    });
  }

  for (const [email, porque] of INVALIDOS) {
    test(`recusa ${JSON.stringify(email)} (${porque})`, async () => {
      const res = await registar(email);
      assert.equal(res.status, 400, `${JSON.stringify(email)} devia ser recusado`);
      const json = await res.json();
      assert.equal(json.message, "Formato de email inválido.");
    });
  }

  test("recusa email com mais de 254 caracteres", async () => {
    const res = await registar(`${"a".repeat(250)}@x.com`);
    assert.equal(res.status, 400);
  });

  test("formato válido não é confirmação: a resposta não afirma verificação", async () => {
    const res = await registar(`confirmacao${Date.now()}@exemplo.pt`);
    assert.equal(res.status, 201);
    const corpo = JSON.stringify(await res.json());
    assert.doesNotMatch(corpo, /verificad|confirmad/i, "a API não pode afirmar confirmação de email");
  });
});
