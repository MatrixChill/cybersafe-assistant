import assert from "node:assert/strict"
import test from "node:test"
import {
  alvoUnicoCanonico,
  autorizacaoUnicaDeResposta,
  autorizacaoUnicaValida,
  camposDeAutorizacaoUnicaNoChat,
  corpoDeAutorizacaoUnica,
  decidirConsentimentoDeEnvio,
  pedirAutorizacaoUnica,
  MATRIX_CONSENT_FIELDS,
  type MatrixConsentDescriptor,
  type MatrixOneShotAuthorization,
} from "../src/lib/matrixExternalConsent"
import { processPayload } from "../src/lib/processMatrix"

const DESCRIPTOR: MatrixConsentDescriptor = {
  providerKey: "a".repeat(64),
  purpose: "matrix-process-explanation:v1",
  fields: [...MATRIX_CONSENT_FIELDS],
  installationId: "inst-1",
  validityDays: 30,
}

const TARGET = { pid: 4232, startedAt: "2026-10-24T10:00:00.000Z" }
const CRIADO = "2026-10-24T12:00:00.000Z"
const EXPIRA = "2026-10-24T12:02:00.000Z"
const AGORA = Date.parse("2026-10-24T12:00:30.000Z")

function resposta(over: Record<string, unknown> = {}) {
  return {
    descriptor: { ...DESCRIPTOR, oneShotTtlSeconds: 120 },
    authorization: {
      token: "3f0c1a44-9f0e-4a3b-8f1d-2b6c5d7e8f90",
      providerKey: DESCRIPTOR.providerKey,
      purpose: DESCRIPTOR.purpose,
      fields: [...DESCRIPTOR.fields],
      target: { ...TARGET },
      createdAt: CRIADO,
      expiresAt: EXPIRA,
      ttlSeconds: 120,
      ...over,
    },
  }
}

test("corpo do one-shot: exactamente providerKey/purpose/fields/target", () => {
  assert.deepEqual(corpoDeAutorizacaoUnica(DESCRIPTOR, TARGET), {
    providerKey: DESCRIPTOR.providerKey,
    purpose: "matrix-process-explanation:v1",
    fields: [...MATRIX_CONSENT_FIELDS],
    target: { pid: 4232, startedAt: TARGET.startedAt },
  })
})

test("alvo canonico exige PID positivo e startedAt ISO; maquina nao tem one-shot", () => {
  assert.deepEqual(alvoUnicoCanonico(TARGET), TARGET)
  assert.equal(alvoUnicoCanonico({ pid: null, startedAt: null }), null)
  assert.equal(alvoUnicoCanonico({ pid: 0, startedAt: TARGET.startedAt }), null)
  assert.equal(alvoUnicoCanonico({ pid: 4232, startedAt: null }), null)
  assert.equal(alvoUnicoCanonico({ pid: 4232, startedAt: "ontem" }), null)
})

test("resposta valida e aceite e fica presa ao alvo/fornecedor", () => {
  const a = autorizacaoUnicaDeResposta(resposta(), DESCRIPTOR, TARGET, AGORA)
  assert.ok(a)
  assert.equal(a!.token, "3f0c1a44-9f0e-4a3b-8f1d-2b6c5d7e8f90")
  assert.equal(autorizacaoUnicaValida(a, TARGET, DESCRIPTOR.providerKey, AGORA), true)
  assert.equal(autorizacaoUnicaValida(a, { ...TARGET, pid: 1 }, DESCRIPTOR.providerKey, AGORA), false)
  assert.equal(autorizacaoUnicaValida(a, TARGET, "b".repeat(64), AGORA), false)
  assert.equal(autorizacaoUnicaValida(a, TARGET, DESCRIPTOR.providerKey, Date.parse(EXPIRA)), false)
})

test("resposta invalida e recusada: fornecedor, finalidade, campos, alvo, TTL, prazo, token", () => {
  const casos: Array<Record<string, unknown>> = [
    { providerKey: "b".repeat(64) },
    { purpose: "outra:v1" },
    { fields: MATRIX_CONSENT_FIELDS.slice(0, 3) },
    { target: { pid: 999, startedAt: TARGET.startedAt } },
    { target: { pid: TARGET.pid, startedAt: "2026-10-24T09:59:59.000Z" } },
    { ttlSeconds: 300 },
    { expiresAt: "2026-10-24T12:10:00.000Z" },
    { token: "" },
    { token: "nao-e-uuid" },
  ]
  for (const over of casos) {
    assert.equal(autorizacaoUnicaDeResposta(resposta(over), DESCRIPTOR, TARGET, AGORA), null, JSON.stringify(over))
  }
  assert.equal(autorizacaoUnicaDeResposta(resposta(), DESCRIPTOR, TARGET, Date.parse(EXPIRA)), null)
})

test("payload do chat leva o token e NUNCA a flag nem grant", () => {
  const auth = autorizacaoUnicaDeResposta(resposta(), DESCRIPTOR, TARGET, AGORA)!
  const campos = camposDeAutorizacaoUnicaNoChat(auth)
  const payload = processPayload({} as never, true, { ...campos, consentGrantId: "g-1", processConsent: true })
  assert.deepEqual(payload, {
    processIntelligence: {},
    consentProviderKey: DESCRIPTOR.providerKey,
    consentAuthorization: auth.token,
  })
  assert.equal("processConsent" in payload, false)
  assert.equal("consentGrantId" in payload, false)
})

test("oferta uma-vez deixa de produzir a flag processConsent", () => {
  const decisao = decidirConsentimentoDeEnvio({ descriptor: DESCRIPTOR, grant: null }, "uma-vez", "user-1", AGORA)
  assert.equal(decisao.ok, true)
  if (decisao.ok) assert.deepEqual(decisao.campos, { consentProviderKey: DESCRIPTOR.providerKey })
})

test("POST one-shot: corpo exacto, uma vez, sem flag, token devolvido", async () => {
  const vistos: Array<{ url: string; body: unknown; method?: string }> = []
  const agoraReal = Date.now()
  const viva = resposta({
    createdAt: new Date(agoraReal - 10_000).toISOString(),
    expiresAt: new Date(agoraReal + 110_000).toISOString(),
  })
  const fetchFalso = (async (url: string, init: RequestInit) => {
    vistos.push({ url, method: init.method, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(viva), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as unknown as typeof fetch
  const r = await pedirAutorizacaoUnica("http://127.0.0.1:4100", DESCRIPTOR, TARGET, { Authorization: "Bearer x" }, fetchFalso)
  assert.equal(r.ok, true)
  assert.equal(vistos.length, 1)
  assert.match(vistos[0].url, /\/api\/ai\/process-consent\/one-shot$/)
  assert.equal(vistos[0].method, "POST")
  assert.deepEqual(vistos[0].body, corpoDeAutorizacaoUnica(DESCRIPTOR, TARGET))
  assert.equal(JSON.stringify(vistos[0].body).includes("processConsent"), false)
})

test("POST one-shot: recusa do servico nao produz token e mantem o codigo", async () => {
  const fetchFalso = (async () => new Response(JSON.stringify({ code: "process_consent_target_mismatch", message: "x" }), { status: 403 })) as unknown as typeof fetch
  const r = await pedirAutorizacaoUnica("http://127.0.0.1:4100", DESCRIPTOR, TARGET, {}, fetchFalso)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "process_consent_target_mismatch")
})
