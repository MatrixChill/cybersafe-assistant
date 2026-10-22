import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

// ── Ferramenta de verificação da migração de conta (condição 8) ──
// Corre a CLI real contra uma instalação real: API a escutar em loopback, DB
// temporária e utilizadores semeados. Nada toca na DB do serviço.

const apiDir = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(apiDir, "scripts", "verify-account-migration.mjs");
const rotateTool = path.join(apiDir, "scripts", "rotate-jwt-secret.mjs");
const distEntry = path.join(apiDir, "dist", "index.js");

const LEGACY_EMAIL = "admin@cybersafe.local";
const LEGACY_DEV_PASSWORD = "CyberSafe2026!";
const ADMIN_EMAIL = "owner@example.test";
const ADMIN_PASSWORD = "R8#kM3!wX6$qJ2%pz";

const JWT_SECRET = `test-secret-verify-${Math.random().toString(36).slice(2)}${Date.now()}`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** DB temporária com o mesmo esquema do serviço + duas contas. */
function makeFixture({ legacyPasswordWorks }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-verify-migration-"));
  const dbPath = path.join(dir, "cybersafe.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL, type TEXT NOT NULL, plan TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', companyName TEXT, createdAt TEXT NOT NULL
    );
    CREATE TABLE threat_events (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, url TEXT, domain TEXT, severity TEXT NOT NULL,
      confidence REAL, rulesTriggered TEXT, createdAt TEXT NOT NULL
    );
    CREATE TABLE training_results (
      id TEXT PRIMARY KEY, userId TEXT, gameType TEXT NOT NULL, score INTEGER NOT NULL,
      maxScore INTEGER NOT NULL, completedAt TEXT NOT NULL
    );
  `);
  const legacyHash = bcrypt.hashSync(legacyPasswordWorks ? LEGACY_DEV_PASSWORD : "segredo-aleatorio-do-legado", 4);
  db.prepare(
    "INSERT INTO users (id,name,email,passwordHash,type,plan,role,createdAt) VALUES (?,?,?,?,?,?,?,?)",
  ).run("legacy", "CyberSafe Admin", LEGACY_EMAIL, legacyHash, "personal", "premium", "admin", "2026-06-14");
  db.prepare(
    "INSERT INTO users (id,name,email,passwordHash,type,plan,role,createdAt) VALUES (?,?,?,?,?,?,?,?)",
  ).run("owner", "Administrador local", ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 4), "personal", "free", "admin", "2026-10-09");
  db.prepare("INSERT INTO threat_events (id,source,severity,createdAt) VALUES (?,?,?,?)").run(
    "ev1", "extension", "low", "2026-10-09T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO training_results (id,userId,gameType,score,maxScore,completedAt) VALUES (?,?,?,?,?,?)",
  ).run("tr1", "owner", "simulator", 1, 2, "2026-10-09T00:00:00.000Z");
  db.close();
  return { dir, dbPath };
}

const waitForHealth = async (url, child, deadlineMs = 20000) => {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {
      /* ainda a arrancar */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

/**
 * Arranca a API real contra a fixture e devolve o URL + limpeza.
 * `secret: null` omite o JWT_SECRET do ambiente (para o caso em que ele tem de
 * vir do `.env` do `cwd`, como na instalação real); `cwd` permite isolar o .env.
 */
async function startApi(dbPath, { port: listenOn, cwd, secret = JWT_SECRET } = {}) {
  const port = listenOn ?? (await freePort());
  const env = { ...process.env, CYBERSAFE_API_PORT: String(port), CYBERSAFE_DB_PATH: dbPath };
  if (secret) env.JWT_SECRET = secret;
  else delete env.JWT_SECRET;
  // A API tem de escutar mesmo: este teste corre-a como processo, não importa o app.
  delete env.CYBERSAFE_API_NO_LISTEN;
  const child = spawn(process.execPath, [distEntry], {
    cwd: cwd ?? os.tmpdir(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  // 'exit' pode já ter ocorrido quando o processo é terminado por sinal: no
  // Windows kill() usa TerminateProcess e o exitCode fica null. Registar o
  // evento uma única vez evita esperar para sempre por um evento já passado.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const api = `http://127.0.0.1:${port}`;
  const ready = await waitForHealth(api, child);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  };
  if (!ready) {
    await stop();
    throw new Error(`API de teste não arrancou: ${output}`);
  }
  return { api, port, stop, output: () => output };
}

