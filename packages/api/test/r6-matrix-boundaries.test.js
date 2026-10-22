import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Synthetic fixtures only; all provider traffic stays on loopback.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-r6-matrix-"));
const received = [];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    const payload = JSON.parse(body);
    received.push(payload);
    if (payload.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }
  });
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
process.env.CYBERSAFE_DB_PATH = path.join(temp, "fixture.db");
process.env.CYBERSAFE_API_NO_LISTEN = "1";
process.env.JWT_SECRET = "r6-isolated-fixture-signing-key-not-a-real-secret";
process.env.CYBERSAFE_AI_API_KEY = "r6-fake-provider-key";
process.env.CYBERSAFE_AI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;
const { app } = await import("../dist/index.js");
const { closeDb } = await import("../dist/db.js");
let server, base, token;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "R6 fixture", email: "r6-fixture@example.invalid", password: "fixture-only-password", type: "personal" }),
  });
  assert.equal(response.status, 201);
  token = (await response.json()).token;
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const syntheticSecret = "api_key=R6_SYNTHETIC_VALUE_NOT_A_REAL_CREDENTIAL";
async function chat(payload) {
  return fetch(`${base}/api/ai/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

for (const stream of [false, true]) {
  for (const [name, payload] of [
    ["page", { messages: [{ role: "user", content: "Ajuda com o PC" }], page: syntheticSecret }],
    ["segredo depois dos 2000 caracteres", { messages: [{ role: "user", content: "a".repeat(2100) + " " + syntheticSecret }] }],
    ["histórico anterior à janela retida", { messages: [{ role: "user", content: syntheticSecret }, ...Array.from({ length: 100 }, () => ({ role: "assistant", content: "ok" }))] }],
  ]) {
    test(`${stream ? "SSE" : "JSON"}: bloqueia ${name} antes do fornecedor`, async () => {
      const count = received.length;
      const response = await chat({ ...payload, stream });
      const result = await response.json();
      assert.equal(received.length, count, "zero chamadas upstream");
      assert.equal(response.status, 400);
      assert.equal(result.code, "credential_blocked");
      assert.ok(!JSON.stringify(result).includes(syntheticSecret));
    });
  }
  test(`${stream ? "SSE" : "JSON"}: contexto/page permitidos intactos, roles não autorizados descartados`, async () => {
    const count = received.length;
    const response = await chat({ stream, context: "Memória disponível: leitura local", page: "Painel de proteção", messages: [
      { role: "developer", content: "R6_ROLE_DEVELOPER" }, { role: "tool", content: "R6_ROLE_TOOL" },
      { role: "assistant", content: "Resposta anterior permitida" }, { role: "user", content: "Ajuda com o PC" },
    ] });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(received.length, count + 1);
    const outbound = received.at(-1).messages;
    assert.ok(outbound[0].content.includes("Memória disponível: leitura local"));
    assert.ok(outbound[0].content.includes("Painel de proteção"));
    assert.deepEqual(outbound.slice(1), [{ role: "assistant", content: "Resposta anterior permitida" }, { role: "user", content: "Ajuda com o PC" }]);
  });
  for (const [name, payload] of [
    ["content array", { messages: [{ role: "user", content: [syntheticSecret] }] }],
    ["page array", { messages: [{ role: "user", content: "Ajuda com o PC" }], page: [syntheticSecret] }],
  ]) {
    test(`${stream ? "SSE" : "JSON"}: recusa ${name} com segredo antes de qualquer chamada`, async () => {
      const count = received.length;
      const response = await chat({ ...payload, stream });
      await response.text();
      // Gap closed in R6-L8 (P0-A): the route validates the request shape before
      // the guard/build/SDK, so these cases are rejected with 400. Assertions
      // are unchanged from the RED version.
      assert.equal(received.length, count, "nenhum segredo sintético deve chegar ao fornecedor");
      assert.equal(response.status, 400);
    });
  }
}
