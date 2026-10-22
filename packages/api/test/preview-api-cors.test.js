import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── TP-PREVIEW-API — CORS da PREVIEW (regressão da causa demonstrada) ──
//
// CAUSA REAL (medida em HTTP, não inferida): `vite preview` serve o build na
// porta 4173 e a app chama a API em http://127.0.0.1:4000 SEM proxy ⇒ é
// cross-origin. A allowlist do API só tinha 5173, pelo que o preflight do login
// (OPTIONS) vinha 403 SEM `Access-Control-Allow-Origin` ⇒ o browser bloqueava
// TODAS as chamadas. FIX: acrescentar as origens de preview em LOOPBACK (4173) à
// allowlist. Este teste prende o comportamento com HTTP real sobre uma DB
// ISOLADA e segredo de fixture; NÃO cria/regista contas e NÃO toca em DB pessoal.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-preview-cors-"));
process.env.CYBERSAFE_DB_PATH = path.join(tmpDir, "isolated.db");
process.env.CYBERSAFE_API_NO_LISTEN = "1"; // importar o app sem bind à porta 4000
process.env.JWT_SECRET = `test-secret-preview-cors-${Math.random().toString(36).slice(2)}${Date.now()}`;
delete process.env.CYBERSAFE_API_ALLOWED_ORIGINS;
delete process.env.CYBERSAFE_API_ALLOW_NULL_ORIGIN;

const { prisma, closeDb } = await import("../dist/db.js");
const { app, getAllowedOrigins, resolveAllowedOrigin } = await import("../dist/index.js");

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("allowlist de preview (unidade)", () => {
  test("default inclui as origens de DEV (5173) E as de PREVIEW (4173), só em loopback", () => {
    const origins = getAllowedOrigins({});
    assert.deepEqual(
      [...origins].sort(),
      [
        "http://127.0.0.1:4173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://localhost:5173",
      ].sort(),
    );
    assert.ok(!origins.includes("*"), "nunca wildcard");
    assert.ok(!origins.some((o) => !o.startsWith("http://localhost:") && !o.startsWith("http://127.0.0.1:")), "só loopback");
  });

  test("resolveAllowedOrigin aceita localhost:4173 e 127.0.0.1:4173 (são origens DISTINTAS)", () => {
    assert.equal(resolveAllowedOrigin("http://localhost:4173", {}), "http://localhost:4173");
    assert.equal(resolveAllowedOrigin("http://127.0.0.1:4173", {}), "http://127.0.0.1:4173");
  });

  test("resolveAllowedOrigin recusa origem externa e wildcard, e 'null' sem opt-in", () => {
    assert.equal(resolveAllowedOrigin("http://evil.example", {}), null);
    assert.equal(resolveAllowedOrigin("http://localhost:9999", {}), null);
    assert.equal(resolveAllowedOrigin("null", {}), null, "Origin: null só com opt-in explícito");
    assert.equal(resolveAllowedOrigin("null", { CYBERSAFE_API_ALLOW_NULL_ORIGIN: "1" }), "null");
  });

  test("CYBERSAFE_API_ALLOWED_ORIGINS configurável substitui o default (por instalação)", () => {
    const env = { CYBERSAFE_API_ALLOWED_ORIGINS: "https://updates.example.test" };
    assert.deepEqual(getAllowedOrigins(env), ["https://updates.example.test"]);
    assert.equal(resolveAllowedOrigin("https://updates.example.test", env), "https://updates.example.test");
    assert.equal(resolveAllowedOrigin("http://localhost:4173", env), null, "o override substitui, não amplia");
  });
});

describe("CORS de preview end-to-end (HTTP real sobre o app)", () => {
  test("OPTIONS preflight do login desde localhost:4173 ⇒ 204 + ACAO (era 403 sem ACAO)", async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:4173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:4173");
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
    // body do preflight vazio: nenhum dado devolvido.
    assert.equal(await res.text(), "");
  });

  test("GET /health desde 127.0.0.1:4173 traz ACAO (browser consegue ler a resposta)", async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: "http://127.0.0.1:4173" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
  });

  test("login INVÁLIDO desde 4173 é benigno: 401, sem ACAO ausente, e NÃO cria conta", async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "__no-such-user@preview.local", password: "x" }),
    });
    assert.equal(res.status, 401, "credenciais inválidas — pedido benigno que não grava nada");
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:4173");
    // prova de "não cria conta": o email sonda não existe na DB isolada.
    const row = await prisma.user.findUnique({ where: { email: "__no-such-user@preview.local" } });
    assert.equal(row, null);
  });

  test("origem NÃO permitida continua recusada (sem wildcard/creds bypass)", async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), null, "sem credenciais cross-origin");
  });
});
