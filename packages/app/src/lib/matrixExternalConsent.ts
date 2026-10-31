/**
 * CONSENTIMENTO EXTERNO DA MATRIX — contrato GET/POST/DELETE.
 *
 * O servidor é a autoridade: o descriptor diz que fornecedor/finalidade/campos
 * existem, o grant diz que a conta+instalação autorizou. O cliente NÃO inventa
 * um grant nem guarda uma aceitação local como substituto. Se a API local falhar
 * ou devolver um grant inválido, a resposta fica local e nada segue para o
 * fornecedor.
 *
 * Os campos humanos (`CAMPOS_AUTORIZADOS`) são texto de UI. O POST leva SEMPRE
 * `descriptor.fields` cru, na ordem exacta do contrato; labels e chaves não se
 * misturam.
 */

export const MATRIX_CONSENT_PURPOSE = "matrix-process-explanation:v1" as const
export const MATRIX_CONSENT_PATH = "/api/ai/process-consent" as const

/** Allowlist crua do contrato; a UI nunca acrescenta nem renomeia campos. */
export const MATRIX_CONSENT_FIELDS = [
  "version",
  "measuredAt",
  "ram",
  "cpuPercent",
  "topProcesses",
  "selectedProcess",
  "trends",
  "limitations",
] as const

export type MatrixConsentField = (typeof MATRIX_CONSENT_FIELDS)[number]

export type MatrixConsentDescriptor = {
  providerKey: string
  purpose: typeof MATRIX_CONSENT_PURPOSE
  fields: MatrixConsentField[]
  installationId: string
  validityDays: 30
  providerLabel?: string
}

export type MatrixConsentGrant = {
  id: string
  userId: string
  installationId: string
  providerKey: string
  purpose: typeof MATRIX_CONSENT_PURPOSE
  fields: MatrixConsentField[]
  allowFutureProcesses: true
  persistent: true
  createdAt: string
  expiresAt: string
  revokedAt: null
  revision: number
}

export type MatrixConsentState = {
  descriptor: MatrixConsentDescriptor
  grant: MatrixConsentGrant | null
}

/** Forma síncrona que o envio lê sem esperar por uma renderização. */
export type MatrixExternalConsentRef = {
  descriptor: MatrixConsentDescriptor | null
  grant: MatrixConsentGrant | null
}

export type MatrixConsentHttpResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string }

const texto = (value: unknown, max = 200): string | null => {
  if (typeof value !== "string") return null
  const limpo = value.trim()
  return limpo ? limpo.slice(0, max) : null
}

