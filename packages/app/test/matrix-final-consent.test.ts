/**
 * TP-MATRIX-FINAL-CONSENT — contrato persistente, sem rede externa.
 *
 * O servidor é a autoridade. Estes testes fixam o que a UI pode enviar:
 * descriptor/grant validados, POST com os campos CRUS exactos, chat com
 * consentProviderKey+consentGrantId e sem downgrade para processConsent, DELETE
 * sem corpo. Nada aqui inventa uma aceitação local.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MATRIX_CONSENT_FIELDS,
  MATRIX_CONSENT_PURPOSE,
  camposDeConsentimentoNoChat,
  codigoDeConsentimentoRecusado,
  contaDoTokenDeSessao,
  corpoDeCriacaoDeConsentimento,
  criarConsentimento,
  descriptorDeConsentimento,
  decidirConsentimentoDeEnvio,
  estadoDeConsentimento,
  grantDeConsentimento,
  lerConsentimento,
  mensagemDeConsentimento,
  notificarRevogacaoDeConsentimento,
  revogarConsentimento,
  subscreverRevogacaoDeConsentimento,
  type MatrixConsentState,
  type MatrixConsentDescriptor,
  type MatrixConsentGrant,
} from "../src/lib/matrixExternalConsent.ts";
import { processPayload } from "../src/lib/processMatrix.ts";

const AGORA = Date.parse("2026-10-23T12:00:00.000Z");
const DESCRIPTOR: MatrixConsentDescriptor = {
  providerKey: "pk_7f3a",
  purpose: MATRIX_CONSENT_PURPOSE,
  fields: [...MATRIX_CONSENT_FIELDS],
  installationId: "inst_abc",
  validityDays: 30,
  providerLabel: "Fornecedor de teste",
};
const GRANT: MatrixConsentGrant = {
  id: "grant_1",
  userId: "user_1",
  installationId: "inst_abc",
  providerKey: "pk_7f3a",
  purpose: MATRIX_CONSENT_PURPOSE,
  fields: [...MATRIX_CONSENT_FIELDS],
  allowFutureProcesses: true,
  persistent: true,
  createdAt: "2026-10-23T10:00:00.000Z",
  expiresAt: "2026-11-22T10:00:00.000Z",
  revokedAt: null,
  revision: 1,
};
const CONTEXTO = {
  version: 1,
  measuredAt: "2026-10-23T09:20:00.000Z",
  ram: { totalMb: 16384, usedMb: 15000, availableMb: 1384 },
  cpuPercent: 88,
  topProcesses: [],
  selectedProcess: null,
  trends: [],
  limitations: [],
} as never;

test("C1 — descriptor só passa com propósito, campos crus e validade exactos", () => {
  assert.deepEqual(descriptorDeConsentimento({ ...DESCRIPTOR }), DESCRIPTOR);
  assert.equal(descriptorDeConsentimento({ ...DESCRIPTOR, purpose: "outro" }), null);
  assert.equal(descriptorDeConsentimento({ ...DESCRIPTOR, validityDays: 31 }), null);
  assert.equal(descriptorDeConsentimento({ ...DESCRIPTOR, fields: ["CPU %", "RAM"] }), null);
  assert.equal(
    descriptorDeConsentimento({ ...DESCRIPTOR, fields: [...MATRIX_CONSENT_FIELDS].reverse() }),
    null,
    "a ordem dos campos é parte do contrato",
  );
  const labelLongo = descriptorDeConsentimento({ ...DESCRIPTOR, providerLabel: "x".repeat(40) });
  assert.equal(labelLongo?.providerLabel?.length, 32, "o rótulo do backend é limitado a 32 caracteres na UI");
});

test("C2 — grant é do descriptor, não está revogado e ainda não expirou", () => {
  assert.deepEqual(grantDeConsentimento({ ...GRANT }, DESCRIPTOR, AGORA), GRANT);
  assert.equal(grantDeConsentimento({ ...GRANT, providerKey: "outro" }, DESCRIPTOR, AGORA), null);
  assert.equal(grantDeConsentimento({ ...GRANT, installationId: "outra" }, DESCRIPTOR, AGORA), null);
  assert.equal(grantDeConsentimento({ ...GRANT, fields: ["ram"] }, DESCRIPTOR, AGORA), null);
  assert.equal(grantDeConsentimento({ ...GRANT, allowFutureProcesses: false }, DESCRIPTOR, AGORA), null);
  assert.equal(grantDeConsentimento({ ...GRANT, persistent: false }, DESCRIPTOR, AGORA), null);
  assert.equal(grantDeConsentimento({ ...GRANT, revokedAt: "2026-10-23T11:00:00.000Z" }, DESCRIPTOR, AGORA), null);
  assert.equal(grantDeConsentimento({ ...GRANT, expiresAt: "2026-10-23T11:00:00.000Z" }, DESCRIPTOR, AGORA), null);
});

test("C3 — POST usa descriptor.fields EXACTOS e o corpo fixo, nunca labels humanos", () => {
  const corpo = corpoDeCriacaoDeConsentimento(DESCRIPTOR);
  assert.deepEqual(corpo, {
    providerKey: "pk_7f3a",
    purpose: "matrix-process-explanation:v1",
    fields: [...MATRIX_CONSENT_FIELDS],
    allowFutureProcesses: true,
    persistent: true,
  });
  assert.deepEqual(Object.keys(corpo).sort(), ["allowFutureProcesses", "fields", "persistent", "providerKey", "purpose"]);
  assert.equal(JSON.stringify(corpo).includes("Working Set"), false, "labels humanos não entram no corpo");
});

/** A montagem do payload do chat: o 3.º argumento de `processPayload` recebe os
 * campos externos e decide a autoridade; `processConsent` legado não sobrevive. */
