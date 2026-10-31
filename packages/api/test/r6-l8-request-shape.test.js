import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// R6-L8 — testes NEGATIVOS da validação de forma do pedido (P0 privacidade).
// Fixtures sintéticas apenas; todo o tráfego de fornecedor fica em loopback.
// Nenhuma credencial real. Nenhum servidor de produto na porta 4000/5173.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-r6-l8-shape-"));
const received = [];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
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
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = temp;
process.env.CYBERSAFE_API_PORT = "4201";
process.env.CYBERSAFE_DB_PATH = path.join(temp, "fixture.db");
process.env.CYBERSAFE_API_NO_LISTEN = "1";
process.env.JWT_SECRET = "r6-l8-isolated-fixture-signing-key-not-a-real-secret";
process.env.CYBERSAFE_AI_API_KEY = "r6-l8-fake-provider-key";
process.env.CYBERSAFE_AI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;
const { app } = await import("../dist/index.js");
const { closeDb } = await import("../dist/db.js");
let server, base, token;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "R6 L8 fixture", email: "r6-l8-fixture@example.invalid", password: "fixture-only-password", type: "personal" }),
  });
  assert.equal(response.status, 201);
  token = (await response.json()).token;
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
async function chat(payload) {
  return fetch(`${base}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

// Cada caso é um pedido que NUNCA pode chegar ao fornecedor.
const MALFORMADOS = [
  ["messages nao-lista (texto)", { messages: "isto nao e uma lista" }],
  ["content numerico", { messages: [{ role: "user", content: 12345 }] }],
  ["content objeto", { messages: [{ role: "user", content: { aninhado: "valor" } }] }],
  ["content lista sem segredo", { messages: [{ role: "user", content: ["texto solto"] }] }],
  ["entrada nula na lista", { messages: [{ role: "user", content: "ok" }, null] }],
  ["entrada que e lista", { messages: [[{ role: "user", content: "ok" }]] }],
  ["context numerico", { messages: [{ role: "user", content: "ok" }], context: 42 }],
  ["context lista", { messages: [{ role: "user", content: "ok" }], context: ["memoria"] }],
  ["page objeto", { messages: [{ role: "user", content: "ok" }], page: { pagina: "dashboard" } }],
  ["page lista", { messages: [{ role: "user", content: "ok" }], page: ["dashboard"] }],
];

for (const stream of [false, true]) {
  const modo = stream ? "SSE" : "JSON";
  for (const [nome, payload] of MALFORMADOS) {
    test(`${modo}: recusa ${nome} com 400 estavel e zero chamadas upstream`, async () => {
      const count = received.length;
      const response = await chat({ ...payload, stream });
      const texto = await response.text();
      assert.equal(response.status, 400, "erro estavel 400");
      assert.equal(received.length, count, "nenhum pedido malformado pode chegar ao fornecedor");
      const corpo = JSON.parse(texto);
      assert.equal(corpo.code, "invalid_request");
      // A recusa nunca ecoa o que foi enviado.
      assert.ok(!texto.includes("isto nao e uma lista"), "a recusa nao pode ecoar o conteudo");
      assert.ok(!texto.includes("aninhado"), "a recusa nao pode ecoar o conteudo");
      assert.ok(!texto.includes("memoria"), "a recusa nao pode ecoar o conteudo");
      assert.equal(typeof corpo.message, "string");
    });
  }

  test(`${modo}: controlo positivo — pedido bem formado continua a passar`, async () => {
    const count = received.length;
    const response = await chat({
      stream,
      context: "Memória disponível: leitura local",
      page: "Painel de proteção",
      messages: [{ role: "user", content: "Ajuda com o PC" }],
    });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(received.length, count + 1, "o pedido valido tem de chegar ao fornecedor");
  });

  test(`${modo}: limites — lista de mensagens acima do maximo e recusada sem truncar`, async () => {
    const count = received.length;
    const muitas = Array.from({ length: 501 }, () => ({ role: "user", content: "ok" }));
    const response = await chat({ stream, messages: muitas });
    const texto = await response.text();
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(texto).code, "invalid_request");
    assert.equal(received.length, count, "nada enviado upstream");
  });

  test(`${modo}: 500 mensagens (limite) nao sao recusadas pela contagem`, async () => {
    const count = received.length;
    const limite = Array.from({ length: 500 }, () => ({ role: "user", content: "ok" }));
    const response = await chat({ stream, messages: limite });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(received.length, count + 1);
  });
}
