import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

// ── S3 — rotas privadas autenticadas, bind loopback e CORS por allowlist ──
// DB isolada, segredo próprio da fixture e sem bind à porta 4000 antes de
// importar o código da API (dotenv não sobrepõe variáveis já definidas).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-api-guard-"));
const dbPath = path.join(tmpDir, "cybersafe.db");
process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = tmpDir;
process.env.CYBERSAFE_API_PORT = "4191";
process.env.CYBERSAFE_DB_PATH = dbPath;
process.env.CYBERSAFE_API_NO_LISTEN = "1";
const TEST_SECRET = `test-secret-api-guard-${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.JWT_SECRET = TEST_SECRET;
delete process.env.CYBERSAFE_API_ALLOWED_ORIGINS;
delete process.env.CYBERSAFE_API_ALLOW_NULL_ORIGIN;

const { prisma, closeDb } = await import("../dist/db.js");
const { app, getAllowedOrigins, resolveAllowedOrigin } = await import("../dist/index.js");

let server;
let baseUrl;
let token;
let userId;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Guard User",
      email: "guard@cybersafe.local",
      password: "password123",
      type: "personal",
      plan: "free",
    }),
  });
  assert.equal(res.status, 201, "fixture: registo do utilizador de teste");
  const json = await res.json();
  token = json.token;
  userId = json.user.id;
});

after(async () => {
  // O cliente SSE mantém a ligação aberta: fechar tudo antes do close evita
  // que o servidor fique à espera de um socket que o teste já abandonou.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    process.emitWarning(
      `API-GUARD TMPDIR LEAK: nao foi possivel remover ${tmpDir} (${err.code}), ` +
        `mesmo depois de closeDb(). Outro handle pode estar aberto.`,
    );
  }
});

const call = (method, path, { body, headers } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

const authed = (method, path, options = {}) =>
  call(method, path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });

// ─────────────────────────────────────────────────────────────────────────────
describe("S3 — rotas privadas: caller anónimo recebe 401 sem qualquer efeito", () => {
  const routes = [
    ["GET", "/api/dashboard"],
    ["GET", "/api/ai/status"],
    ["POST", "/api/ai/chat", {}],
    ["GET", "/api/events"],
    ["POST", "/api/events", { source: "test", severity: "low" }],
    ["DELETE", "/api/events"],
    ["GET", "/api/events/stats"],
    ["GET", "/api/training-score"],
    ["POST", "/api/training-score", { correctCount: 1, totalCount: 2 }],
    ["GET", "/api/stream"],
  ];

  for (const [method, route, body] of routes) {
    test(`${method} ${route} sem token → 401`, async () => {
      const res = await call(method, route, { body });
      assert.equal(res.status, 401, `esperado 401 em ${method} ${route}`);
      const json = await res.json();
      assert.equal(typeof json.message, "string");
    });
  }

  test("o DELETE anónimo não apaga nada e o POST anónimo não escreve", async () => {
    const before = (await prisma.threatEvent.findMany()).length;
    await call("DELETE", "/api/events");
    await call("POST", "/api/events", { body: { source: "anon", severity: "critical" } });
    const after = (await prisma.threatEvent.findMany()).length;
    assert.equal(after, before, "nenhum evento criado nem removido por caller anónimo");
  });

  test("o POST anónimo de training-score não cria registo", async () => {
    const before = (await prisma.trainingResult.findMany()).length;
    await call("POST", "/api/training-score", { body: { correctCount: 5, totalCount: 5 } });
    const after = (await prisma.trainingResult.findMany()).length;
    assert.equal(after, before);
  });

  test("upload anónimo é recusado antes de o ficheiro ser processado", async () => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("nao-e-analisado")]), "sonda.txt");
    const res = await fetch(`${baseUrl}/api/file-scan`, { method: "POST", body: form });
    assert.equal(res.status, 401);
  });

  test("token assinado com outro segredo → 401", async () => {
    const forged = jwt.sign({ sub: userId }, "outro-segredo-qualquer", { algorithm: "HS256" });
    const res = await call("GET", "/api/dashboard", { headers: { Authorization: `Bearer ${forged}` } });
    assert.equal(res.status, 401);
  });

  test("token válido de um utilizador inexistente → 401", async () => {
    const ghost = jwt.sign({ sub: "usr-inexistente" }, TEST_SECRET, { algorithm: "HS256", expiresIn: "7d" });
    const res = await call("GET", "/api/dashboard", { headers: { Authorization: `Bearer ${ghost}` } });
    assert.equal(res.status, 401);
  });
});

describe("S3 — caminho legítimo continua funcional", () => {
  test("GET /api/dashboard com token → 200", async () => {
    const res = await authed("GET", "/api/dashboard");
    assert.equal(res.status, 200);
  });

  test("GET /api/events com token → 200", async () => {
    const res = await authed("GET", "/api/events");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(await res.json()));
  });

  test("POST + GET /api/training-score com token → 201 e leitura coerente", async () => {
    const created = await authed("POST", "/api/training-score", { body: { correctCount: 3, totalCount: 4 } });
    assert.equal(created.status, 201);
    const list = await authed("GET", "/api/training-score");
    assert.equal(list.status, 200);
    const json = await list.json();
    assert.ok(json.totalSessions >= 1);
  });

  test("GET /api/stream com token → 200 (SSE autenticado antes de qualquer header)", async () => {
    const controller = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/stream`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/event-stream");
    } finally {
      controller.abort();
      // dar tempo ao servidor para largar o cliente SSE
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});

