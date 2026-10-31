import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// ── TP-MATRIX-R2-CONSENT — quem autoriza é o servidor ──
//
// Prova central: com autorização inválida o código NUNCA chega ao fornecedor. O
// fornecedor é um servidor HTTP local DESTE ficheiro que conta os corpos
// recebidos — não um mock de função, não o Groq. Cada caso compara o contador
// antes/depois: 0 é zero pedidos reais, +1 é exactamente um.
//
// DB em %TEMP% isolada, segredo próprio da fixture, sem bind à porta 4000.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-r2-consent-"));
const dbPath = path.join(tmpDir, "cybersafe.db");

const corposRecebidos = [];
// Falha PERSISTENTE do fornecedor: o SDK do fornecedor repete 5xx, e uma falha de
// uma vez só provaria que o retry funciona, não que a falha é reportada.
let falharSempreComStatus = null;
const fornecedor = http.createServer(async (req, res) => {
  let texto = "";
  for await (const chunk of req) texto += chunk;
  let corpo;
  try { corpo = JSON.parse(texto); } catch { corpo = texto; }
  corposRecebidos.push({ url: req.url, corpo });
  if (falharSempreComStatus !== null) {
    res.writeHead(falharSempreComStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream unavailable" } }));
    return;
  }
  if (corpo && corpo.stream === true) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Resposta sintética R2." } }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "Resposta sintética R2." } }] }));
});
await new Promise((r) => fornecedor.listen(0, "127.0.0.1", r));

process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = tmpDir;
process.env.CYBERSAFE_DB_PATH = dbPath;
process.env.CYBERSAFE_API_PORT = "4159";
process.env.CYBERSAFE_API_NO_LISTEN = "1";
process.env.CYBERSAFE_AI_PROVIDER = "synthetic";
process.env.CYBERSAFE_AI_BASE_URL = `http://127.0.0.1:${fornecedor.address().port}/v1`;
process.env.CYBERSAFE_AI_MODEL = "synthetic-model";
process.env.CYBERSAFE_AI_API_KEY = "synthetic-provider-key-not-a-secret";
process.env.NODE_ENV = "test";
const TEST_SECRET = `r2-consent-fixture-${crypto.randomUUID()}`;
process.env.JWT_SECRET = TEST_SECRET;

const { closeDb, getDb } = await import("../dist/db.js");
const { ONE_SHOT_TTL_SECONDS, descriptorActual } = await import("../dist/process-consent.js");
const { app } = await import("../dist/index.js");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const ISO = "2026-10-14T10:00:00.000Z";
const alvo = (pid = 500, startedAt = ISO, name = "fixture.exe") => ({ pid, name, startedAt, cpuPercent: 10, workingSetMb: 100 });
const contexto = (selected = alvo()) => ({
  version: 1,
  measuredAt: "2026-10-14T11:00:00.000Z",
  ram: { totalMb: 16000, usedMb: 8000, availableMb: 8000 },
  cpuPercent: 40,
  topProcesses: [alvo()],
  selectedProcess: selected,
  trends: [],
  limitations: ["Working Set não é memória privada."],
});

let server;
let baseUrl;
const tokens = {};

async function registe(email, name) {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "password123", type: "personal", plan: "free" }),
  });
  assert.equal(res.status, 201, `fixture: registo ${email}`);
  const json = await res.json();
  return { token: json.token, userId: json.user.id };
}

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokens.a = await registe("r2-a@cybersafe.local", "R2 A");
  tokens.b = await registe("r2-b@cybersafe.local", "R2 B");
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fornecedor.close(resolve));
  closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  catch (err) { process.emitWarning(`R2 TMPDIR LEAK: ${tmpDir} (${err.code})`); }
});

const call = (method, route, { body, token } = {}) =>
  fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const rota = (method, route, body, dono = "a") => call(method, route, { body, token: tokens[dono].token });
