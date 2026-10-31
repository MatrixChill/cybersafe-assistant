/**
 * DIST-AUTH13OUT — auditoria de autenticacao (api/src/**).
 *
 * Prova, com DB em TEMP e sem contas reais (todas as contas sao
 * @cybersafe.local de fixture):
 *  - O registo publico ignora `plan` e `role` do body: a conta
 *    nasce sempre free/user (edicao academica gratuita; sem
 *    checkout/payment; contas legadas intactas, sem migracao).
 *  - Inputs de registo/login com tipos errados (arrays, objetos,
 *    numeros, booleanos, null, strings vazias/so' espacos,
 *    `company` aninhado) sao recusados com 400 ANTES de tocar
 *    a DB ou o bcrypt — nunca 500 nem contam criadas com o tipo
 *    errado (o SQLite coercia tipos e o bcrypt falhava).
 *  - Erros internos nunca ecoam detalhes ao cliente (sem
 *    `error: String(error)` na resposta).
 *  - Endpoints privados: 401 sem token; operacoes de admin
 *    recusadas (403) a utilizador normal — nenhum bypass de
 *    role/tenant.
 *
 * O bootstrap DEV foi removido do produto (S2): NAO e'
 * reimplementado aqui nem a migracao e' reaberta — a prova e'
 * que /auth/dev/ensure-admin nao existe (404) e o registo nunca
 * promove.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Isolamento ANTES de importar o código da API ──
// DB em temp (nunca a DB real em ~/.cybersafe-service), segredo
// próprio da fixture (nunca o de produção nem um previsível) e
// sem bind à porta 4000.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-api-dist-auth13-"));
const dbPath = path.join(tmpDir, "cybersafe.db");
process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = tmpDir;
process.env.CYBERSAFE_API_PORT = "4194";
process.env.CYBERSAFE_DB_PATH = dbPath;
process.env.CYBERSAFE_API_NO_LISTEN = "1";
process.env.JWT_SECRET = `test-secret-dist-auth13-${Math.random().toString(36).slice(2)}${Date.now()}`;

const { closeDb } = await import("../dist/db.js");
const { app } = await import("../dist/index.js");

let server;
let baseUrl;
let userToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Utilizador normal de fixture para os testes de endpoints privados.
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Audit User",
      email: "audit-user@cybersafe.local",
      password: "password123",
      type: "personal",
    }),
  });
  assert.equal(res.status, 201, "fixture: registo do utilizador de auditoria");
  userToken = (await res.json()).token;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    process.emitWarning(
      `DIST-AUTH13 TMPDIR LEAK: nao foi possivel remover ${tmpDir} (${err.code}).`,
    );
  }
});

const register = (body) =>
  fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));

const login = (body) =>
  fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));

const call = (method, apiPath, token) =>
  fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then((res) => ({ status: res.status }));

const uniqueEmail = (prefix) => `${prefix}-${Math.random().toString(36).slice(2)}@cybersafe.local`;

describe("registo: plano e papel nunca vêm do caller (edicao gratuita)", () => {
  test("plan/role no body sao ignorados → conta nasce free/user", async () => {
    const res = await register({
      name: "Privileged",
      email: uniqueEmail("privileged"),
      password: "password123",
      type: "personal",
      plan: "premium",
      role: "admin",
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.user.plan, "free");
    assert.equal(res.json.user.role, "user");
    assert.ok(!("passwordHash" in res.json.user), "sanitizeUser não expõe passwordHash");
  });

  test("login devolve o plano/role persistidos (free/user)", async () => {
    const email = uniqueEmail("persist");
    await register({
      name: "Persist",
      email,
      password: "password123",
      type: "personal",
      plan: "pro",
      role: "admin",
    });
    const res = await login({ email, password: "password123" });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.plan, "free");
    assert.equal(res.json.user.role, "user");
  });
});

describe("registo: tipos de input recusados com 400 (antes da DB/bcrypt)", () => {
  for (const [label, name] of [
    ["array", ["Not", "A", "String"]],
    ["objeto", { first: "A" }],
    ["numero", 123],
    ["booleano", true],
    ["null", null],
    ["string vazia", ""],
    ["so' espacos", "   "],
  ]) {
    test(`name ${label} → 400 (nunca 500 nem conta com tipo errado)`, async () => {
      const res = await register({
        name,
        email: uniqueEmail("name"),
        password: "password123",
        type: "personal",
      });
      assert.equal(res.status, 400, `name ${label}: esperado 400, obtido ${res.status}`);
    });
  }

  test("email array com email valido dentro → 400 (o regex coercia e a DB falhava)", async () => {
    const res = await register({
      name: "Array Email",
      email: ["someone@cybersafe.local"],
      password: "password123",
      type: "personal",
    });
    assert.equal(res.status, 400, `esperado 400, obtido ${res.status}`);
  });

  for (const [label, password] of [
    ["numero", 123456],
    ["booleano", true],
    ["array", ["p", "w"]],
    ["objeto", { value: "password123" }],
    ["null", null],
  ]) {
    test(`password ${label} → 400`, async () => {
      const res = await register({
        name: "Password Case",
        email: uniqueEmail("password"),
        password,
        type: "personal",
      });
      assert.equal(res.status, 400, `password ${label}: esperado 400, obtido ${res.status}`);
    });
  }

  test("type array → 400", async () => {
    const res = await register({
      name: "Type Array",
      email: uniqueEmail("type"),
      password: "password123",
      type: ["personal"],
    });
    assert.equal(res.status, 400);
  });

  for (const [label, company] of [
    ["string", "Not An Object"],
    ["array", [{ name: "X" }]],
    ["numero", 42],
    ["name numero", { name: 123 }],
    ["name array", { name: ["X"] }],
    ["name objeto", { name: { deep: "X" } }],
    ["name vazio", { name: "" }],
    ["name so' espacos", { name: "   " }],
  ]) {
    test(`business company ${label} → 400`, async () => {
      const res = await register({
        name: "Company Case",
        email: uniqueEmail("company"),
        password: "password123",
        type: "business",
        company,
      });
      assert.equal(res.status, 400, `company ${label}: esperado 400, obtido ${res.status}`);
    });
  }

  test("company valido (name+size+sector) → 201 e os campos validos sao preservados", async () => {
    const res = await register({
      name: "Company Ok",
      email: uniqueEmail("company-ok"),
      password: "password123",
      type: "business",
      company: { name: "CyberSafe Lda", size: "11-50", sector: "Technology" },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.user.company, {
      name: "CyberSafe Lda",
      size: "11-50",
      sector: "Technology",
    });
  });

  test("company com campos extra desconhecidos → 201 e só os campos conhecidos sao ecoados", async () => {
    const res = await register({
      name: "Company Extra",
      email: uniqueEmail("company-extra"),
      password: "password123",
      type: "business",
      company: { name: "Only Name", extra: "inerte" },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.user.company, { name: "Only Name" });
  });

  test("company size numerico → 400 (tipo invalido)", async () => {
    const res = await register({
      name: "Company Size",
      email: uniqueEmail("company-size"),
      password: "password123",
      type: "business",
      company: { name: "X", size: 123 },
    });
    assert.equal(res.status, 400);
  });

  test("company sector array → 400 (tipo invalido)", async () => {
    const res = await register({
      name: "Company Sector",
      email: uniqueEmail("company-sector"),
      password: "password123",
      type: "business",
      company: { name: "X", sector: ["Tech"] },
    });
    assert.equal(res.status, 400);
  });

  test("company size vazio → 400 (o renderer envia undefined, nunca vazio)", async () => {
    const res = await register({
      name: "Company Empty Size",
      email: uniqueEmail("company-empty-size"),
      password: "password123",
      type: "business",
      company: { name: "X", size: "" },
    });
    assert.equal(res.status, 400);
  });

  test("login E /auth/me devolvem company com name (schema sempre persistiu só companyName — limite histórico documentado, sem migração, sem promessa de roundtrip de size)", async () => {
    const email = uniqueEmail("company-persist");
    await register({
      name: "Company Persist",
      email,
      password: "password123",
      type: "business",
      company: { name: "Persist Lda", size: "1-10" },
    });
    const res = await login({ email, password: "password123" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.user.company, { name: "Persist Lda" });
    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${res.json.token}` },
    });
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).user.company, { name: "Persist Lda" });
  });

  test("personal com company valido → 201 e a conta pessoal nao carrega company", async () => {
    const res = await register({
      name: "Personal With Company",
      email: uniqueEmail("personal-company"),
      password: "password123",
      type: "personal",
      company: { name: "Ignored Lda", size: "1-10" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.user.company, undefined);
  });
});

describe("login: tipos de input recusados com 400", () => {
  test("email array → 400 (a DB falhava com 500)", async () => {
    const res = await login({ email: ["a@cybersafe.local"], password: "password123" });
    assert.equal(res.status, 400, `esperado 400, obtido ${res.status}`);
  });

  for (const [label, email] of [["numero", 123], ["objeto", { email: "a@b.c" }], ["null", null]]) {
    test(`email ${label} → 400`, async () => {
      const res = await login({ email, password: "password123" });
      assert.equal(res.status, 400, `email ${label}: esperado 400, obtido ${res.status}`);
    });
  }

  for (const [label, password] of [["array", []], ["numero", 123456], ["objeto", {}], ["null", null]]) {
    test(`password ${label} → 400`, async () => {
      const res = await login({ email: "a@cybersafe.local", password });
      assert.equal(res.status, 400, `password ${label}: esperado 400, obtido ${res.status}`);
    });
  }
});

describe("endpoints privados: autenticacao e admin (nenhum bypass role/tenant)", () => {
  test("GET /api/events sem token → 401", async () => {
    const res = await call("GET", "/api/events");
    assert.equal(res.status, 401);
  });

  test("DELETE /api/events com utilizador normal → 403", async () => {
    const res = await call("DELETE", "/api/events", userToken);
    assert.equal(res.status, 403);
  });

  test("GET /api/dashboard com utilizador normal → 200 (leitura e permitida)", async () => {
    const res = await call("GET", "/api/dashboard", userToken);
    assert.equal(res.status, 200);
  });

  test("bootstrap DEV removido: /auth/dev/ensure-admin → 404 mesmo com token", async () => {
    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.status, 404, "o endpoint de promoção automática não existe no produto");
  });
});

// POR ÚLTIMO: fecha a ligação para forçar um erro interno real.
// requireAuth faz lookup na DB, por isso nada pode correr depois.
describe("erros internos nunca ecoam detalhes ao cliente", () => {
  test("500 real (DB fechada) devolve mensagem fixa, sem campo error nem SQL", async () => {
    closeDb();
    const res = await register({
      name: "After Close",
      email: uniqueEmail("after-close"),
      password: "password123",
      type: "personal",
    });
    assert.equal(res.status, 500);
    assert.equal(res.json.message, "Erro interno ao criar conta.");
    assert.equal("error" in res.json, false, "o corpo nunca ecoa String(error)");
  });
});