function payloadDoChat(estado: { descriptor: MatrixConsentDescriptor | null; grant: MatrixConsentGrant | null }) {
  const campos = camposDeConsentimentoNoChat(estado.descriptor, estado.grant);
  return processPayload(CONTEXTO, true, campos);
}

test("C4a — as três formas do 3.º argumento não misturam autoridades", () => {
  assert.deepEqual(processPayload(CONTEXTO, true, { consentProviderKey: "pk_7f3a", processConsent: true }), {
    processIntelligence: CONTEXTO,
    consentProviderKey: "pk_7f3a",
    processConsent: true,
  }, "oferta A: uma única autorização, sem grant");
  assert.deepEqual(processPayload(CONTEXTO, true, { consentProviderKey: "pk_7f3a", consentGrantId: "grant_1" }), {
    processIntelligence: CONTEXTO,
    consentProviderKey: "pk_7f3a",
    consentGrantId: "grant_1",
  }, "oferta B: grant persistente, sem processConsent");
  assert.deepEqual(processPayload(CONTEXTO, true, { consentProviderKey: "pk_7f3a" }), {
    consentProviderKey: "pk_7f3a",
  }, "sem autorização para este envio, as medições ficam em casa");
  assert.deepEqual(processPayload(CONTEXTO, true, {
    consentProviderKey: "pk_7f3a",
    consentGrantId: "grant_1",
    processConsent: true,
  }), {
    processIntelligence: CONTEXTO,
    consentProviderKey: "pk_7f3a",
    consentGrantId: "grant_1",
  }, "se os dois sinais chegarem juntos, o grant vence; nunca viajam duas autoridades");
  assert.deepEqual(processPayload(CONTEXTO, false, { consentProviderKey: "pk_7f3a", consentGrantId: "grant_1" }), {}, "sem consentimento não há payload");
});

test("C4 — chat persistente leva providerKey+grantId e NÃO leva processConsent", () => {
  const campos = camposDeConsentimentoNoChat(DESCRIPTOR, GRANT);
  assert.deepEqual(campos, { consentProviderKey: "pk_7f3a", consentGrantId: "grant_1" });
  const payload = payloadDoChat({ descriptor: DESCRIPTOR, grant: GRANT });
  assert.deepEqual(Object.keys(payload).sort(), ["consentGrantId", "consentProviderKey", "processIntelligence"]);
  assert.equal(payload.processConsent, undefined, "grant persistente não desce para one-shot");
  assert.equal(payload.consentProviderKey, "pk_7f3a");
  assert.equal(payload.consentGrantId, "grant_1");
});