const chat = (body, dono = "a") => rota("POST", "/api/ai/chat", {
  messages: [{ role: "user", content: "porque é que este processo consome memória?" }], ...body,
}, dono);
const descriptor = () => descriptorActual();
const pedidos = () => corposRecebidos.length;

/** O que a UI envia para pedir autorização de UM envio. */
const corpoUnico = (target = alvo()) => {
  const d = descriptor();
  return { providerKey: d.providerKey, purpose: d.purpose, fields: d.fields, target: { pid: target.pid, startedAt: target.startedAt } };
};
async function autorizarUmEnvio(target = alvo(), dono = "a") {
  const res = await rota("POST", "/api/ai/process-consent/one-shot", corpoUnico(target), dono);
  const texto = await res.text();
  assert.equal(res.status, 200, `autorização única devia ser emitida (${res.status}: ${texto})`);
  return JSON.parse(texto).authorization;
}
async function criarGrantPersistente(dono = "a") {
  const d = descriptor();
  const res = await rota("POST", "/api/ai/process-consent", {
    providerKey: d.providerKey, purpose: d.purpose, fields: d.fields,
    allowFutureProcesses: true, persistent: true,
  }, dono);
  assert.equal(res.status, 200, `grant devia ser criado (${res.status})`);
  return (await res.json()).grant;
}
const linhaDoToken = (token) =>
  getDb().prepare("SELECT * FROM process_consent_one_shots WHERE tokenHash = ?").get(sha(token));

// ════════════════════════════════════════════════════════════════════════
// A — sem autorização válida o código nunca chega ao fornecedor
// ════════════════════════════════════════════════════════════════════════
describe("A — sem autorização o código nunca chega ao fornecedor", () => {
  test("A1 `processConsent: true` do cliente já NÃO autoriza (defeito R1)", async () => {
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), processConsent: true });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "process_consent_missing");
    assert.equal(pedidos(), antes, "ZERO pedidos ao fornecedor");
  });

  test("A2 flag a true e a false dão o mesmo: nada", async () => {
    const antes = pedidos();
    for (const flag of [true, false]) {
      assert.equal((await chat({ processIntelligence: contexto(), processConsent: flag })).status, 400);
    }
    assert.equal(pedidos(), antes);
  });

  test("A3 token com forma inválida → 403, zero pedidos", async () => {
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentAuthorization: "nao-e-um-token" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_authorization_invalid");
    assert.equal(pedidos(), antes);
  });

  test("A4 token e grant inventados → 403, zero pedidos", async () => {
    const antes = pedidos();
    const unica = await chat({ processIntelligence: contexto(), consentAuthorization: crypto.randomUUID() });
    assert.equal(unica.status, 403);
    assert.equal((await unica.json()).code, "process_consent_authorization_invalid");
    const grant = await chat({ processIntelligence: contexto(), consentGrantId: crypto.randomUUID() });
    assert.equal(grant.status, 403);
    assert.equal((await grant.json()).code, "process_consent_grant_invalid");
    assert.equal(pedidos(), antes);
  });

  test("A6 o transporte SSE segue a mesma decisão: flag sozinha não autoriza", async () => {
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), processConsent: true, stream: true });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "process_consent_missing");
    assert.equal(pedidos(), antes, "nem o caminho de streaming abre o fornecedor");
  });

  test("A5 dois canais no mesmo pedido → 400 ambíguo, nenhum é escolhido", async () => {
    const g = await criarGrantPersistente();
    const a = await autorizarUmEnvio();
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentGrantId: g.id, consentAuthorization: a.token });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "process_consent_ambiguous");
    assert.equal(pedidos(), antes);
  });
});