describe("S3 — públicas continuam públicas", () => {
  test("GET /health sem token → 200", async () => {
    const res = await call("GET", "/health");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });

  test("POST /auth/login continua acessível (credenciais erradas → 401 da rota, não do guard)", async () => {
    const res = await call("POST", "/auth/login", { body: { email: "guard@cybersafe.local", password: "errada" } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).message, "Credenciais inválidas.");
  });

  test("POST /auth/login correto devolve token utilizável nas rotas privadas", async () => {
    const res = await call("POST", "/auth/login", {
      body: { email: "guard@cybersafe.local", password: "password123" },
    });
    assert.equal(res.status, 200);
    const { token: fresh } = await res.json();
    const dash = await call("GET", "/api/dashboard", { headers: { Authorization: `Bearer ${fresh}` } });
    assert.equal(dash.status, 200);
  });

  test("GET /auth/me sem token → 401 (a rota mantém a sua própria verificação)", async () => {
    assert.equal((await call("GET", "/auth/me")).status, 401);
  });
});

describe("S3 — registo público não escolhe privilégios", () => {
  test("plan=premium, role=admin e type=business no body não elevam a conta", async () => {
    const res = await call("POST", "/auth/register", {
      body: {
        name: "Escalada",
        email: "escalada@cybersafe.local",
        password: "password123",
        type: "business",
        plan: "premium",
        role: "admin",
        company: { name: "Empresa X" },
      },
    });
    assert.equal(res.status, 201);
    const { user } = await res.json();
    assert.equal(user.plan, "free", "o plano é atribuído pela autoridade, não pelo caller");
    assert.equal(user.role, "user", "o registo público nunca cria admins");
    assert.ok(!("passwordHash" in user), "passwordHash nunca é exposto");
  });
});

describe("S3 — operações globais destrutivas exigem administrador", () => {
  // A base de teste nasce sem eventos (AUD-001 removeu o seed fictício), por isso
  // é a própria fixture a criar os registos que provam que nada foi apagado.
  const seedEvents = async () => {
    await prisma.threatEvent.createMany({
      data: [
        {
          source: "fixture",
          url: "https://fixture.invalid/a",
          domain: "fixture.invalid",
          severity: "high",
          confidence: 1,
          rulesTriggered: ["fixture-rule"],
        },
        {
          source: "fixture",
          url: "https://fixture.invalid/b",
          domain: "fixture.invalid",
          severity: "low",
          confidence: 0.5,
          rulesTriggered: ["fixture-rule"],
        },
      ],
    });
  };

  test("DELETE /api/events com utilizador normal → 403 e nada é apagado", async () => {
    await seedEvents();
    const before = (await prisma.threatEvent.findMany()).length;
    assert.ok(before > 0, "fixture: tem de haver eventos para provar que nada foi apagado");

    const res = await authed("DELETE", "/api/events");
    assert.equal(res.status, 403);
    assert.equal((await prisma.threatEvent.findMany()).length, before);
  });

  test("DELETE /api/events com administrador → 200 e a lista fica vazia", async () => {
    await seedEvents();
    assert.ok((await prisma.threatEvent.findMany()).length > 0, "fixture: há eventos para apagar");

    // Promoção direta na DB isolada: o produto não tem endpoint de promoção.
    const db = new Database(dbPath);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
    db.close();

    const res = await authed("DELETE", "/api/events");
    assert.equal(res.status, 200);
    assert.equal((await prisma.threatEvent.findMany()).length, 0);
  });
});