test("C5 — grant inválido não produz payload de processo e não cai para one-shot", () => {
  assert.deepEqual(payloadDoChat({ descriptor: DESCRIPTOR, grant: null }), {
    consentProviderKey: "pk_7f3a",
  }, "sem grant o fornecedor continua declarado, mas não há medições nem one-shot");
  assert.deepEqual(camposDeConsentimentoNoChat(DESCRIPTOR, null), { consentProviderKey: "pk_7f3a" });
  assert.deepEqual(processPayload(CONTEXTO, true), {
    processIntelligence: CONTEXTO,
    processConsent: true,
  }, "a forma legada de 2 argumentos mantém-se para os harnesses antigos");
});

test("C6 — 403 do contrato são todos recusados com mensagem própria", () => {
  for (const code of [
    "process_consent_provider_mismatch",
    "process_consent_scope_changed",
    "process_consent_grant_invalid",
    "process_consent_expired",
  ] as const) {
    assert.equal(codigoDeConsentimentoRecusado(code), true, code);
    assert.notEqual(mensagemDeConsentimento(code), "", code);
    assert.match(mensagemDeConsentimento(code), /Nada foi enviado/i, code);
  }
  assert.equal(codigoDeConsentimentoRecusado("process_consent_missing"), false);
});

test("C7 — GET/POST/DELETE usam auth, corpo exacto e DELETE sem body", async () => {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const fake = (body: unknown, ok = true) => (async (url: string, init?: RequestInit) => {
    chamadas.push({ url, init: init ?? {} });
    return { ok, json: async () => body, status: ok ? 200 : 403 } as Response;
  }) as typeof fetch;

  const lido = await lerConsentimento("http://127.0.0.1:4000", { Authorization: "Bearer fixture" }, fake({ descriptor: DESCRIPTOR, grant: GRANT }));
  assert.ok(lido?.grant);
  assert.equal(chamadas[0].init.method, "GET");
  assert.deepEqual(chamadas[0].init.headers, { Authorization: "Bearer fixture" });

  const criado = await criarConsentimento("http://127.0.0.1:4000", DESCRIPTOR, { Authorization: "Bearer fixture" }, fake({ descriptor: DESCRIPTOR, grant: GRANT }));
  assert.equal(criado.ok, true);
  assert.equal(chamadas[1].init.method, "POST");
  assert.deepEqual(JSON.parse(String(chamadas[1].init.body)), corpoDeCriacaoDeConsentimento(DESCRIPTOR));

  const removido = await revogarConsentimento("http://127.0.0.1:4000", { Authorization: "Bearer fixture" }, fake({}));
  assert.equal(removido.ok, true);
  assert.equal(chamadas[2].init.method, "DELETE");
  assert.equal(chamadas[2].init.body, undefined, "DELETE ignora/body vazio");

  const recusado = await criarConsentimento(
    "http://127.0.0.1:4000",
    DESCRIPTOR,
    { Authorization: "Bearer fixture" },
    fake({ code: "process_consent_scope_changed", message: "scope" }, false),
  );
  assert.equal(recusado.ok, false);
  if (!recusado.ok) assert.equal(recusado.code, "process_consent_scope_changed");
});

