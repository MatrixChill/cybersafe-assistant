import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

// ── S1 — o segredo JWT é obrigatório (sem fallback) ──
// DB isolada e sem bind à porta 4000 ANTES de importar o código da API.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-api-jwt-secret-"));
process.env.CYBERSAFE_DB_PATH = path.join(tmpDir, "cybersafe.db");
process.env.CYBERSAFE_API_NO_LISTEN = "1";

// Segredo próprio da fixture: nunca o valor de produção nem um valor previsível.
const TEST_SECRET = `test-jwt-secret-${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.JWT_SECRET = TEST_SECRET;

const { prisma, closeDb } = await import("../dist/db.js");
const { app, resolveJwtSecret } = await import("../dist/index.js");

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
      `JWT-SECRET TMPDIR LEAK: nao foi possivel remover ${tmpDir} (${err.code}), ` +
        `mesmo depois de closeDb(). Outro handle pode estar aberto.`,
    );
  }
});

describe("regra de resolução do segredo (sem fallback)", () => {
  test("ausente, vazio ou só espaços → null", () => {
    assert.equal(resolveJwtSecret({}), null);
    assert.equal(resolveJwtSecret({ JWT_SECRET: "" }), null);
    assert.equal(resolveJwtSecret({ JWT_SECRET: "   \t " }), null);
  });

  test("fallback público antigo e placeholder do .env.example → null", () => {
    assert.equal(resolveJwtSecret({ JWT_SECRET: "cybersafe-fallback-secret" }), null);
    assert.equal(resolveJwtSecret({ JWT_SECRET: "  altera-isto-em-producao  " }), null);
  });

  test("segredo curto (< 32 caracteres) → null, mesmo sendo único", () => {
    assert.equal(resolveJwtSecret({ JWT_SECRET: "segredo-proprio-123" }), null);
    assert.equal(resolveJwtSecret({ JWT_SECRET: "x".repeat(31) }), null);
  });

  test("segredo próprio com 32+ caracteres → devolvido (trim dos espaços exteriores)", () => {
    const strong = "segredo-proprio-123-com-mais-de-32-caracteres";
    assert.equal(resolveJwtSecret({ JWT_SECRET: strong }), strong);
    assert.equal(resolveJwtSecret({ JWT_SECRET: `  ${strong}  ` }), strong);
  });
});

describe("/auth/me — tokens recusados (401) sem chegar a operações privadas", () => {
  let userId;
  let validToken;

  before(async () => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "JWT Check",
        email: "jwt-check@cybersafe.local",
        password: "password123",
        type: "personal",
        plan: "free",
      }),
    });
    assert.equal(res.status, 201, "fixture: registo do utilizador de teste");
    const json = await res.json();
    userId = json.user.id;
    validToken = json.token;
  });

  const me = (token) =>
    fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });

  test("token válido da fixture → 200 (caminho legítimo continua funcional)", async () => {
    const res = await me(validToken);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.id, userId);
  });

  test("token assinado com segredo diferente → 401", async () => {
    const forged = jwt.sign({ sub: userId }, "outro-segredo-qualquer", {
      algorithm: "HS256",
      expiresIn: "7d",
    });
    assert.equal((await me(forged)).status, 401);
  });

  test("token assinado com o fallback público antigo → 401", async () => {
    const forged = jwt.sign({ sub: userId }, "cybersafe-fallback-secret", {
      algorithm: "HS256",
      expiresIn: "7d",
    });
    assert.equal((await me(forged)).status, 401);
  });

  test("algoritmo não permitido (HS512) → 401", async () => {
    const otherAlg = jwt.sign({ sub: userId }, TEST_SECRET, {
      algorithm: "HS512",
      expiresIn: "7d",
    });
    assert.equal((await me(otherAlg)).status, 401);
  });

  test("sub ausente ou vazio → 401 (sem lookup por identidade vazia)", async () => {
    const noSub = jwt.sign({ role: "admin" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "7d",
    });
    const emptySub = jwt.sign({ sub: "  " }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "7d",
    });
    assert.equal((await me(noSub)).status, 401);
    assert.equal((await me(emptySub)).status, 401);
  });

  test("token expirado → 401", async () => {
    const expired = jwt.sign({ sub: userId }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "-1s",
    });
    assert.equal((await me(expired)).status, 401);
  });
});

describe("arranque do processo sem segredo válido: erro e sem listener", () => {
  const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  // Processo isolado: cwd fora do pacote (não apanha o .env real) e DB em temp,
  // para que a falha aconteça sem tocar na DB do serviço.
  const runWithoutSecret = (secret) => {
    const env = {
      ...process.env,
      CYBERSAFE_DB_PATH: path.join(tmpDir, "child-startup.db"),
    };
    delete env.JWT_SECRET;
    delete env.CYBERSAFE_API_NO_LISTEN;
    if (secret !== undefined) env.JWT_SECRET = secret;

    return spawnSync(process.execPath, [distEntry], {
      cwd: tmpDir,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
  };

  const cases = [
    ["sem JWT_SECRET", undefined],
    ["JWT_SECRET vazio", ""],
    ["JWT_SECRET com o fallback público antigo", "cybersafe-fallback-secret"],
    ["JWT_SECRET com o placeholder do .env.example", "altera-isto-em-producao"],
    ["JWT_SECRET curto (16 caracteres)", "a".repeat(16)],
  ];

  for (const [label, secret] of cases) {
    test(`${label} → exit != 0 e o listener nunca abre`, () => {
      const result = runWithoutSecret(secret);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.notEqual(result.status, 0, `esperado arranque abortado; output=${output}`);
      assert.ok(
        !/listening on/i.test(output),
        `o processo não podia anunciar listener; output=${output}`,
      );
      assert.match(output, /JWT_SECRET/, "a mensagem deve nomear a variável em falta");
    });
  }
});

// Garante que os testes acima usaram mesmo uma conta persistida na DB isolada.
test("fixture realmente persistiu o utilizador na DB temporária", async () => {
  const user = await prisma.user.findUnique({ where: { email: "jwt-check@cybersafe.local" } });
  assert.ok(user, "utilizador de teste tem de existir na DB isolada");
});

test("a DB temporária não é a DB real do serviço", () => {
  const db = new Database(path.join(tmpDir, "cybersafe.db"), { readonly: true });
  const rows = db.prepare("SELECT id FROM users WHERE email = 'jwt-check@cybersafe.local'").all();
  db.close();
  assert.equal(rows.length, 1);
});
