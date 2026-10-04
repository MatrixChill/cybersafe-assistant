import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

// ── Ambiente de PRODUÇÃO e DB isolada ANTES de importar o código da API ──
// (dotenv.config() não sobrepõe variáveis já definidas no process.env).
process.env.NODE_ENV = "production";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-api-auth-prod-"));
const dbPath = path.join(tmpDir, "cybersafe.db");
process.env.CYBERSAFE_DB_PATH = dbPath;
process.env.CYBERSAFE_API_NO_LISTEN = "1";

// DB legada com a conta dev já presente (personal/premium, sem coluna role).
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

  const { prisma, closeDb } = await import("../dist/db.js");
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
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    process.emitWarning(
      `AUTH-ROLE-PROD TMPDIR LEAK: nao foi possivel remover ${tmpDir} (${err.code}), ` +
        `mesmo depois de closeDb(). Outro handle pode estar aberto.`,
    );
  }
});

describe("NODE_ENV=production — bootstrap DEV inacessível", () => {
  test("login da conta dev continua a funcionar (o guard só mata o endpoint dev)", async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.user.role, "user");
  });

  test("POST /auth/dev/ensure-admin sem token → 404 (o guard corre antes da autenticação)", async () => {
    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  test("com token válido da conta dev → 404 e a conta NÃO é promovida", async () => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
    });
    const { token } = await loginRes.json();

    const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);

    const user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
    assert.equal(user.role, "user", "em produção a conta dev não pode ser promovida");
  });

  test("tentativas repetidas também não promovem (rejeita sempre)", async () => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
    });
    const { token } = await loginRes.json();

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/auth/dev/ensure-admin`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 404);
    }

    const user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
    assert.equal(user.role, "user");
  });
});

// Limpeza do tmpDir criado em módulo (linha 12). A DB em disco é um ficheiro
// dentro de tmpDir; sem este after o diretório fica em %TEMP% para sempre.
after(() => {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    process.emitWarning(
      `AUTH-ROLE-PROD TMPDIR LEAK: nao foi possivel remover ${tmpDir} (${err.code}), ` +
        `mesmo depois de closeDb(). Outro handle pode estar aberto.`,
    );
  }
});