const login = async (api, email, password) => {
  const res = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const meStatus = async (api, token) =>
  (await fetch(`${api}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status;

const runVerify = (fx, { api, email = ADMIN_EMAIL, password = ADMIN_PASSWORD, extra = [] } = {}) => {
  const args = [script, "--email", email, "--api", api, "--db", fx.dbPath, "--password-stdin", ...extra];
  return spawnSync(process.execPath, args, { input: `${password}\n`, encoding: "utf8", timeout: 60000 });
};

test("migração saudável: tudo passa e a palavra-passe não aparece na saída", async (t) => {
  const fx = makeFixture({ legacyPasswordWorks: false });
  const running = await startApi(fx.dbPath);
  t.after(async () => {
    await running.stop();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  const result = runVerify(fx, { api: running.api });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  for (const check of [
    "PASS API_REACHABLE",
    "PASS LOGIN_NEW_ADMIN",
    "PASS SESSION_ME",
    "PASS LEGACY_LOGIN_BLOCKED",
    "PASS LOGOUT_NO_TOKEN_DENIED",
    "PASS DATA_PRESERVED",
    "PASS LEGACY_ACCOUNT_ROW_PRESERVED",
  ]) {
    assert.match(result.stdout, new RegExp(check.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(result.stdout, /RESULTADO=TODAS_AS_VERIFICACOES_PASSARAM/);
  assert.doesNotMatch(result.stdout, /R8#kM3/);
  assert.doesNotMatch(result.stderr, /R8#kM3/);
});

test("deteta a credencial DEV ainda ativa e falha (não declara migração concluída)", async (t) => {
  const fx = makeFixture({ legacyPasswordWorks: true });
  const running = await startApi(fx.dbPath);
  t.after(async () => {
    await running.stop();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  const result = runVerify(fx, { api: running.api });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /FAIL LEGACY_LOGIN_BLOCKED/);
  assert.match(result.stdout, /RESULTADO=FALHOU/);
});

test("recusa claramente quando a API não responde", async (t) => {
  const fx = makeFixture({ legacyPasswordWorks: false });
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));

  // Sem API a escutar: porta livre que ninguém ocupa.
  const result = runVerify(fx, { api: `http://127.0.0.1:${await freePort()}` });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /FAIL API_REACHABLE/);
  assert.match(result.stderr, /A API local não respondeu/);
});

test("a rotação do JWT_SECRET pelo CLI invalida sessões antigas e preserva os dados", async (t) => {
  const fx = makeFixture({ legacyPasswordWorks: false });
  // cwd com o `.env` da instalação: é de onde o dotenv lê o segredo em produção.
  const installDir = path.join(fx.dir, "install");
  fs.mkdirSync(installDir, { recursive: true });
  const envFile = path.join(installDir, ".env");
  const firstSecret = `rehearsal-a-${"a".repeat(40)}`;
  fs.writeFileSync(envFile, `OPENAI_API_KEY=irrelevante\nJWT_SECRET=${firstSecret}\n`);

  const first = await startApi(fx.dbPath, { cwd: installDir, secret: null });
  t.after(async () => {
    await first.stop();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  const before = await login(first.api, ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(before.status, 200);
  const oldToken = before.body.token;
  assert.equal(await meStatus(first.api, oldToken), 200);
  await first.stop();

  // Rotação real com a ferramenta do produto: gera um segredo novo, preserva o
  // resto do .env e a instalação reinicia a ler o .env do cwd.
  const rotation = spawnSync(process.execPath, [rotateTool, "--file", envFile], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(rotation.status, 0, `${rotation.stdout}\n${rotation.stderr}`);
  assert.match(rotation.stdout, /ACTION=ROTATE_JWT_SECRET/);
  const rotated = fs.readFileSync(envFile, "utf8").match(/^JWT_SECRET=(.+)$/m)[1];
  assert.notEqual(rotated, firstSecret);
  for (const stream of [rotation.stdout, rotation.stderr]) assert.ok(!stream.includes(rotated));

  let second;
  try {
    second = await startApi(fx.dbPath, { port: first.port, cwd: installDir, secret: null });
    const stale = await meStatus(second.api, oldToken);
    assert.equal(stale, 401, "token antigo tem de ser recusado após a rotação");
    const after = await login(second.api, ADMIN_EMAIL, ADMIN_PASSWORD);
    assert.equal(after.status, 200, "o login novo continua a funcionar depois da rotação");
    assert.equal(await meStatus(second.api, after.body.token), 200);
  } finally {
    if (second) await second.stop();
  }

  // Sem escritores abertos: provar que a rotação não tocou nos dados (condição 8).
  const db = new Database(fx.dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM threat_events").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM training_results").get().n, 1);
    assert.ok(db.prepare("SELECT id FROM users WHERE email = ?").get(LEGACY_EMAIL));
  } finally {
    db.close();
  }
});

test("a palavra-passe nunca é aceite por ambiente nem por argumentos", (t) => {
  const fx = makeFixture({ legacyPasswordWorks: false });
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));

  // Sem --password-stdin e sem TTY: recusa, em vez de inventar uma origem.
  const result = spawnSync(
    process.execPath,
    [script, "--email", ADMIN_EMAIL, "--api", "http://127.0.0.1:1", "--db", fx.dbPath],
    { env: { ...process.env, CYBERSAFE_ADMIN_PASSWORD: ADMIN_PASSWORD }, encoding: "utf8", timeout: 30000 },
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /R8#kM3/);
  assert.match(result.stderr, /ERRO=Sem terminal interativo/);
});
