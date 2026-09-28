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

// A migration corre no import do db.js; o index.js exporta o app sem escutar.
const { prisma } = await import("../dist/db.js");
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
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows pode manter o handle da DB aberto; o tmp do SO limpa o resto.
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

describe("bootstrap DEV promove apenas a conta dev", () => {
  test("sem token → 401", async () => {
    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, { method: "POST" });
    assert.equal(res.status, 401);
  });

  test("token de outra conta → 403 (a conta dev não é promovida por terceiros)", async () => {
    const { json } = await login("escalate@cybersafe.local", "password123");
    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${json.token}` },
    });
    assert.equal(res.status, 403);
  });

  test("conta dev legada (personal/premium) é promovida a admin sem virar business", async () => {
    const { json } = await login(DEV_EMAIL, DEV_PASSWORD);
    assert.equal(json.user.role, "user", "antes da promoção o role é o default da migração");

    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${json.token}` },
    });
    assert.equal(res.status, 200);
    const promoted = await res.json();
    assert.equal(promoted.user.role, "admin");
    assert.equal(promoted.user.type, "personal");
    assert.equal(promoted.user.plan, "premium");
    assert.ok(!("passwordHash" in promoted.user));
  });

  test("a promoção persiste e é idempotente", async () => {
    const { json } = await login(DEV_EMAIL, DEV_PASSWORD);
    assert.equal(json.user.role, "admin");

    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${json.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.role, "admin");
  });

  test("/auth/me devolve o role (payload completo após promoção)", async () => {
    const { json } = await login(DEV_EMAIL, DEV_PASSWORD);
    const res = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${json.token}` },
    });
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.role, "admin");
    assert.ok(!("passwordHash" in user));
  });
});
