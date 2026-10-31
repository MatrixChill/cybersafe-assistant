import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import jwt from "jsonwebtoken";

// Characterisation of a security defect, NOT an assertion that logout is safe.
// Only synthetic credentials, an isolated database and loopback HTTP are used.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-r6-l12-"));
process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = temp;
process.env.CYBERSAFE_API_PORT = "4199";
process.env.CYBERSAFE_DB_PATH = path.join(temp, "fixture.db");
process.env.CYBERSAFE_API_NO_LISTEN = "1";
process.env.JWT_SECRET = "r6-l12-isolated-fixture-signing-secret-only";
const { app } = await import("../dist/index.js");
const { closeDb } = await import("../dist/db.js");
const source = fs.readFileSync(new URL("../../app/src/contexts/AuthContext.tsx", import.meta.url), "utf8");
const callback = source.match(/const logout = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
assert.ok(callback, "extract the actual logout callback; fail if its structure changes");
let server, base, token;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "R6 L12 fixture", email: "r6-l12@example.invalid", password: "fixture-only-password", type: "personal" }),
  });
  assert.equal(response.status, 201);
  token = (await response.json()).token;
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  closeDb();
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("cybersafe-r6-l12-"));
  fs.rmSync(temp, { recursive: true, force: true });
});
const request = authorization => fetch(`${base}/api/dashboard`, {
  headers: authorization ? { Authorization: authorization } : {},
});

test("controlo: rota privada recusa pedido sem token", async () => {
  const response = await request();
  assert.equal(response.status, 401);
});
test("controlo: token inválido é recusado sem eco", async () => {
  const response = await request("Bearer r6-l12-invalid-fixture");
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes("r6-l12-invalid-fixture"));
});
// REGRESSÃO (cliente). A caracterização original deste teste provava o DEFEITO
// (o callback real só limpava o token local e uma cópia continuava autorizada).
// Com a correção do R6-L12 — servidor com POST /auth/logout E cliente a chamá-lo
// — o comportamento passou a ser o correto, e este teste passou a fixar o FIX:
// extrai o callback REAL da app e prova que ele pede a revogação ao servidor,
// com o token, antes de o descartar. A revogação do lado do servidor (replay →
// 401) é provada no teste "REGRESSÃO: logout autenticado revoga o token…".
test("REGRESSÃO (cliente): o callback real pede ao servidor para revogar o token", () => {
  let stored = token;
  let user = { id: "synthetic-user" };
  const calls = [];
  const sandbox = {
    authGeneration: { current: 0 },
    restoreAbort: { current: null },
    setIsLoading() {},
    getAuthToken: () => stored,
    clearAuthSession: async () => { stored = null; },
    TOKEN_KEY: "fixture-token-key",
    API_BASE: base,
    localStorage: {
      getItem(key) { assert.equal(key, "fixture-token-key"); return stored; },
      removeItem(key) { assert.equal(key, "fixture-token-key"); stored = null; },
    },
    setUser(value) { user = value; },
    fetch(...args) { calls.push(args); return Promise.resolve({ ok: true }); },
  };
  vm.runInNewContext(`(() => {${callback[1]} })()`, sandbox, { timeout: 1000 });
  assert.equal(stored, null, "logout removes the local token");
  assert.equal(user, null, "logout clears UI identity");
  assert.equal(calls.length, 1, "o logout faz exatamente um pedido de revogação");
  assert.equal(calls[0][0], `${base}/auth/logout`, "o pedido é para /auth/logout");
  assert.equal(calls[0][1].method, "POST", "a revogação é um POST");
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${token}`, "o pedido leva o token em Bearer");
});
test("REGRESSÃO: token emitido tem sete dias de validade e identificador de sessão", () => {
  const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  assert.equal(payload.exp - payload.iat, 7 * 24 * 60 * 60);
  assert.equal(typeof payload.jti, "string");
  assert.match(payload.jti, /^[0-9a-f-]{36}$/);
});
test("REGRESSÃO: logout autenticado revoga o token sem eco e preserva outra sessão", async () => {
  const second = await fetch(`${base}/auth/login`, {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({email:"r6-l12@example.invalid", password:"fixture-only-password"}),
  });
  assert.equal(second.status, 200);
  const secondToken = (await second.json()).token;
  // Distinct-session assertion follows the endpoint contract to expose both defects.
  const response = await fetch(`${base}/auth/logout`, {method:"POST", headers:{Authorization:`Bearer ${token}`}});
  assert.equal(response.status, 204);
  assert.ok(secondToken !== token, "sessões emitidas separadamente têm identidade própria");
  assert.equal(await response.text(), "");
  assert.equal((await request(`Bearer ${token}`)).status, 401);
  assert.equal((await request(`Bearer ${secondToken}`)).status, 200);
  const me = await fetch(`${base}/auth/me`, {headers:{Authorization:`Bearer ${token}`}});
  assert.equal(me.status, 401);
});
test("REGRESSÃO: logout sem autenticação é recusado", async () => {
  const response = await fetch(`${base}/auth/logout`, {method:"POST"});
  assert.equal(response.status, 401);
});
test("regressão: logout recusa token inválido ou expirado sem eco", async () => {
  const sub = jwt.decode(token).sub;
  const expired = jwt.sign({sub}, process.env.JWT_SECRET, {algorithm:"HS256", expiresIn:-1});
  for (const candidate of ["r6-l12-invalid-fixture", expired]) {
    const response = await fetch(`${base}/auth/logout`, {method:"POST", headers:{Authorization:`Bearer ${candidate}`}});
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes(candidate));
  }
});
test("regressão: JWT legado válido sem jti também pode ser revogado", async () => {
  const sub = jwt.decode(token).sub;
  const legacy = jwt.sign({sub}, process.env.JWT_SECRET, {algorithm:"HS256", expiresIn:60});
  assert.equal((await request(`Bearer ${legacy}`)).status, 200);
  const response = await fetch(`${base}/auth/logout`, {method:"POST", headers:{Authorization:`Bearer ${legacy}`}});
  assert.equal(response.status, 204);
  assert.equal((await request(`Bearer ${legacy}`)).status, 401);
});
test("regressão: token sem prazo não cria revogação sem expiração", async () => {
  const sub = jwt.decode(token).sub;
  const noDeadline = jwt.sign({sub, jti:"fixture-no-exp"}, process.env.JWT_SECRET, {algorithm:"HS256"});
  const response = await fetch(`${base}/auth/logout`, {method:"POST", headers:{Authorization:`Bearer ${noDeadline}`}});
  assert.equal(response.status, 401);
});