describe("S3 — CORS por allowlist (sem wildcard)", () => {
  test("regra de resolução de origem", () => {
    assert.deepEqual(getAllowedOrigins({}), [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
    ]);
    assert.deepEqual(getAllowedOrigins({ CYBERSAFE_API_ALLOWED_ORIGINS: " https://a.example , https://b.example " }), [
      "https://a.example",
      "https://b.example",
    ]);
    assert.equal(resolveAllowedOrigin(undefined, {}), null);
    assert.equal(resolveAllowedOrigin("http://localhost:5173", {}), "http://localhost:5173");
    assert.equal(resolveAllowedOrigin("http://evil.example", {}), null);
    assert.equal(resolveAllowedOrigin("null", {}), null, "Origin: null só com opt-in explícito");
    assert.equal(resolveAllowedOrigin("null", { CYBERSAFE_API_ALLOW_NULL_ORIGIN: "1" }), "null");
    assert.equal(
      resolveAllowedOrigin("chrome-extension://abc", { CYBERSAFE_API_ALLOWED_ORIGINS: "chrome-extension://abc" }),
      "chrome-extension://abc",
    );
  });

  test("pedido de origem autorizada recebe CORS; origem estranha não", async () => {
    const ok = await call("GET", "/health", { headers: { Origin: "http://localhost:5173" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const strange = await call("GET", "/health", { headers: { Origin: "http://evil.example" } });
    assert.equal(strange.status, 200);
    assert.equal(strange.headers.get("access-control-allow-origin"), null);
  });

  test("preflight: 204 para origem autorizada, 403 para origem estranha", async () => {
    const allowed = await call("OPTIONS", "/api/dashboard", { headers: { Origin: "http://localhost:5173" } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const blocked = await call("OPTIONS", "/api/dashboard", { headers: { Origin: "http://evil.example" } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  });

  test("CORS não substitui autenticação: origem autorizada sem token → 401", async () => {
    const res = await call("GET", "/api/dashboard", { headers: { Origin: "http://localhost:5173" } });
    assert.equal(res.status, 401);
  });

  test("caller sem Origin também não contorna a autenticação", async () => {
    assert.equal((await call("GET", "/api/dashboard")).status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bind loopback: processo isolado a escutar apenas em 127.0.0.1.
describe("S3 — a API escuta apenas em loopback", () => {
  const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  const freePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });

  const canConnect = (host, port, timeoutMs = 1500) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });

  const waitForListen = async (url, child, deadlineMs = 20000) => {
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

  test("127.0.0.1 responde e interfaces não-loopback não escutam", async () => {
    const port = await freePort();
    const env = { ...process.env, JWT_SECRET: TEST_SECRET, CYBERSAFE_API_PORT: String(port), CYBERSAFE_DB_PATH: path.join(tmpDir, "bind.db") };
    delete env.CYBERSAFE_API_NO_LISTEN;

    // cwd sem .env: a configuração do processo é controlada por este teste.
    const child = spawn(process.execPath, [distEntry], { cwd: tmpDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });

    try {
      const listening = await waitForListen(`http://127.0.0.1:${port}`, child);
      assert.ok(listening, `a API não chegou a escutar; output=${output}`);

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);

      const nonLoopback = Object.values(os.networkInterfaces())
        .flat()
        .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
        .map((iface) => iface.address);

      for (const address of nonLoopback) {
        assert.equal(
          await canConnect(address, port),
          false,
          `a API não pode estar alcançável em ${address}:${port}`,
        );
      }
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }

    // Encerrado o processo, a porta deixa de estar aberta (sem listener órfão).
    assert.equal(await canConnect("127.0.0.1", port), false, "porta ainda aberta depois de terminar a API");
  });
});