test("C8 — UI usa o cliente, valida antes do envio e mostra o rótulo do backend", () => {
  const ai = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(ai, /lerConsentimento\(API_BASE/);
  assert.match(ai, /criarConsentimento\(API_BASE, descriptor/);
  assert.match(ai, /revogarConsentimento\(API_BASE/);
  const inicioEnvio = ai.indexOf("const sendToServer = useCallback(");
  const inicioPayload = ai.indexOf("const payload = {", inicioEnvio);
  const antesDoPayload = ai.slice(inicioEnvio, inicioPayload);
  assert.match(antesDoPayload, /lerConsentimento\(API_BASE/, "o GET tem de acontecer ANTES de montar o payload");
  assert.match(antesDoPayload, /consent_api_unreachable/);
  assert.match(antesDoPayload, /decidirConsentimentoDeEnvio\(validado, modoDoEnvio \?\? "persistente"/);
  assert.match(antesDoPayload, /!mesmosCamposDeConsentimento\(validado\.descriptor\.fields, externoAgora\.descriptor\.fields\)/, "o âmbito é comparado com o descriptor VIVO depois do await");
  assert.match(ai, /const invalidarConsentimentoLocal = useCallback[\s\S]{0,1200}grant: null/, "a invalidação local fecha o grant");
  assert.match(ai, /const revogarAlvoEmCausa = async[\s\S]{0,300}invalidarConsentimentoLocal\(true\)/, "revogar invalida a autoridade local antes do DELETE");
  assert.match(ai, /const payloadProcesso = processPayload\(\s*anexarContexto \? processContext : null,\s*consentimentoDoPedido,\s*externo\?\.descriptor \? camposEnvio : undefined,/, "a cablagem do payload é uma só: o 3.º argumento leva os campos de consentimento");
  assert.doesNotMatch(ai, /delete payloadProcesso\./, "a decisão de autoridade saiu do componente para processPayload");
  assert.match(ai, /processChatHistory\(history, consentimentoDoPedido, consentimentoDoPedido \? alvoDoEnvio : null\)/, "o histórico continua filtrado pelo alvo do envio");
  assert.doesNotMatch(ai, /camposDeConsentimentoNoChat/, "o chat geral não pode ser coberto por um grant");
  assert.match(ai, /camposEnvio = decisao\.campos/);
  assert.doesNotMatch(ai, /allowFutureProcesses/, "allowFutureProcesses é só do POST, nunca do chat");
  assert.match(ai, /codigoDeConsentimentoRecusado\(result\.code\)/);
  assert.match(ai, /setAutorizacoes\(\[\]\)/);
  assert.match(ai, /setFornecedor\(next\.descriptor\?\.providerLabel/);
  assert.doesNotMatch(ai, /\/api\/ai\/status/);

  assert.match(settings, /data-settings-matrix-consent/);
  assert.match(settings, /data-settings-matrix-consent-revoke/);
  assert.match(settings, /lerConsentimento\(API_BASE/);
  assert.match(settings, /revogarConsentimento\(API_BASE/);
  assert.match(settings, /CAMPOS_AUTORIZADOS/);
  assert.match(settings, /grant\.expiresAt/, "expiresAt tem de estar visível");
});

test("C9 — descriptor/grant parseados não escondem um grant inválido", () => {
  assert.equal(estadoDeConsentimento({ descriptor: DESCRIPTOR, grant: { ...GRANT, providerKey: "outro" } }, AGORA)?.grant, null);
  assert.equal(estadoDeConsentimento({ descriptor: DESCRIPTOR, grant: null }, AGORA)?.grant, null);
  assert.equal(estadoDeConsentimento({ descriptor: { ...DESCRIPTOR, fields: ["ram"] }, grant: GRANT }, AGORA), null);
});

const ESTADO_PERSISTENTE = { descriptor: DESCRIPTOR, grant: GRANT };

test("C10 — oferta A (uma vez) e oferta B (persistente) produzem campos diferentes", () => {
  const umaVez = decidirConsentimentoDeEnvio(ESTADO_PERSISTENTE, "uma-vez", "user_1", AGORA);
  assert.equal(umaVez.ok, true);
  if (umaVez.ok) {
    assert.deepEqual(umaVez.campos, { consentProviderKey: "pk_7f3a" });
    assert.equal("consentGrantId" in umaVez.campos, false, "a oferta A nunca leva grantId");
  }

  const persistente = decidirConsentimentoDeEnvio(ESTADO_PERSISTENTE, "persistente", "user_1", AGORA);
  assert.equal(persistente.ok, true);
  if (persistente.ok) {
    assert.deepEqual(persistente.campos, { consentProviderKey: "pk_7f3a", consentGrantId: "grant_1" });
    assert.equal("processConsent" in persistente.campos, false, "a oferta B nunca é one-shot");
  }
});

test("C11 — decisão falha fechada em conta, instalação, provider, âmbito e expiração", () => {
  const casos: Array<{ nome: string; estado: never; modo: "uma-vez" | "persistente"; user: string | null; code: string }> = [
    { nome: "grant ausente", estado: { descriptor: DESCRIPTOR, grant: null } as never, modo: "persistente", user: "user_1", code: "process_consent_grant_invalid" },
    { nome: "outra conta", estado: { descriptor: DESCRIPTOR, grant: { ...GRANT, userId: "outro" } } as never, modo: "persistente", user: "user_1", code: "process_consent_grant_invalid" },
    { nome: "sem sessão", estado: ESTADO_PERSISTENTE as never, modo: "persistente", user: null, code: "process_consent_grant_invalid" },
    { nome: "outra instalação", estado: { descriptor: DESCRIPTOR, grant: { ...GRANT, installationId: "outra" } } as never, modo: "persistente", user: "user_1", code: "process_consent_grant_invalid" },
    { nome: "outro provider", estado: { descriptor: DESCRIPTOR, grant: { ...GRANT, providerKey: "outro" } } as never, modo: "persistente", user: "user_1", code: "process_consent_provider_mismatch" },
    { nome: "outro âmbito", estado: { descriptor: DESCRIPTOR, grant: { ...GRANT, fields: ["ram"] } } as never, modo: "persistente", user: "user_1", code: "process_consent_scope_changed" },
    { nome: "expirado", estado: { descriptor: DESCRIPTOR, grant: { ...GRANT, expiresAt: "2026-10-23T11:00:00.000Z" } } as never, modo: "persistente", user: "user_1", code: "process_consent_expired" },
    { nome: "revogado", estado: { descriptor: DESCRIPTOR, grant: { ...GRANT, revokedAt: "2026-10-23T11:00:00.000Z" } } as never, modo: "persistente", user: "user_1", code: "process_consent_grant_invalid" },
  ];
  for (const caso of casos) {
    const decisao = decidirConsentimentoDeEnvio(caso.estado, caso.modo, caso.user, AGORA);
    assert.equal(decisao.ok, false, caso.nome);
    if (!decisao.ok) assert.equal(decisao.code, caso.code, caso.nome);
  }

  // A oferta A não depende de um grant vivo: é uma autorização única. Mas exige
  // sessão e descriptor, e nunca promove o grant a persistente.
  const umaVez = decidirConsentimentoDeEnvio({ descriptor: DESCRIPTOR, grant: null } as never, "uma-vez", "user_1", AGORA);
  assert.equal(umaVez.ok, true);
  if (umaVez.ok) {
    assert.equal(umaVez.campos.consentProviderKey, "pk_7f3a")
    assert.equal("processConsent" in umaVez.campos, false, "a oferta A já não emite a flag")
  }
  assert.equal(decidirConsentimentoDeEnvio(ESTADO_PERSISTENTE, "uma-vez", null, AGORA).ok, false);
});

test("C12 — com fetch mockado, GET real alimenta a decisão persistente e a uma-vez", async () => {
  const chamadas: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    chamadas.push(`${init?.method ?? "GET"} ${url}`);
    return { ok: true, status: 200, json: async () => ({ descriptor: DESCRIPTOR, grant: GRANT }) } as Response;
  }) as typeof fetch;

  const lido = await lerConsentimento("http://127.0.0.1:4000", { Authorization: "Bearer fixture" }, fake);
  assert.ok(lido);
  const persistente = decidirConsentimentoDeEnvio(lido, "persistente", "user_1", AGORA);
  const umaVez = decidirConsentimentoDeEnvio(lido, "uma-vez", "user_1", AGORA);
  assert.equal(persistente.ok, true);
  assert.equal(umaVez.ok, true);
  if (persistente.ok) assert.deepEqual(persistente.campos, { consentProviderKey: "pk_7f3a", consentGrantId: "grant_1" });
  if (umaVez.ok) assert.deepEqual(umaVez.campos, { consentProviderKey: "pk_7f3a" });
  assert.deepEqual(chamadas, ["GET http://127.0.0.1:4000/api/ai/process-consent"]);
});

test("C13 — UI oferece A/B, consome a uma-vez e revoga sem deixar resposta pendente", () => {
  const ai = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  assert.match(ai, /data-matrix-consent-authorize-persistent/);
  assert.match(ai, /Só esta explicação/);
  assert.match(ai, /Guardar para futuras explicações/);
  assert.match(ai, /data-matrix-consent-indicator/);
  assert.match(ai, /Finalidade: explicação de processos\./);
  assert.match(ai, /autorizacoesOneShotRef/);
  assert.match(ai, /modoDoEnvio === "uma-vez"/);
  assert.match(ai, /const maxAttempts = modoDoEnvio === "uma-vez" \? 0/);

  const inicioRevogar = ai.indexOf("const invalidarConsentimentoLocal");
  const fimRevogar = ai.indexOf("const revogarAlvoEmCausa", inicioRevogar);
  assert.ok(inicioRevogar > 0 && fimRevogar > inicioRevogar, "a invalidação local deixou de ter a forma esperada");
  const revogar = ai.slice(inicioRevogar, fimRevogar);
  assert.match(revogar, /questionGenerationRef\.current \+= 1/);
  assert.match(revogar, /cancelLocalSecurityRequest\(abortRef\.current\)/);
  assert.match(revogar, /setAutorizacoes\(\[\]\)/);
  assert.match(revogar, /setExplicacaoPendente\(null\)/);
  assert.match(revogar, /setOfertaIa\(null\)/);
  assert.match(revogar, /autorizacoesOneShotRef\.current\.clear\(\)/);
  assert.match(ai, /const revogarAlvoEmCausa = async[\s\S]*?invalidarConsentimentoLocal\(true\)/);
  assert.match(ai, /notificarRevogacaoDeConsentimento\(\{ accountId: contaId, phase: "started"/);
  assert.match(ai, /subscreverRevogacaoDeConsentimento\(/);
});

test("C15 — o grant persistente sobrevive ao remount e a outro PID, sem alargar a conta", () => {
  // Remount: não há autorizacoes locais; a única prova é o estado lido do
  // servidor. A decisão não olha para PID, por isso vale para outro alvo.
  const remount = decidirConsentimentoDeEnvio(ESTADO_PERSISTENTE, "persistente", "user_1", AGORA);
  assert.equal(remount.ok, true, "um grant vivo não precisa de autorização local para valer");
  assert.equal(decidirConsentimentoDeEnvio(ESTADO_PERSISTENTE, "persistente", "user_2", AGORA).ok, false, "outra conta não herda o grant");
  assert.equal(
    decidirConsentimentoDeEnvio(
      { descriptor: DESCRIPTOR, grant: { ...GRANT, expiresAt: "2026-10-23T11:00:00.000Z" } },
      "persistente",
      "user_1",
      AGORA,
    ).ok,
    false,
    "expirado falha fechado mesmo depois de um remount",
  );
  // O grant não transporta PID: o histórico é filtrado pelo alvo do pedido, que
  // é outra função. Aqui prova-se que a autorização não depende de um alvo.
  const ai = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  assert.match(ai, /const grantPersistenteActivo =[\s\S]{0,300}decidirConsentimentoDeEnvio/);
  assert.match(ai, /const consentimentoProcessoEfectivo = !consentimentoBloqueado && \(alvoAutorizado !== null \|\| grantPersistenteActivo\)/);
});

test("C14 — Settings mostra estado e revoga, sem botão de ativar", () => {
  const settings = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(settings, /data-settings-matrix-consent-status/);
  assert.match(settings, /data-settings-matrix-consent-revoke/);
  assert.doesNotMatch(settings, /data-settings-matrix-consent-enable/);
  assert.match(settings, /authHeaders\(\)/, "lê com o token da sessão, sem inventar uma conta");
  assert.match(settings, /contaDoTokenDeSessao\(tokenDeSessao\(\)\)/, "o aviso leva o id da conta, não uma autoridade nova");
  assert.doesNotMatch(settings, /useAuth/, "Configurações não dependem de um provider para avisar a MATRIX");
  assert.match(settings, /notificarRevogacaoDeConsentimento\(/, "a MATRIX é avisada no início, no sucesso e na falha");
  assert.match(settings, /subscreverRevogacaoDeConsentimento\(/, "as Configurações também ouvem a revogação da MATRIX");
});

test("C16 — aviso de revogação leva só conta/fase e o cleanup remove o listener", () => {
  const alvo = new EventTarget();
  const vistos: Array<{ accountId: string | null; phase: string; serverConfirmed: boolean }> = [];
  const cancelar = subscreverRevogacaoDeConsentimento((aviso) => vistos.push(aviso), alvo);

  notificarRevogacaoDeConsentimento({ accountId: "user_1", phase: "started", serverConfirmed: false }, alvo);
  notificarRevogacaoDeConsentimento({ accountId: "user_1", phase: "failed", serverConfirmed: false }, alvo);
  cancelar();
  notificarRevogacaoDeConsentimento({ accountId: "user_1", phase: "confirmed", serverConfirmed: true }, alvo);

  assert.deepEqual(vistos, [
    { accountId: "user_1", phase: "started", serverConfirmed: false },
    { accountId: "user_1", phase: "failed", serverConfirmed: false },
  ]);
  assert.equal(JSON.stringify(vistos).includes("grant"), false, "o aviso não transporta autoridade");
});

test("C19 — o consentimento diz «nesta conta e computador», não «servidor»", () => {
  const ai = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  for (const fonte of [ai, settings]) {
    assert.doesNotMatch(fonte, /guardad[oa] no servidor|guardar no servidor|cria um grant no servidor/i, "a API de consentimento é local; o texto não pode dizer que guarda no servidor");
  }
  assert.match(settings, /nesta conta e computador/);
  assert.ok((ai.match(/nesta conta e computador/g) ?? []).length >= 4, "a MATRIX repete o local em todos os estados de guarda");
});

test("C18 — a metadata de conta vem do `sub` do token, sem validar autoridade", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "user_1" })).toString("base64url");
  assert.equal(contaDoTokenDeSessao(`header.${payload}.signature`), "user_1");
  assert.equal(contaDoTokenDeSessao("sem-partes"), null);
  assert.equal(contaDoTokenDeSessao(null), null);
  assert.equal(contaDoTokenDeSessao("a.b.c"), null, "payload inválido não inventa conta");
});

test("C17 — Settings avisa a MATRIX na revogação e na falha do DELETE", async () => {
  const settings = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  const inicio = settings.indexOf("  async function revogarConsentimentoMatriz() {");
  const fimRelativo = settings.slice(inicio).search(/\r?\n  \}\r?\n/);
  assert.ok(inicio > 0 && fimRelativo > 0, "a rotina de revogação das Configurações mudou de forma");
  const fim = inicio + fimRelativo;
  const corpo = `${settings.slice(inicio, fim)}\n  }`;

  const executar = async (resultado: { ok: true } | { ok: false; code: string; message: string }) => {
    const avisos: Array<{ accountId: string | null; phase: string; serverConfirmed: boolean }> = [];
    let erro: string | null = null;
    let estado: MatrixConsentState = { descriptor: DESCRIPTOR, grant: GRANT };
    const alvo = new EventTarget();
    const cancelar = subscreverRevogacaoDeConsentimento((aviso) => avisos.push(aviso), alvo);
    const anterior = (globalThis as unknown as { window?: unknown }).window;
    (globalThis as unknown as { window: EventTarget }).window = alvo;
    try {
      const fn = new Function(
        "revogarConsentimento", "notificarRevogacaoDeConsentimento", "contaId", "API_BASE", "authHeaders",
        "setConsentimentoAGuardar", "setConsentimentoErro", "setConsentimentoMatriz",
        `${corpo}\nreturn revogarConsentimentoMatriz;`,
      )(
        async () => resultado,
        notificarRevogacaoDeConsentimento,
        "user_1",
        "http://127.0.0.1:4000",
        () => ({ Authorization: "Bearer fixture" }),
        () => {},
        (v: string | null) => { erro = v; },
        (atualizar: (atual: MatrixConsentState) => MatrixConsentState) => { estado = atualizar(estado); },
      ) as () => Promise<void>;
      await fn();
    } finally {
      cancelar();
      if (anterior === undefined) delete (globalThis as unknown as { window?: unknown }).window;
      else (globalThis as unknown as { window: unknown }).window = anterior;
    }
    return { avisos, lerErro: () => erro, lerEstado: () => estado };
  };

  const sucesso = await executar({ ok: true });
  assert.deepEqual(sucesso.avisos.map((a) => a.phase), ["started", "confirmed"]);
  assert.equal(sucesso.avisos[0].accountId, "user_1");
  assert.equal(sucesso.lerEstado().grant, null, "o grant local fecha depois do DELETE confirmado");

  const falha = await executar({ ok: false, code: "consent_api_unreachable", message: "sem api" });
  assert.deepEqual(falha.avisos.map((a) => a.phase), ["started", "failed"]);
  assert.match(falha.lerErro() ?? "", /não confirmou|bloqueada/i);
  assert.equal(falha.lerEstado().grant?.id, "grant_1", "a falha não inventa uma revogação no servidor");
});
