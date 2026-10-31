import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Synthetic fixtures only; all provider traffic stays on loopback.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-r6-l10-"));
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
process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = temp;
process.env.CYBERSAFE_API_PORT = "4198";
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
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("cybersafe-r6-l10-"));
  fs.rmSync(temp, { recursive: true, force: true });
});
const syntheticSecret = "api_key=R6_SYNTHETIC_VALUE_NOT_A_REAL_CREDENTIAL";
async function chat(payload) {
  return fetch(`${base}/api/ai/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

const variants = [
  ["fragmentação entre mensagens", { messages: [{ role: "user", content: "api_" }, { role: "user", content: "key=R6_SYNTHETIC_VALUE_NOT_A_REAL_CREDENTIAL" }] }, "credential_blocked"],
  ["fragmentação página/contexto", { messages: [], page: "api_", context: "key=R6_SYNTHETIC_VALUE_NOT_A_REAL_CREDENTIAL" }, "credential_blocked"],
  ["normalização no contexto", { messages: [], context: "ａｐｉ＿\u200bｋｅｙ＝R6_SYNTHETIC_VALUE_NOT_A_REAL_CREDENTIAL" }, "credential_blocked"],
  ["NFKC", { messages: [{ role: "user", content: "ａｐｉ＿ｋｅｙ＝R6_SYNTHETIC_VALUE_NOT_A_REAL_CREDENTIAL" }] }, "credential_blocked"],
  ["zero-width", { messages: [{ role: "user", content: "api_\u200bkey=R6_SYNTHETIC_VALUE_NOT_A_REAL_CREDENTIAL" }] }, "credential_blocked"],
  ["maiúsculas", { messages: [{ role: "user", content: "API_KEY=R6_SYNTHETIC_VALUE_NOT_A_REAL_CREDENTIAL" }] }, "credential_blocked"],
  ["content profundamente aninhado", { messages: [{ role: "user", content: Array.from({length: 40}).reduce(value => ({ nested: value }), syntheticSecret) }] }, "invalid_request"],
  ["context aninhado", { messages: [], context: { nested: [syntheticSecret] } }, "invalid_request"],
];
for (const stream of [false, true]) {
  for (const [name, payload, code] of variants) {
    test(`${stream ? "SSE" : "JSON"}: ${name}`, async () => {
      const count = received.length;
      const logs = [];
      const originals = [console.log, console.warn, console.error];
      let response;
      try {
        console.log = console.warn = console.error = (...args) => logs.push(args.join(" "));
        response = await chat({ ...payload, stream });
      } finally {
        [console.log, console.warn, console.error] = originals;
      }
      assert.ok(!logs.join("\n").includes("R6_SYNTHETIC"), "logs sem segredo sintético");
      const body = await response.text();
      assert.equal(received.length, count, "zero chamadas ao fornecedor antes da validação");
      assert.equal(response.status, 400);
      assert.equal(JSON.parse(body).code, code);
      assert.ok(!body.includes("R6_SYNTHETIC"), "erro sem eco de dados");
    });
  }
  test(`${stream ? "SSE" : "JSON"}: texto permitido preservado`, async () => {
    const count = received.length;
    const content = "Análise rápida: memória e disco disponíveis.";
    const response = await chat({ stream, messages: [{role: "user", content}], context: "Painel local", page: "Proteção" });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(received.length, count + 1);
    assert.equal(received.at(-1).messages.at(-1).content, content);
  });
}
test("sem autorização não chega ao fornecedor", async () => {
  const count = received.length;
  const response = await fetch(`${base}/api/ai/chat`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({messages: [{role:"user",content:syntheticSecret}]}) });
  const body = await response.text();
  assert.equal(response.status, 401);
  assert.equal(received.length, count);
  assert.ok(!body.includes("R6_SYNTHETIC"));
});