import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

// ── Isolamento ANTES de importar o código da API ──
// DB em temp (nunca a DB real em ~/.cybersafe-service) e sem bind à porta 4000.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-api-auth-role-"));
const dbPath = path.join(tmpDir, "cybersafe.db");
process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = tmpDir;
process.env.CYBERSAFE_API_PORT = "4193";
process.env.CYBERSAFE_DB_PATH = dbPath;
process.env.CYBERSAFE_API_NO_LISTEN = "1";

// DB legada: schema antigo (sem coluna role) já com a conta dev personal/premium,
// tal como existe nas máquinas de desenvolvimento.
const DEV_EMAIL = "admin@cybersafe.local";
const DEV_PASSWORD = "CyberSafe2026!";
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    type TEXT NOT NULL,
    plan TEXT NOT NULL,
    companyName TEXT,
    createdAt TEXT NOT NULL
  );
`);
legacy
  .prepare("INSERT INTO users (id, name, email, passwordHash, type, plan, companyName, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run(
    "usr-legacy-dev",
    "CyberSafe Admin",
    DEV_EMAIL,
    bcrypt.hashSync(DEV_PASSWORD, 4),
    "personal",
    "premium",
    null,
    new Date().toISOString(),
  );
legacy.close();

// S1: o segredo JWT passou a ser obrigatório e sem fallback. A fixture injeta o
// seu próprio segredo (nunca o valor de produção nem um valor previsível).
process.env.JWT_SECRET = `test-secret-auth-role-${Math.random().toString(36).slice(2)}${Date.now()}`;

// A migration corre no import do db.js; o index.js exporta o app sem escutar.
  const { prisma, closeDb } = await import("../dist/db.js");
const { app } = await import("../dist/index.js");

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    process.emitWarning(
      `AUTH-ROLE TMPDIR LEAK: nao foi possivel remover ${tmpDir} (${err.code}), ` +
        `mesmo depois de closeDb(). Outro handle pode estar aberto.`,
    );
  }
});

async function login(email, password) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, json: await res.json() };
}

describe("migração role — DB legada sem a coluna", () => {
  test("coluna role foi adicionada e a conta legada fica role='user' sem perder dados", async () => {
    const user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
    assert.ok(user, "conta legada continua presente (DB não foi recriada)");
    assert.equal(user.role, "user");
    assert.equal(user.type, "personal");
    assert.equal(user.plan, "premium");
  });

  test("INSERT sem role (SQL direto) recebe o DEFAULT 'user'", () => {
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO users (id, name, email, passwordHash, type, plan, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("usr-default-check", "Default Check", "default@cybersafe.local", "x", "personal", "free", new Date().toISOString());
    const row = db.prepare("SELECT role FROM users WHERE id = 'usr-default-check'").get();
    db.close();
    assert.equal(row.role, "user");
  });
});

describe("register público não cria admins", () => {
  test("campo role no body é ignorado → novo utilizador é sempre 'user'", async () => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Escalate",
        email: "escalate@cybersafe.local",
        password: "password123",
        type: "personal",
        plan: "free",
        role: "admin",
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.user.role, "user");
    assert.ok(!("passwordHash" in json.user), "sanitizeUser não expõe passwordHash");
  });

  test("login devolve o role persistido ('user')", async () => {
    const { status, json } = await login("escalate@cybersafe.local", "password123");
    assert.equal(status, 200);
    assert.equal(json.user.role, "user");
    assert.ok(!("passwordHash" in json.user));
  });
});

describe("S2 — o bootstrap DEV não existe no produto (NODE_ENV ausente)", () => {
  test("POST /auth/dev/ensure-admin sem token → 404 (a rota não existe)", async () => {
    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  test("com token válido da conta dev → 404 e a conta continua role 'user'", async () => {
    const { status, json } = await login(DEV_EMAIL, DEV_PASSWORD);
    assert.equal(status, 200);

    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${json.token}` },
    });
    assert.equal(res.status, 404);

    const user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
    assert.equal(user.role, "user", "não há promoção automática a admin no produto");
  });

  test("tentativas repetidas também não promovem", async () => {
    const { json } = await login(DEV_EMAIL, DEV_PASSWORD);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, {
        method: "POST",
        headers: { Authorization: `Bearer ${json.token}` },
      });
      assert.equal(res.status, 404);
    }

    const user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
    assert.equal(user.role, "user");
  });

  test("/auth/me devolve o role persistido ('user') — sem promoção", async () => {
    const { json } = await login(DEV_EMAIL, DEV_PASSWORD);
    const res = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${json.token}` },
    });
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.role, "user");
    assert.ok(!("passwordHash" in user));
  });
});

// Limpeza do tmpDir criado em módulo (linha 11). A DB em disco é um ficheiro
// dentro de tmpDir; sem este after o diretório fica em %TEMP% para sempre.
after(() => {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    process.emitWarning(
      `AUTH-ROLE TMPDIR LEAK: nao foi possivel remover ${tmpDir} (${err.code}), ` +
        `mesmo depois de closeDb(). Outro handle pode estar aberto.`,
    );
  }
});
