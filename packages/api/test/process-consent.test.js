import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// ── TP-MATRIX-FINAL-CONSENT — grant persistente de explicações de processos ──
// DB em %TEMP% isolada, segredo próprio da fixture, sem bind à 4000 e SEM
// fornecedor configurado: os casos «passaram a autorização» terminam em
// `no_provider`, o que prova que a decisão foi tomada antes de qualquer chamada.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-consent-"));
const dbPath = path.join(tmpDir, "cybersafe.db");
// Modo DECLARADO como DEV isolado: a guarda do API recusa modo não declarado e
// exige raiz dedicada dentro do TEMP real, DB contida nessa raiz e porta isolada.
process.env.CYBERSAFE_DEV_ISOLATION = "1";
process.env.CYBERSAFE_DEV_ROOT = tmpDir;
process.env.CYBERSAFE_DB_PATH = dbPath;
process.env.CYBERSAFE_API_PORT = "4157";
process.env.CYBERSAFE_API_NO_LISTEN = "1";
process.env.CYBERSAFE_AI_PROVIDER = "testprovider";
process.env.CYBERSAFE_AI_BASE_URL = "https://api.example.test/v1";
process.env.NODE_ENV = "test";
// VAZIAS, não apagadas: `ai.ts` e `index.ts` correm `dotenv.config()` na
// importação e um `delete` faria o dotenv repor o valor. Com string vazia a cadeia
// de fallback do `AI_CONFIG.apiKey` fica em "" e `aiEnabled` é false.
process.env.CYBERSAFE_AI_API_KEY = "";
process.env.GROQ_API_KEY = "";
process.env.OPENAI_API_KEY = "";
// Segredo próprio da fixture (>=32 caracteres, aleatório): o API recusa segredo
// ausente, vazio, só espaços ou valor conhecido — nunca se herda o da instalação.
const TEST_SECRET = `test-secret-process-consent-${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.JWT_SECRET = TEST_SECRET;

const { closeDb } = await import("../dist/db.js");
const {
  PURPOSE, FIELDS_AUTORIZADOS, VALIDITY_DAYS, providerKeyDe, descriptorActual,
} = await import("../dist/process-consent.js");
const { app } = await import("../dist/index.js");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const UUIDv4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const alvo = (pid = 500, name = "fixture.exe") => ({
  pid, name, startedAt: "2026-10-14T10:00:00.000Z", cpuPercent: 10, workingSetMb: 100,
});
const contexto = () => ({
  version: 1,
  measuredAt: "2026-10-14T11:00:00.000Z",
  ram: { totalMb: 1000, usedMb: 500, availableMb: 500 },
  cpuPercent: 40,
  topProcesses: [alvo()],
  selectedProcess: alvo(),
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
  // Loopback EXPLÍCITO: `listen(0, cb)` aceitaria qualquer interface (`::`), e um
  // teste da superfície de autorização não pode ficar escutado numa rede local.
  // Mesma forma dos outros fixtures (`auth-api-guard`).
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokens.a = await registe("consent-a@cybersafe.local", "Consent A");
  tokens.b = await registe("consent-b@cybersafe.local", "Consent B");
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  catch (err) { process.emitWarning(`CONSENT TMPDIR LEAK: ${tmpDir} (${err.code})`); }
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
const chaveEsperada = () => providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/v1" });
const corpoEscolha = () => ({
  providerKey: chaveEsperada(), purpose: PURPOSE, fields: FIELDS_AUTORIZADOS,
  allowFutureProcesses: true, persistent: true,
});

describe("descriptor — derivado do ambiente, nunca de segredos", () => {
  test("GET devolve descriptor com providerKey/purpose/fields/installationId/validityDays", async () => {
    const res = await rota("GET", "/api/ai/process-consent");
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.descriptor.providerKey, chaveEsperada(), "providerKey = sha256(provider+endpoint canónico)");
    assert.equal(json.descriptor.purpose, "matrix-process-explanation:v1");
    assert.deepEqual(json.descriptor.fields, FIELDS_AUTORIZADOS);
    assert.match(json.descriptor.installationId, UUIDv4, "identificador de instalação é UUID opaco");
    assert.equal(json.descriptor.validityDays, 30);
    assert.equal(json.grant, null, "sem escolha ainda não há grant");
  });

  test("providerKey canónica só scheme/host/fragmento; nada que mude o destino colapsa", () => {
    const base = providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/v1" });
    assert.equal(providerKeyDe({ provider: "TESTProvider", baseURL: "HTTPS://API.Example.TEST/v1#fragmento" }), base,
      "scheme/host em minúsculas e fragmento removido: nada que o fornecedor não veja");
    assert.notEqual(providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/v1/" }), base,
      "barra terminal preservada: pode ser outra rota");
    assert.notEqual(
      providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/tenant//v1" }),
      providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/tenant/v1" }),
      "barras internas do caminho não colapsam");
    assert.notEqual(
      providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/v1?tenant=A&tenant=B" }),
      providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/v1?tenant=B&tenant=A" }),
      "a ordem de um query repetido é destino");
    assert.notEqual(providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/v1?tenant=2" }), base,
      "outro tenant é outro endpoint");
    assert.notEqual(providerKeyDe({ provider: "outroprovider", baseURL: "https://api.example.test/v1" }), base);
    assert.notEqual(providerKeyDe({ provider: "testprovider", baseURL: "https://api.outro.test/v1" }), base);
    assert.equal(base.length, 64);
  });

  test("providerLabel é o rótulo sanitizado, sem URL nem segredo", async () => {
    const json = await (await rota("GET", "/api/ai/process-consent")).json();
    assert.equal(json.descriptor.providerLabel, "testprovider", "a UI diz o fornecedor sem chamar /api/ai/status");
    assert.ok(json.descriptor.providerLabel.length <= 32);
    assert.ok(!/[/:\\]/.test(json.descriptor.providerLabel), "rótulo não é nem contém URL");
    const texto = JSON.stringify(json);
    assert.ok(!texto.includes("api.example.test"), "nenhum URL do endpoint na resposta local");
    assert.ok(!texto.includes("groq.com"), "nem o default do produto");
  });

  test("mesmo rótulo com outro endpoint é outro fornecedor: POST recusa e chat recusa", async () => {
    const outro = providerKeyDe({ provider: "testprovider", baseURL: "https://api.example.test/v1?tenant=2" });
    assert.notEqual(outro, chaveEsperada(), "mesmo rótulo, tenant diferente => chave diferente");
    const post = await rota("POST", "/api/ai/process-consent", { ...corpoEscolha(), providerKey: outro });
    assert.equal(post.status, 403);
    assert.equal((await post.json()).code, "process_consent_provider_mismatch");
    const antes = (await (await rota("GET", "/api/ai/process-consent")).json()).grant;
    const chatRes = await chat({ processIntelligence: contexto(), processConsent: true, consentProviderKey: outro });
    assert.equal(chatRes.status, 403, "recusado antes do fornecedor, mesmo com processConsent:true");
    assert.equal((await chatRes.json()).code, "process_consent_provider_mismatch");
    const depois = (await (await rota("GET", "/api/ai/process-consent")).json()).grant;
    assert.deepEqual(depois, antes, "nenhum grant escrito pela recusa");
  });

  test("installationId é estável entre leituras e não contém nada do utilizador", async () => {
    const d1 = (await (await rota("GET", "/api/ai/process-consent")).json()).descriptor.installationId;
    const d2 = (await (await rota("GET", "/api/ai/process-consent", undefined, "b")).json()).descriptor.installationId;
    assert.equal(d1, d2, "mesma instalação, mesmo identificador");
    assert.doesNotMatch(d1, /consent-a|cybersafe\.local/i);
  });

  test("o descriptor não expõe chave nem baseURL com segredo", async () => {
    const texto = JSON.stringify(await (await rota("GET", "/api/ai/process-consent")).json());
    assert.ok(!/sk-|apiKey|api_key/i.test(texto), `nenhum material de chave no descriptor: ${texto.slice(0, 120)}`);
    assert.ok(!texto.includes(process.env.JWT_SECRET));
  });

  test("status inclui o descriptor sem chaves", async () => {
    const json = await (await rota("GET", "/api/ai/status")).json();
    assert.equal(json.consentDescriptor.providerKey, chaveEsperada());
    assert.equal(json.consentDescriptor.purpose, PURPOSE);
    assert.deepEqual(json.consentDescriptor.fields, FIELDS_AUTORIZADOS);
    assert.ok(!JSON.stringify(json).toLowerCase().includes("api_key"));
  });

  test("sem token → 401 nas três rotas de consent", async () => {
    for (const [metodo, corpo] of [["GET", undefined], ["POST", {}], ["DELETE", undefined]]) {
      const res = await call(metodo, "/api/ai/process-consent", { body: corpo });
      assert.equal(res.status, 401, `${metodo} anónimo`);
    }
  });
});

describe("POST — escolha explícita exacta, sem parcial", () => {
  test("corpo exacto cria grant com 30 dias visíveis", async () => {
    const res = await rota("POST", "/api/ai/process-consent", corpoEscolha());
    assert.equal(res.status, 200, `aceite esperado: ${JSON.stringify(await res.clone().json())}`);
    const g = (await res.json()).grant;
    assert.equal(g.providerKey, chaveEsperada());
    assert.equal(g.purpose, PURPOSE);
    assert.deepEqual(g.fields, FIELDS_AUTORIZADOS);
    assert.equal(g.allowFutureProcesses, true);
    assert.equal(g.persistent, true);
    assert.equal(g.revokedAt, null);
    assert.equal(typeof g.id, "string");
    const dias = (Date.parse(g.expiresAt) - Date.parse(g.createdAt)) / 86_400_000;
    assert.ok(Math.abs(dias - VALIDITY_DAYS) < 0.01, `validade de ${dias} dias, esperado ${VALIDITY_DAYS}`);
    const GET = await (await rota("GET", "/api/ai/process-consent")).json();
    assert.equal(GET.grant.id, g.id, "GET devolve o grant activo");
  });

  test("providerKey diferente → negado antes de escrever", async () => {
    const res = await rota("POST", "/api/ai/process-consent", { ...corpoEscolha(), providerKey: sha("nao-e-o-provider") });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_provider_mismatch");
  });

  test("purpose ou fields fora do descriptor → scope_changed", async () => {
    for (const corpo of [
      { purpose: "matrix-process-explanation:v2", fields: FIELDS_AUTORIZADOS },
      { purpose: PURPOSE, fields: FIELDS_AUTORIZADOS.slice(0, 7) },
      { purpose: PURPOSE, fields: [...FIELDS_AUTORIZADOS, "listaBrancaNaoAutorizada"] },
    ]) {
      const res = await rota("POST", "/api/ai/process-consent", { ...corpoEscolha(), ...corpo });
      assert.equal(res.status, 403, `esperado 403 para ${JSON.stringify(corpo).slice(0, 80)}`);
      assert.equal((await res.json()).code, "process_consent_scope_changed");
    }
  });

  test("flags não-exactas, tipos errados ou chaves a mais → 400 sem tocar na BD", async () => {
    const antes = (await (await rota("GET", "/api/ai/process-consent")).json()).grant.id;
    for (const corpo of [
      { providerKey: chaveEsperada(), purpose: PURPOSE, fields: FIELDS_AUTORIZADOS, persistent: true },
      { providerKey: chaveEsperada(), purpose: PURPOSE, fields: FIELDS_AUTORIZADOS, allowFutureProcesses: "true", persistent: true },
      { providerKey: chaveEsperada(), purpose: PURPOSE, fields: FIELDS_AUTORIZADOS, allowFutureProcesses: true, persistent: false },
      { ...corpoEscolha(), userId: "injetado" },
      { ...corpoEscolha(), extra: 1 },
    ]) {
      const res = await rota("POST", "/api/ai/process-consent", corpo);
      assert.equal(res.status, 400, `esperado 400 para ${JSON.stringify(corpo).slice(0, 90)}`);
      assert.equal((await res.json()).code, "invalid_request");
    }
    const depois = (await (await rota("GET", "/api/ai/process-consent")).json()).grant.id;
    assert.equal(depois, antes, "nenhuma escrita: o grant activo é o mesmo");
  });
});

describe("chat — autorização antes do fornecedor, sem downgrade", () => {
  test("autorização única EMITIDA PELO SERVIDOR passa a autorização (503 no_provider)", async () => {
    // TP-MATRIX-R2-CONSENT: o corpo do pedido já não nomeia a autorização de um
    // envio — o token é emitido aqui pelo servidor, para este alvo.
    const alvo = contexto().selectedProcess;
    const pedido = await rota("POST", "/api/ai/process-consent/one-shot", {
      providerKey: chaveEsperada(), purpose: PURPOSE, fields: FIELDS_AUTORIZADOS,
      target: { pid: alvo.pid, startedAt: alvo.startedAt },
    });
    assert.equal(pedido.status, 200);
    const token = (await pedido.json()).authorization.token;
    const res = await chat({ processIntelligence: contexto(), consentAuthorization: token });
    assert.equal(res.status, 503, `autorizado, sem provider: ${JSON.stringify(await res.clone().json())}`);
    assert.equal((await res.json()).code, "no_provider");
  });

  test("`processConsent: true` sozinho (mesmo com consentProviderKey correcto) já NÃO autoriza", async () => {
    const res = await chat({ processIntelligence: contexto(), processConsent: true, consentProviderKey: chaveEsperada() });
    assert.equal(res.status, 400, "uma flag do cliente não é uma autorização");
    assert.equal((await res.json()).code, "process_consent_missing");
  });

  test("consentProviderKey errado nega ANTES do fornecedor mesmo com processConsent:true", async () => {
    const res = await chat({ processIntelligence: contexto(), processConsent: true, consentProviderKey: sha("outro") });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "process_consent_provider_mismatch");
  });

  test("grant válido autoriza sem processConsent no pedido", async () => {
    const g = (await (await rota("POST", "/api/ai/process-consent", corpoEscolha())).json()).grant;
    const res = await chat({ processIntelligence: contexto(), consentGrantId: g.id });
    assert.equal(res.status, 503, "grant cobre processos futuros: passa a autorização");
    assert.equal((await res.json()).code, "no_provider");
  });

  test("grant inexistente, mal formado ou de outra conta → negado e NUNCA one-shot", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "não-existe", 42, ""]) {
      const res = await chat({ processIntelligence: contexto(), processConsent: true, consentGrantId: id });
      assert.equal(res.status, 403, `grant ${JSON.stringify(id)}`);
      assert.equal((await res.json()).code, "process_consent_grant_invalid");
    }
    const alheio = (await (await rota("POST", "/api/ai/process-consent", corpoEscolha(), "b")).json()).grant;
    const res = await chat({ processIntelligence: contexto(), processConsent: true, consentGrantId: alheio.id });
    assert.equal(res.status, 403, "grant de outra conta não autoriza esta");
    assert.equal((await res.json()).code, "process_consent_grant_invalid");
  });

  test("grant expirado → process_consent_expired e deixa de aparecer no GET", async () => {
    // Isolar: outros testes desta conta deixaram grants activos, e o GET devolve o
    // mais recente SANO — sem revogar primeiro, a asserção «grant null» mediria o
    // grant de outro pedido em vez de medir a expiração deste.
    await rota("DELETE", "/api/ai/process-consent");
    const g = (await (await rota("POST", "/api/ai/process-consent", corpoEscolha())).json()).grant;
    // Janela EXACTA de 30 dias, mas já no passado: é expiração, não corrupção.
    const criado = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const expira = new Date(Date.parse(criado) + VALIDITY_DAYS * 86_400_000).toISOString();
    const bd = new Database(dbPath);
    bd.prepare("UPDATE process_consent_grants SET createdAt = ?, expiresAt = ? WHERE id = ?").run(criado, expira, g.id);
    bd.close();
    const chatRes = await chat({ processIntelligence: contexto(), processConsent: true, consentGrantId: g.id });
    assert.equal(chatRes.status, 403);
    assert.equal((await chatRes.json()).code, "process_consent_expired");
    const GET = await (await rota("GET", "/api/ai/process-consent")).json();
    assert.equal(GET.grant, null, "expirado não é apresentado como activo");
  });

  test("registo corrompido é inválido, não expirado, e nunca chega ao fornecedor", async () => {
    const corrupcoes = {
      "data de expiração ilegível": (id) => ["UPDATE process_consent_grants SET expiresAt = 'ontem' WHERE id = ?", id],
      "expiração antes da criação": (id) => ["UPDATE process_consent_grants SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE id = ?", id],
      "validade acima dos 30 dias": (id) => ["UPDATE process_consent_grants SET expiresAt = '2099-01-01T00:00:00.000Z' WHERE id = ?", id],
      "campos que não são lista": (id) => ["UPDATE process_consent_grants SET fields = 'nada json' WHERE id = ?", id],
      "campos fora de forma": (id) => ["UPDATE process_consent_grants SET fields = '[1,2]' WHERE id = ?", id],
      "providerKey corrompido": (id) => ["UPDATE process_consent_grants SET providerKey = 'zz' WHERE id = ?", id],
    };
    for (const [rotulo, prepara] of Object.entries(corrupcoes)) {
      await rota("DELETE", "/api/ai/process-consent");
      const g = (await (await rota("POST", "/api/ai/process-consent", corpoEscolha())).json()).grant;
      const [textoSql, parametro] = prepara(g.id);
      const bd = new Database(dbPath);
      bd.prepare(textoSql).run(parametro);
      bd.close();
      const res = await chat({ processIntelligence: contexto(), processConsent: true, consentGrantId: g.id });
      assert.equal(res.status, 403, `${rotulo}: tinha de ser recusado`);
      const json = await res.json();
      assert.notEqual(json.code, "no_provider", `${rotulo}: nada foi ao fornecedor`);
      assert.equal(json.code, "process_consent_grant_invalid", `${rotulo}: corrompido é inválido, não expirado`);
      const GET = await rota("GET", "/api/ai/process-consent");
      assert.equal(GET.status, 200, `${rotulo}: o GET não rebenta com um registo corrompido`);
    }
  });

  test("caminho antigo fechado: sem grant nem autorização única o envio NÃO acontece", async () => {
    const flag = await chat({ processIntelligence: contexto(), processConsent: true });
    assert.equal(flag.status, 400, "a flag legada deixou de autorizar (defeito R1 fechado)");
    assert.equal((await flag.json()).code, "process_consent_missing");
    const sem = await chat({ processIntelligence: contexto() });
    assert.equal(sem.status, 400);
    assert.equal((await sem.json()).code, "process_consent_missing");
  });

  test("medição mal formada continua recusada mesmo com grant", async () => {
    await rota("DELETE", "/api/ai/process-consent");
    const g = (await (await rota("POST", "/api/ai/process-consent", corpoEscolha())).json()).grant;
    const res = await chat({ processIntelligence: { version: 9 }, consentGrantId: g.id });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "process_context_invalid");
  });
});

describe("DELETE e privacidade", () => {
  test("revogação vale para esta conta+instalação e impede novos envios", async () => {
    const g = (await (await rota("POST", "/api/ai/process-consent", corpoEscolha())).json()).grant;
    const res = await rota("DELETE", "/api/ai/process-consent");
    assert.equal(res.status, 200);
    assert.ok((await res.json()).revoked >= 1, "a revogação reporta o que fez");
    const chatRes = await chat({ processIntelligence: contexto(), consentGrantId: g.id });
    assert.equal(chatRes.status, 403, "revogado não reenvia");
    assert.equal((await chatRes.json()).code, "process_consent_grant_invalid");
    assert.equal((await (await rota("GET", "/api/ai/process-consent")).json()).grant, null);
  });

  test("revogar a conta A não toca no grant da conta B", async () => {
    const gb = (await (await rota("POST", "/api/ai/process-consent", corpoEscolha(), "b")).json()).grant;
    await rota("DELETE", "/api/ai/process-consent", undefined, "a");
    const still = await chat({ processIntelligence: contexto(), consentGrantId: gb.id }, "b");
    assert.equal(still.status, 503, "B mantém autorização");
  });

  test("a linha do grant é só metadata: nomes de campos sim, valores medidos não", async () => {
    await rota("DELETE", "/api/ai/process-consent");
    const g = (await (await rota("POST", "/api/ai/process-consent", corpoEscolha())).json()).grant;
    const bd = new Database(dbPath, { readonly: true });
    const linha = bd.prepare("SELECT * FROM process_consent_grants WHERE id = ?").get(g.id);
    const colunas = bd.prepare("PRAGMA table_info(process_consent_grants)").all().map((c) => c.name);
    bd.close();
    // O que se guarda é a LISTA DE NOMES autorizados (metadata). O que não pode
    // existir é qualquer valor medido — por isso a tabela não tem coluna para isso,
    // e é a estrutura que se verifica, não uma string ocasional.
    assert.deepEqual(colunas.slice().sort(), [
      "allowFutureProcesses", "createdAt", "expiresAt", "fields", "id", "installationId", "persistent",
      "providerKey", "purpose", "revision", "revokedAt", "userId",
    ].sort(), "nenhuma coluna de métricas ou de conversa");
    assert.deepEqual(Object.keys(linha).sort(), colunas.slice().sort());
    const texto = JSON.stringify(linha);
    for (const proibido of ["workingSetMb", "selectedProcess\":", "measuredAt\":", "2026-10-14T10:00:00.000Z",
      "fixture.exe", "cpuPercent\":", "totalMb"]) {
      assert.ok(!texto.includes(proibido), `o grant não guarda o VALOR/estrutura «${proibido}»`);
    }
    assert.ok(texto.includes("cpuPercent"), "o NOME autorizado continua a ser metadata legítima");
    assert.equal(linha.userId, tokens.a.userId);
    assert.equal(linha.allowFutureProcesses, 1);
    assert.equal(linha.persistent, 1);
    assert.ok(!texto.includes(process.env.JWT_SECRET), "nem o segredo da app entra no registo");
  });

  test("o módulo não expõe o endpoint canónico nem por acaso", () => {
    const texto = fs.readFileSync(new URL("../dist/process-consent.js", import.meta.url), "utf8");
    assert.ok(!texto.includes("api.groq.com"), "nenhum URL de fornecedor hardcoded");
    assert.ok(!/sk-[A-Za-z0-9]/.test(texto), "nenhuma chave hardcoded");
    const descriptor = JSON.stringify(descriptorActual());
    assert.ok(!descriptor.includes("api.example.test"), "o descriptor nunca leva o URL");
  });
});