const camposExactos = (value: unknown): MatrixConsentField[] | null => {
  if (!Array.isArray(value) || value.length !== MATRIX_CONSENT_FIELDS.length) return null
  for (let i = 0; i < MATRIX_CONSENT_FIELDS.length; i += 1) {
    if (value[i] !== MATRIX_CONSENT_FIELDS[i]) return null
  }
  return [...MATRIX_CONSENT_FIELDS]
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const dataLegivel = (value: unknown): string | null => {
  const raw = texto(value, 80)
  if (!raw || !ISO.test(raw)) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * O descriptor só é utilizável se for o contrato exacto. Isto não substitui o
 * servidor: impede a UI de enviar um conjunto de campos diferente do allowlist
 * (por exemplo, labels humanos ou um campo novo) só porque veio no JSON.
 */
export function descriptorDeConsentimento(raw: unknown): MatrixConsentDescriptor | null {
  if (!raw || typeof raw !== "object") return null
  const d = raw as Record<string, unknown>
  const providerKey = texto(d.providerKey, 160)
  const installationId = texto(d.installationId, 160)
  const purpose = d.purpose === MATRIX_CONSENT_PURPOSE ? MATRIX_CONSENT_PURPOSE : null
  const fields = camposExactos(d.fields)
  if (!providerKey || !installationId || !purpose || !fields) return null
  if (d.validityDays !== 30) return null
  // O backend sanitiza o rótulo (<=32, sem URL nem chave). A UI limita-o de
  // novo para não alargar o contrato se a resposta vier de outra origem.
  const providerLabel = texto(d.providerLabel, 32) ?? undefined
  return { providerKey, purpose, fields, installationId, validityDays: 30, ...(providerLabel ? { providerLabel } : {}) }
}

/**
 * Um grant só conta para a UI se for do MESMO descriptor, estiver dentro da
 * validade e não estiver revogado. `allowFutureProcesses`/`persistent` têm de
 * ser exactamente `true`: um grant parcial não é promovido a persistente.
 */
export function grantDeConsentimento(
  raw: unknown,
  descriptor: MatrixConsentDescriptor,
  agora = Date.now(),
): MatrixConsentGrant | null {
  if (!raw || typeof raw !== "object") return null
  const g = raw as Record<string, unknown>
  const id = texto(g.id, 160)
  const userId = texto(g.userId, 160)
  const installationId = texto(g.installationId, 160)
  const providerKey = texto(g.providerKey, 160)
  const purpose = g.purpose === MATRIX_CONSENT_PURPOSE ? MATRIX_CONSENT_PURPOSE : null
  const fields = camposExactos(g.fields)
  const createdAt = dataLegivel(g.createdAt)
  const expiresAt = dataLegivel(g.expiresAt)
  if (!id || !userId || !installationId || !providerKey || !purpose || !fields || !createdAt || !expiresAt) return null
  if (installationId !== descriptor.installationId) return null
  if (providerKey !== descriptor.providerKey) return null
  if (g.allowFutureProcesses !== true || g.persistent !== true) return null
  if (g.revokedAt !== null) return null
  if (!(Date.parse(expiresAt) > agora)) return null
  if (typeof g.revision !== "number" || !Number.isFinite(g.revision) || g.revision < 0) return null
  return {
    id,
    userId,
    installationId,
    providerKey,
    purpose,
    fields,
    allowFutureProcesses: true,
    persistent: true,
    createdAt,
    expiresAt,
    revokedAt: null,
    revision: g.revision,
  }
}

/** GET/POST: valida o par descriptor+grant com a mesma regra dos dois lados. */
export function estadoDeConsentimento(raw: unknown, agora = Date.now()): MatrixConsentState | null {
  if (!raw || typeof raw !== "object") return null
  const state = raw as Record<string, unknown>
  const descriptor = descriptorDeConsentimento(state.descriptor)
  if (!descriptor) return null
  const grant = state.grant == null ? null : grantDeConsentimento(state.grant, descriptor, agora)
  return { descriptor, grant }
}

export type MatrixConsentMode = "uma-vez" | "persistente"

/**
 * Id de conta a partir do token que a API já emitiu. Isto é METADATA do aviso
 * local: não verifica a assinatura, não cria sessão e não autoriza nada — o
 * servidor continua a validar o token em cada pedido. Serve apenas para um
 * aviso de outra conta não apagar o estado desta.
 */
export function contaDoTokenDeSessao(token: string | null | undefined): string | null {
  if (typeof token !== "string") return null
  const partes = token.split(".")
  if (partes.length !== 3) return null
  try {
    const base64 = partes[1].replace(/-/g, "+").replace(/_/g, "/")
    const comPadding = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
    const bruto = typeof atob === "function" ? atob(comPadding) : ""
    if (!bruto) return null
    const sub = (JSON.parse(bruto) as { sub?: unknown }).sub
    return typeof sub === "string" && sub.trim() ? sub.trim().slice(0, 160) : null
  } catch {
    return null
  }
}

/**
 * Aviso LOCAL de revogação. Leva apenas metadata de conta e a fase: nunca um
 * grant, um descriptor ou outra autoridade que quem ouve pudesse reutilizar.
 * É um evento da mesma sessão, não uma chamada de rede.
 */
export const MATRIX_CONSENT_REVOKE_EVENT = "cybersafe:matrix-consent-revoked" as const

export type MatrixConsentRevokePhase = "started" | "confirmed" | "failed"

export type MatrixConsentRevokeNotice = Readonly<{
  accountId: string | null
  phase: MatrixConsentRevokePhase
  serverConfirmed: boolean
}>

type AlvoDeEventos = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">

/** Publica o aviso local. Não abre socket, não lê grant e não cria autoridade. */
export function notificarRevogacaoDeConsentimento(
  aviso: MatrixConsentRevokeNotice,
  alvo: AlvoDeEventos = window,
): void {
  alvo.dispatchEvent(new CustomEvent<MatrixConsentRevokeNotice>(MATRIX_CONSENT_REVOKE_EVENT, { detail: aviso }))
}

/** Subscrição com cleanup obrigatório; devolve a função que remove o listener. */
export function subscreverRevogacaoDeConsentimento(
  aoRevogar: (aviso: MatrixConsentRevokeNotice) => void,
  alvo: AlvoDeEventos = window,
): () => void {
  const handler = (evento: Event) => {
    const aviso = (evento as CustomEvent<MatrixConsentRevokeNotice>).detail
    if (!aviso) return
    aoRevogar(aviso)
  }
  alvo.addEventListener(MATRIX_CONSENT_REVOKE_EVENT, handler)
  return () => alvo.removeEventListener(MATRIX_CONSENT_REVOKE_EVENT, handler)
}

/** Igualdade do âmbito, na ordem do contrato. */
export function mesmosCamposDeConsentimento(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false
  return a.every((campo, i) => campo === b[i])
}

export type MatrixConsentChatFields = {
  consentProviderKey?: string
  consentGrantId?: string
  consentAuthorization?: string
  processConsent?: true
}

export type MatrixConsentSendDecision =
  | { ok: true; mode: MatrixConsentMode; campos: MatrixConsentChatFields }
  | { ok: false; code: string; message: string }

const recusaDeEnvio = (code: string): MatrixConsentSendDecision => ({
  ok: false,
  code,
  message: mensagemDeConsentimento(code),
})

/**
 * Decisão ÚNICA de envio, chamada depois do GET e antes de montar o payload.
 *
 * - `uma-vez`: não depende de grant; leva `consentProviderKey` + `processConsent`.
 *   O chamador consome a autorização local ANTES do primeiro envio e não a
 *   reutiliza num retry.
 * - `persistente`: exige grant do MESMO utilizador, instalação, provider e âmbito,
 *   ainda dentro dos 30 dias; leva `consentGrantId`, nunca `processConsent`.
 *
 * Devolver `ok:false` é fechar: não existe aqui um caminho que troque a oferta
 * persistente por uma autorização única. A excepção é a oferta `uma-vez`, que
 * por contrato não consulta o grant.
 */
export function decidirConsentimentoDeEnvio(
  state: MatrixConsentState | null,
  mode: MatrixConsentMode,
  userId: string | null,
  agora = Date.now(),
): MatrixConsentSendDecision {
  const descriptor = state?.descriptor ?? null
  if (!descriptor || !userId) return recusaDeEnvio("process_consent_grant_invalid")

  if (mode === "uma-vez") {
    // Oferta A deixou de ser uma flag local: o token do POST one-shot e o
    // unico campo que autoriza. Quem chama acrescenta `consentAuthorization`.
    return {
      ok: true,
      mode,
      campos: { consentProviderKey: descriptor.providerKey },
    }
  }

  const grant = state?.grant ?? null
  if (!grant) return recusaDeEnvio("process_consent_grant_invalid")
  if (grant.userId !== userId) return recusaDeEnvio("process_consent_grant_invalid")
  if (grant.installationId !== descriptor.installationId) return recusaDeEnvio("process_consent_grant_invalid")
  if (grant.providerKey !== descriptor.providerKey) return recusaDeEnvio("process_consent_provider_mismatch")
  if (grant.purpose !== descriptor.purpose || !mesmosCamposDeConsentimento(grant.fields, descriptor.fields)) return recusaDeEnvio("process_consent_scope_changed")
  if (grant.revokedAt !== null) return recusaDeEnvio("process_consent_grant_invalid")
  if (grant.allowFutureProcesses !== true || grant.persistent !== true) return recusaDeEnvio("process_consent_grant_invalid")
  if (!Number.isInteger(grant.revision) || grant.revision < 0) return recusaDeEnvio("process_consent_grant_invalid")

  const criado = Date.parse(grant.createdAt)
  const expira = Date.parse(grant.expiresAt)
  if (!Number.isFinite(criado) || !Number.isFinite(expira) || expira <= criado) return recusaDeEnvio("process_consent_grant_invalid")
  if (expira - criado > 30 * 24 * 60 * 60 * 1000) return recusaDeEnvio("process_consent_grant_invalid")
  if (expira <= agora) return recusaDeEnvio("process_consent_expired")

  return {
    ok: true,
    mode,
    campos: { consentProviderKey: descriptor.providerKey, consentGrantId: grant.id },
  }
}

/* ==========================================================================
 * AUTORIZACAO UNICA (R2): POST /api/ai/process-consent/one-shot.
 *
 * O token vive SO em memoria, 120 s, um envio. Nunca entra em storage,
 * historico, logs ou texto. A UI nao inventa alvo: sem PID + startedAt
 * canonicos a oferta A fica indisponivel e diz-se porquê.
 * ========================================================================== */

export const MATRIX_ONE_SHOT_PATH = "/api/ai/process-consent/one-shot" as const
export const MATRIX_ONE_SHOT_TTL_SECONDS = 120 as const

export type MatrixOneShotTarget = { pid: number; startedAt: string }

export type MatrixOneShotAuthorization = {
  token: string
  providerKey: string
  purpose: typeof MATRIX_CONSENT_PURPOSE
  fields: MatrixConsentField[]
  target: MatrixOneShotTarget
  createdAt: string
  expiresAt: string
  ttlSeconds: typeof MATRIX_ONE_SHOT_TTL_SECONDS
}

/** Alvo canonico do one-shot: o servidor nao suporta a maquina sem PID. */
export function alvoUnicoCanonico(
  alvo: { pid: number | null; startedAt: string | null } | null | undefined,
): MatrixOneShotTarget | null {
  if (!alvo) return null
  if (!Number.isInteger(alvo.pid) || (alvo.pid as number) <= 0) return null
  if (typeof alvo.startedAt !== "string") return null
  const ms = Date.parse(alvo.startedAt)
  if (!Number.isFinite(ms)) return null
  return { pid: alvo.pid as number, startedAt: new Date(ms).toISOString() }
}

export function corpoDeAutorizacaoUnica(
  descriptor: MatrixConsentDescriptor,
  target: MatrixOneShotTarget,
): { providerKey: string; purpose: typeof MATRIX_CONSENT_PURPOSE; fields: MatrixConsentField[]; target: MatrixOneShotTarget } {
  return {
    providerKey: descriptor.providerKey,
    purpose: MATRIX_CONSENT_PURPOSE,
    fields: [...descriptor.fields],
    target: { pid: target.pid, startedAt: target.startedAt },
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validador ESTRITO da resposta: nada e promovido a autoridade por parecença. */
export function autorizacaoUnicaDeResposta(
  raw: unknown,
  descriptor: MatrixConsentDescriptor,
  target: MatrixOneShotTarget,
  agora = Date.now(),
): MatrixOneShotAuthorization | null {
  if (!raw || typeof raw !== "object") return null
  const a = (raw as Record<string, unknown>).authorization
  if (!a || typeof a !== "object") return null
  const r = a as Record<string, unknown>
  const token = texto(r.token, 80)
  if (!token || !UUID.test(token)) return null
  if (r.providerKey !== descriptor.providerKey) return null
  if (r.purpose !== MATRIX_CONSENT_PURPOSE) return null
  const fields = camposExactos(r.fields)
  if (!fields || !mesmosCamposDeConsentimento(fields, descriptor.fields)) return null
  const t = r.target as Record<string, unknown> | undefined
  if (!t || t.pid !== target.pid || t.startedAt !== target.startedAt) return null
  const createdAt = dataLegivel(r.createdAt)
  const expiresAt = dataLegivel(r.expiresAt)
  if (!createdAt || !expiresAt) return null
  if (r.ttlSeconds !== MATRIX_ONE_SHOT_TTL_SECONDS) return null
  const criado = Date.parse(createdAt)
  const expira = Date.parse(expiresAt)
  if (!(expira > criado) || expira - criado > MATRIX_ONE_SHOT_TTL_SECONDS * 1000) return null
  if (!(expira > agora)) return null
  return {
    token,
    providerKey: descriptor.providerKey,
    purpose: MATRIX_CONSENT_PURPOSE,
    fields,
    target: { pid: target.pid, startedAt: target.startedAt },
    createdAt,
    expiresAt,
    ttlSeconds: MATRIX_ONE_SHOT_TTL_SECONDS,
  }
}

/** Ainda vale para ESTE alvo/fornecedor e antes do prazo? */
export function autorizacaoUnicaValida(
  autorizacao: MatrixOneShotAuthorization | null | undefined,
  target: MatrixOneShotTarget | null,
  providerKey: string | null | undefined,
  agora = Date.now(),
): boolean {
  if (!autorizacao || !target) return false
  if (!providerKey || autorizacao.providerKey !== providerKey) return false
  if (autorizacao.target.pid !== target.pid) return false
  if (autorizacao.target.startedAt !== target.startedAt) return false
  return Date.parse(autorizacao.expiresAt) > agora
}

export function camposDeAutorizacaoUnicaNoChat(
  autorizacao: MatrixOneShotAuthorization,
): { consentProviderKey: string; consentAuthorization: string } {
  return { consentProviderKey: autorizacao.providerKey, consentAuthorization: autorizacao.token }
}

/** POST one-shot com o corpo exacto. E o clique explicito que o chama. */
export async function pedirAutorizacaoUnica(
  base: string,
  descriptor: MatrixConsentDescriptor,
  target: MatrixOneShotTarget,
  headers: Record<string, string> = {},
  fetchImpl: FetchLike = fetch,
): Promise<MatrixConsentHttpResult<{ authorization: MatrixOneShotAuthorization }>> {
  let res: Response | null = null
  try {
    res = await fetchImpl(`${base}${MATRIX_ONE_SHOT_PATH}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(corpoDeAutorizacaoUnica(descriptor, target)),
      signal: AbortSignal.timeout(4000),
    })
  } catch {
    res = null
  }
  if (!res?.ok) {
    const falha = await erroHttp(res, "process_consent_authorization_invalid")
    return falha
  }
  try {
    const authorization = autorizacaoUnicaDeResposta(await res.json(), descriptor, target)
    if (!authorization) {
      return { ok: false, code: "process_consent_authorization_invalid", message: "O serviço não devolveu uma autorização única válida. Nada foi enviado ao fornecedor." }
    }
    return { ok: true, authorization }
  } catch {
    return { ok: false, code: "process_consent_authorization_invalid", message: "Resposta inválida do serviço de consentimento. Nada foi enviado ao fornecedor." }
  }
}

/** Corpo EXACTO do POST. Os labels humanos nunca entram aqui. */
export function corpoDeCriacaoDeConsentimento(descriptor: MatrixConsentDescriptor): {
  providerKey: string
  purpose: typeof MATRIX_CONSENT_PURPOSE
  fields: MatrixConsentField[]
  allowFutureProcesses: true
  persistent: true
} {
  return {
    providerKey: descriptor.providerKey,
    purpose: MATRIX_CONSENT_PURPOSE,
    fields: [...descriptor.fields],
    allowFutureProcesses: true,
    persistent: true,
  }
}

/**
 * Campos do chat. Com grant válido, o pedido é PERSISTENTE: leva
 * `consentProviderKey` + `consentGrantId` e NÃO leva `processConsent` (não há
 * downgrade silencioso para one-shot). Sem descriptor não há campos externos.
 */
export function camposDeConsentimentoNoChat(
  descriptor: MatrixConsentDescriptor | null,
  grant: MatrixConsentGrant | null,
): { consentProviderKey?: string; consentGrantId?: string } {
  if (!descriptor) return {}
  return grant
    ? { consentProviderKey: descriptor.providerKey, consentGrantId: grant.id }
    : { consentProviderKey: descriptor.providerKey }
}

export const CODIGOS_AUTORIZACAO_UNICA = [
  "process_consent_authorization_invalid",
  "process_consent_authorization_expired",
  "process_consent_authorization_used",
  "process_consent_target_mismatch",
  "process_consent_payload_out_of_scope",
  "process_consent_ambiguous",
] as const

/** Códigos 403 do contrato: todos param o envio; nenhum vira one-shot. */
export const CODIGOS_CONSENTIMENTO_RECUSADO = [
  "process_consent_provider_mismatch",
  "process_consent_scope_changed",
  "process_consent_grant_invalid",
  "process_consent_expired",
] as const

export function codigoDeConsentimentoRecusado(code: string | undefined | null): boolean {
  return !!code && (
    (CODIGOS_CONSENTIMENTO_RECUSADO as readonly string[]).includes(code)
    || (CODIGOS_AUTORIZACAO_UNICA as readonly string[]).includes(code)
  )
}

export function mensagemDeConsentimento(code: string | undefined | null): string {
  switch (code) {
    case "process_consent_authorization_invalid":
      return "A autorização de um envio já não é válida. Nada foi enviado ao fornecedor; autoriza de novo."
    case "process_consent_authorization_expired":
      return "A autorização de um envio expirou (120 s). Nada foi enviado ao fornecedor; autoriza de novo."
    case "process_consent_authorization_used":
      return "Esta autorização já foi usada. Nada foi enviado ao fornecedor; autoriza de novo."
    case "process_consent_target_mismatch":
      return "A autorização é para outro processo. Nada foi enviado ao fornecedor; autoriza o processo certo."
    case "process_consent_payload_out_of_scope":
      return "As medições incluem outro processo além do autorizado. Nada foi enviado ao fornecedor."
    case "process_consent_ambiguous":
      return "O pedido levava duas autorizações diferentes. Nada foi enviado ao fornecedor."
    case "process_consent_provider_mismatch":
      return "O fornecedor de IA mudou desde a autorização. Nada foi enviado; autoriza de novo para este fornecedor."
    case "process_consent_scope_changed":
      return "Os campos autorizados mudaram. Nada foi enviado; revê e autoriza de novo."
    case "process_consent_grant_invalid":
      return "O consentimento guardado já não é válido. Nada foi enviado; autoriza de novo."
    case "process_consent_expired":
      return "O consentimento guardado expirou. Nada foi enviado; autoriza de novo."
    default:
      return "O consentimento não foi aceite pelo serviço. Nada foi enviado ao fornecedor."
  }
}

type FetchLike = typeof fetch

const pedido = async (
  base: string,
  init: RequestInit,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<Response | null> => {
  try {
    return await fetchImpl(`${base}${MATRIX_CONSENT_PATH}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(4000),
    })
  } catch {
    return null
  }
}

const erroHttp = async (res: Response | null, fallback: string): Promise<{ ok: false; code: string; message: string }> => {
  if (!res) return { ok: false, code: "consent_api_unreachable", message: "Sem ligação à API local. Nada foi enviado ao fornecedor." }
  let code = fallback
  let message = ""
  try {
    const body = await res.json()
    if (typeof body?.code === "string") code = body.code
    if (typeof body?.message === "string") message = body.message
  } catch {
    /* corpo opcional */
  }
  return { ok: false, code, message: message || mensagemDeConsentimento(code) }
}

/** GET: metadados locais (descriptor/grant), sem sonda ao fornecedor. */
export async function lerConsentimento(
  base: string,
  headers: Record<string, string> = {},
  fetchImpl: FetchLike = fetch,
): Promise<MatrixConsentState | null> {
  const res = await pedido(base, { method: "GET" }, headers, fetchImpl)
  if (!res?.ok) return null
  try {
    return estadoDeConsentimento(await res.json())
  } catch {
    return null
  }
}

/** POST: cria/renova o grant persistente com o corpo exacto. */
export async function criarConsentimento(
  base: string,
  descriptor: MatrixConsentDescriptor,
  headers: Record<string, string> = {},
  fetchImpl: FetchLike = fetch,
): Promise<MatrixConsentHttpResult<{ state: MatrixConsentState }>> {
  const res = await pedido(base, {
    method: "POST",
    body: JSON.stringify(corpoDeCriacaoDeConsentimento(descriptor)),
  }, headers, fetchImpl)
  if (!res?.ok) return erroHttp(res, "process_consent_grant_invalid")
  try {
    const state = estadoDeConsentimento(await res.json())
    if (!state?.grant) {
      return { ok: false, code: "process_consent_grant_invalid", message: "O serviço não devolveu um grant válido. Nada foi enviado ao fornecedor." }
    }
    return { ok: true, state }
  } catch {
    return { ok: false, code: "process_consent_grant_invalid", message: "Resposta inválida do serviço de consentimento. Nada foi enviado ao fornecedor." }
  }
}

/** DELETE: revoga a autoridade no servidor. O corpo é ignorado por contrato. */
export async function revogarConsentimento(
  base: string,
  headers: Record<string, string> = {},
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const res = await pedido(base, { method: "DELETE" }, headers, fetchImpl)
  if (!res?.ok) return erroHttp(res, "process_consent_grant_invalid")
  return { ok: true }
}