// ════════════════════════════════════════════════════════════════════════
// B — autorização única válida: exactamente um pedido
// ════════════════════════════════════════════════════════════════════════
describe("B — autorização única válida permite um pedido", () => {
  test("B1 token novo → 200 e exactamente 1 pedido", async () => {
    const a = await autorizarUmEnvio();
    assert.match(a.token, /^[0-9a-f-]{36}$/i);
    assert.equal(a.ttlSeconds, ONE_SHOT_TTL_SECONDS);
    assert.ok(Date.parse(a.expiresAt) > Date.now());
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentAuthorization: a.token });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mode, "online");
    assert.equal(pedidos(), antes + 1, "exactamente UM pedido");
  });

  test("B2 o que chega ao fornecedor é o bloco medido, sem campos fora do âmbito", async () => {
    const a = await autorizarUmEnvio();
    await chat({ processIntelligence: contexto(), consentAuthorization: a.token });
    const enviado = JSON.stringify(corposRecebidos.at(-1));
    assert.match(enviado, /FACTO MEDIDO/);
    assert.match(enviado, /fixture\.exe/);
    assert.doesNotMatch(enviado, /commandLine|privateProcessData/i);
    assert.ok(!enviado.includes(TEST_SECRET), "o segredo da sessão nunca viaja");
    assert.ok(!enviado.includes("synthetic-provider-key-not-a-secret"), "a chave do fornecedor nunca viaja");
  });

  test("B3 o token não fica em claro na base", async () => {
    const a = await autorizarUmEnvio();
    const linha = linhaDoToken(a.token);
    assert.ok(linha);
    assert.equal(linha.tokenHash, sha(a.token));
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM process_consent_one_shots WHERE tokenHash = ?").get(a.token).n, 0);
  });

  test("B4 a tabela não tem colunas para métricas, texto ou segredos", () => {
    const colunas = getDb().prepare("PRAGMA table_info(process_consent_one_shots)").all().map((c) => c.name);
    for (const proibida of ["workingSetMb", "cpuPercent", "ram", "messages", "content", "apiKey", "token"]) {
      assert.ok(!colunas.includes(proibida), `coluna proibida: ${proibida}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// C — a autorização única vale um envio
// ════════════════════════════════════════════════════════════════════════
describe("C — a autorização única vale um envio", () => {
  test("C1 reutilizar o token → 403 `..._used`, zero pedidos novos", async () => {
    const a = await autorizarUmEnvio();
    assert.equal((await chat({ processIntelligence: contexto(), consentAuthorization: a.token })).status, 200);
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentAuthorization: a.token });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_authorization_used");
    assert.equal(pedidos(), antes);
  });

  test("C2 pedir autorização duas vezes invalida a primeira", async () => {
    const primeira = await autorizarUmEnvio();
    await autorizarUmEnvio();
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentAuthorization: primeira.token });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_authorization_invalid");
    assert.equal(pedidos(), antes);
  });
});

// ════════════════════════════════════════════════════════════════════════
// D — grant persistente
// ════════════════════════════════════════════════════════════════════════
describe("D — o grant persistente autoriza envios futuros", () => {
  test("D1 grant válido → 200 e um pedido", async () => {
    const g = await criarGrantPersistente();
    const antes = pedidos();
    assert.equal((await chat({ processIntelligence: contexto(), consentGrantId: g.id })).status, 200);
    assert.equal(pedidos(), antes + 1);
  });

  test("D2 o mesmo grant serve vários envios", async () => {
    const g = await criarGrantPersistente();
    const antes = pedidos();
    for (const pid of [500, 501]) {
      assert.equal((await chat({ processIntelligence: contexto(alvo(pid)), consentGrantId: g.id })).status, 200);
    }
    assert.equal(pedidos(), antes + 2);
  });

  test("D3 sem `processConsent` no pedido continua a autorizar (a flag não é a autoridade)", async () => {
    const g = await criarGrantPersistente();
    assert.equal((await chat({ processIntelligence: contexto(), consentGrantId: g.id })).status, 200);
    assert.ok(!JSON.stringify(corposRecebidos.at(-1)).includes("processConsent"));
  });

  test("D4 o caminho de streaming continua a levar a telemetria autorizada", async () => {
    const g = await criarGrantPersistente();
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentGrantId: g.id, stream: true });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Resposta sintética R2/);
    assert.equal(pedidos(), antes + 1);
    assert.match(JSON.stringify(corposRecebidos.at(-1)), /FACTO MEDIDO/);
  });
});
// ════════════════════════════════════════════════════════════════════════
// E — expirado ou revogado não envia
// ════════════════════════════════════════════════════════════════════════
describe("E — expirado ou revogado não envia", () => {
  test("E1 DELETE revoga o grant e bloqueia envios novos", async () => {
    const g = await criarGrantPersistente();
    assert.equal((await rota("DELETE", "/api/ai/process-consent")).status, 200);
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentGrantId: g.id });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_grant_invalid");
    assert.equal(pedidos(), antes);
  });

  test("E2 DELETE também mata uma autorização única por consumir", async () => {
    const a = await autorizarUmEnvio();
    const del = await rota("DELETE", "/api/ai/process-consent");
    assert.equal(del.status, 200);
    assert.ok((await del.json()).revokedOneShots >= 1, "a revogação alcança o que estava pendente");
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentAuthorization: a.token });
    assert.equal(res.status, 403);
    assert.equal(pedidos(), antes);
  });

  test("E3 grant expirado → 403 `..._expired` e marcado como revogado", async () => {
    const g = await criarGrantPersistente();
    getDb().prepare("UPDATE process_consent_grants SET createdAt = ?, expiresAt = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z", g.id);
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentGrantId: g.id });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_expired");
    assert.equal(pedidos(), antes);
    assert.ok(getDb().prepare("SELECT revokedAt FROM process_consent_grants WHERE id = ?").get(g.id).revokedAt);
  });

  test("E4 autorização única expirada → 403 `authorization_expired`", async () => {
    const a = await autorizarUmEnvio();
    getDb().prepare("UPDATE process_consent_one_shots SET createdAt = ?, expiresAt = ? WHERE tokenHash = ?")
      .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z", sha(a.token));
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentAuthorization: a.token });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_authorization_expired");
    assert.equal(pedidos(), antes);
  });
});

// ════════════════════════════════════════════════════════════════════════
// F — conta e fornecedor
// ════════════════════════════════════════════════════════════════════════
describe("F — outra conta ou outro fornecedor não herdam autorização", () => {
  test("F1 grant da conta A usado pela conta B → 403, zero pedidos", async () => {
    const g = await criarGrantPersistente("a");
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentGrantId: g.id }, "b");
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_grant_invalid");
    assert.equal(pedidos(), antes);
  });

  test("F2 `consentProviderKey` de outro fornecedor nega, mesmo com grant válido", async () => {
    const g = await criarGrantPersistente();
    const antes = pedidos();
    const res = await chat({
      processIntelligence: contexto(), consentGrantId: g.id, consentProviderKey: sha("outro-fornecedor"),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_provider_mismatch");
    assert.equal(pedidos(), antes);
  });

  test("F3 grant cujo fornecedor registado já não é o actual → negado pelo servidor", async () => {
    const g = await criarGrantPersistente();
    getDb().prepare("UPDATE process_consent_grants SET providerKey = ? WHERE id = ?").run(sha("fornecedor-antigo"), g.id);
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentGrantId: g.id });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_provider_mismatch");
    assert.equal(pedidos(), antes);
  });

  test("F4 emitir autorização com fornecedor não actual → 403 (não nasce autorização errada)", async () => {
    const res = await rota("POST", "/api/ai/process-consent/one-shot", { ...corpoUnico(), providerKey: sha("fornecedor-antigo") });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_provider_mismatch");
  });
});

// ════════════════════════════════════════════════════════════════════════
// G — alvo e âmbito
// ════════════════════════════════════════════════════════════════════════
describe("G — a autorização é deste alvo, não de qualquer processo", () => {
  test("G1 autorização para o pid 500 não serve o pid 777 → 403 target_mismatch", async () => {
    const a = await autorizarUmEnvio(alvo(500));
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(alvo(777)), consentAuthorization: a.token });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_target_mismatch");
    assert.equal(pedidos(), antes);
  });

  test("G2 mesmo pid com outro início (pid reciclado) também não serve", async () => {
    const a = await autorizarUmEnvio(alvo(500, ISO));
    const res = await chat({
      processIntelligence: contexto(alvo(500, "2026-10-15T09:00:00.000Z")), consentAuthorization: a.token,
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_target_mismatch");
  });

  test("G3 alvo errado não queima a autorização: com o alvo certo envia uma vez", async () => {
    const a = await autorizarUmEnvio(alvo(500));
    assert.equal((await chat({ processIntelligence: contexto(alvo(777)), consentAuthorization: a.token })).status, 403);
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(alvo(500)), consentAuthorization: a.token });
    assert.equal(res.status, 200);
    assert.equal(pedidos(), antes + 1);
  });

  test("G4 pedido sem `selectedProcess` não serve um alvo autorizado", async () => {
    const a = await autorizarUmEnvio(alvo(500));
    const res = await chat({ processIntelligence: contexto(null), consentAuthorization: a.token });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_target_mismatch");
  });

  test("G5 campos ou finalidade fora do âmbito → 403 scope_changed", async () => {
    const d = descriptor();
    for (const corpo of [
      { ...corpoUnico(), fields: [...d.fields, "commandLine"] },
      { ...corpoUnico(), fields: d.fields.filter((f) => f !== "limitations") },
      { ...corpoUnico(), purpose: "outra-finalidade:v1" },
    ]) {
      const res = await rota("POST", "/api/ai/process-consent/one-shot", corpo);
      assert.equal(res.status, 403, JSON.stringify(corpo));
      assert.equal((await res.json()).code, "process_consent_scope_changed");
    }
  });

  test("G6 corpo do pedido de autorização fora de forma → 400", async () => {
    const d = descriptor();
    for (const corpo of [
      { ...corpoUnico(), extra: 1 },
      { providerKey: d.providerKey, purpose: d.purpose, fields: d.fields },
      { ...corpoUnico(), target: { pid: 500 } },
      { ...corpoUnico(), target: { pid: -1, startedAt: ISO } },
      { ...corpoUnico(), target: { pid: 500, startedAt: "ontem" } },
    ]) {
      const res = await rota("POST", "/api/ai/process-consent/one-shot", corpo);
      assert.equal(res.status, 400, JSON.stringify(corpo));
      assert.equal((await res.json()).code, "invalid_request");
    }
  });

  test("G7 payload mal formado com autorização válida → recusa, zero pedidos", async () => {
    const a = await autorizarUmEnvio();
    const antes = pedidos();
    const res = await chat({ processIntelligence: { ...contexto(), path: "privado" }, consentAuthorization: a.token });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "process_context_invalid");
    assert.equal(pedidos(), antes);
  });

  // ── TP-MATRIX-R2-CONSENT-REVIEW (achado Codex) ──
  // O alvo autorizado é A, mas o validador central aceita até 5 topProcesses e
  // trends de qualquer um deles. Sem esta regra, um token para A podia levar as
  // medições de B dentro do MESMO pedido: a autorização única alargava-se sozinha.
  const outroProcesso = { pid: 777, name: "outro.exe", startedAt: "2026-10-14T09:00:00.000Z", cpuPercent: 5, workingSetMb: 50 };
  const tendencia = (p) => ({
    pid: p.pid, startedAt: p.startedAt, previousMb: 40, currentMb: 50, deltaMb: 10,
    intervalMs: 60_000, samples: 3,
  });

  test("G8 token para A não leva medições de B em topProcesses (recusa, zero pedidos)", async () => {
    const a = await autorizarUmEnvio(alvo(500));
    const antes = pedidos();
    const intruso = {
      ...contexto(alvo(500)),
      topProcesses: [alvo(500), outroProcesso],
      trends: [tendencia(outroProcesso)],
    };
    const res = await chat({ processIntelligence: intruso, consentAuthorization: a.token });
    assert.equal(res.status, 403, "medição de outro processo não cabe na autorização de A");
    assert.equal((await res.json()).code, "process_consent_payload_out_of_scope");
    assert.equal(pedidos(), antes, "ZERO pedidos ao fornecedor");
  });

  test("G9 nem um único topProcess a mais passa", async () => {
    const a = await autorizarUmEnvio(alvo(500));
    const antes = pedidos();
    const res = await chat({
      processIntelligence: { ...contexto(alvo(500)), topProcesses: [alvo(500), outroProcesso] },
      consentAuthorization: a.token,
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_payload_out_of_scope");
    assert.equal(pedidos(), antes);
  });

  test("G10 medição estreitada ao alvo autorizado continua a passar (ram/cpu globais incluídos)", async () => {
    const a = await autorizarUmEnvio(alvo(500));
    const antes = pedidos();
    const res = await chat({
      processIntelligence: { ...contexto(alvo(500)), topProcesses: [alvo(500)], trends: [tendencia(alvo(500))] },
      consentAuthorization: a.token,
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(pedidos(), antes + 1);
  });

  // ── Ordem: forma e payload são decididos ANTES do consumo ──
  test("G11 payload inválido NÃO queima a autorização; o mesmo token serve depois", async () => {
    const a = await autorizarUmEnvio(alvo(500));
    const antes = pedidos();
    const mau = await chat({ processIntelligence: { ...contexto(), path: "privado" }, consentAuthorization: a.token });
    assert.equal(mau.status, 400);
    const bom = await chat({ processIntelligence: contexto(alvo(500)), consentAuthorization: a.token });
    assert.equal(bom.status, 200, "um pedido recusado não pode consumir a autorização");
    assert.equal(pedidos(), antes + 1);
  });

  test("G12 `messages` fora de forma NÃO queima a autorização", async () => {
    const a = await autorizarUmEnvio(alvo(500));
    const antes = pedidos();
    const mau = await rota("POST", "/api/ai/chat", {
      messages: "isto não é uma lista", processIntelligence: contexto(alvo(500)), consentAuthorization: a.token,
    });
    assert.equal(mau.status, 400);
    assert.equal((await mau.json()).code, "invalid_request");
    assert.equal(pedidos(), antes);
    const bom = await chat({ processIntelligence: contexto(alvo(500)), consentAuthorization: a.token });
    assert.equal(bom.status, 200);
    assert.equal(pedidos(), antes + 1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// H — chat geral sem telemetria continua a funcionar
// ════════════════════════════════════════════════════════════════════════
describe("H — o chat geral não depende de telemetria nem de consentimento", () => {
  test("H1 sem `processIntelligence` → 200 e nada de processos no que sai", async () => {
    const antes = pedidos();
    assert.equal((await chat({})).status, 200);
    assert.equal(pedidos(), antes + 1);
    const enviado = JSON.stringify(corposRecebidos.at(-1));
    assert.doesNotMatch(enviado, /FACTO MEDIDO/);
    assert.doesNotMatch(enviado, /fixture\.exe/);
  });

  test("H2 com grant existente mas sem medição → não injeta telemetria", async () => {
    const g = await criarGrantPersistente();
    assert.equal((await chat({ consentGrantId: g.id })).status, 200);
    assert.doesNotMatch(JSON.stringify(corposRecebidos.at(-1)), /FACTO MEDIDO/);
  });

  test("H3 flag antiga no chat geral é ignorada, não é erro", async () => {
    assert.equal((await chat({ processConsent: true })).status, 200);
  });
});

// ════════════════════════════════════════════════════════════════════════
// I — falhas reportadas como falhas
// ════════════════════════════════════════════════════════════════════════
describe("I — falhas são reportadas como falhas", () => {
  test("I1 sem sessão → 401 e zero pedidos", async () => {
    const antes = pedidos();
    const res = await call("POST", "/api/ai/chat", { body: { messages: [], processIntelligence: contexto() } });
    assert.equal(res.status, 401);
    assert.equal(pedidos(), antes);
  });

  test("I2 falha do fornecedor não vira sucesso nem `mode: online`", async () => {
    falharSempreComStatus = 500;
    try {
      const res = await chat({});
      assert.equal(res.status, 503);
      const json = await res.json();
      assert.equal(json.code, "provider_unavailable");
      assert.ok(!("mode" in json), "sem `mode` não há como a UI anunciar online");
      assert.doesNotMatch(JSON.stringify(json), /synthetic-provider-key-not-a-secret/);
    } finally {
      falharSempreComStatus = null;
    }
  });

  test("I3 autorização consumida não deixa o pedido passar por outra via", async () => {
    const a = await autorizarUmEnvio();
    assert.equal((await chat({ processIntelligence: contexto(), consentAuthorization: a.token })).status, 200);
    const antes = pedidos();
    const res = await chat({ processIntelligence: contexto(), consentAuthorization: a.token, processConsent: true });
    assert.equal(res.status, 403);
    assert.equal(pedidos(), antes);
  });
});

// ════════════════════════════════════════════════════════════════════════
// J — continuidade de conversa
// ════════════════════════════════════════════════════════════════════════
describe("J — a conversa continua sem regressão", () => {
  test("J1 segundo turno leva o histórico todo e a telemetria autorizada", async () => {
    const g = await criarGrantPersistente();
    const m1 = { role: "user", content: "primeira pergunta" };
    const r1 = await rota("POST", "/api/ai/chat", { messages: [m1], processIntelligence: contexto(), consentGrantId: g.id });
    assert.equal(r1.status, 200);
    const conversa = [m1, { role: "assistant", content: "primeira resposta" }, { role: "user", content: "segunda pergunta" }];
    const r2 = await rota("POST", "/api/ai/chat", { messages: conversa, processIntelligence: contexto(), consentGrantId: g.id });
    assert.equal(r2.status, 200);
    const enviado = corposRecebidos.at(-1).corpo;
    const enviadas = enviado.messages.map((m) => m.content);
    // A persona Matrix entra como primeira mensagem de sistema: o teste conta o
    // HISTÓRICO, não a persona, e verifica que nada foi cortado nem reordenado.
    assert.equal(enviadas.filter((c) => c === "primeira pergunta").length, 1);
    assert.equal(enviadas.filter((c) => c === "primeira resposta").length, 1);
    assert.equal(enviadas.filter((c) => c === "segunda pergunta").length, 1);
    assert.equal(enviadas.at(-1), "segunda pergunta");
    assert.ok(enviadas.indexOf("primeira pergunta") < enviadas.indexOf("primeira resposta"));
    assert.ok(enviadas.indexOf("primeira resposta") < enviadas.indexOf("segunda pergunta"));
    assert.match(JSON.stringify(enviado), /FACTO MEDIDO/);
  });

  test("J2 respostas consecutivas não duplicam o bloco medido", async () => {
    const g = await criarGrantPersistente();
    await chat({ processIntelligence: contexto(), consentGrantId: g.id });
    await chat({ processIntelligence: contexto(), consentGrantId: g.id });
    const enviado = JSON.stringify(corposRecebidos.at(-1));
    assert.equal(enviado.split("FACTO MEDIDO").length - 1, 1, "um bloco por pedido, não dois");
  });
});
