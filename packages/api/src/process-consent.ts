import { createHash, randomUUID } from "node:crypto";
import { AI_CONFIG } from "./ai.js";
import { getDb } from "./db.js";

/**
 * TP-MATRIX-FINAL-CONSENT — grant persistente para as explicações de processos.
 *
 * Porque existe: hoje a autorização é por pedido (`processConsent === true` em
 * `process-intelligence.ts`) e cada re-render volta a pedir. O grant é a escolha
 * EXPLÍCITA E PERSISTENTE da pessoa, ligada a uma finalidade, a um fornecedor e a
 * uma instalação.
 *
 * O que este módulo guarda: metadados e nada mais. Nenhuma métrica de processo,
 * nenhum texto de conversa, nenhuma chave de fornecedor, nenhum URL real. A
 * identidade do endpoint vive como hash; a forma canónica nunca é devolvida.
 *
 * O que NÃO faz: não authoriza por inferência (a correspondência é sempre contra o
 * descriptor ACTUAL), não aceita cache de consentimento, não revoga em segundo
 * plano além da marcação preguiçosa de expiração, e nunca abre excepção quando o
 * grant é inválido — sem grant válido o envio simplesmente não acontece.
 */

export const PURPOSE = "matrix-process-explanation:v1";
export const VALIDITY_DAYS = 30;

/**
 * As chaves do contexto que o validador central já aceita
 * (`process-intelligence.ts::validateProcessIntelligencePayload`). Não são uma
 * escolha da UI: as sub-chaves de cada entrada são fixadas pelo validador, e uma
 * lista que o validador não conhece está, por definição, fora de âmbito.
 */
export const FIELDS_AUTORIZADOS = [
  "version", "measuredAt", "ram", "cpuPercent", "topProcesses", "selectedProcess", "trends", "limitations",
] as const;

export type CodigoRecusaConsent =
  | "process_consent_provider_mismatch"
  | "process_consent_scope_changed"
  | "process_consent_grant_invalid"
  | "process_consent_expired"
  // ── TP-MATRIX-R2-CONSENT: autorização ÚNICA emitida pelo servidor ──
  | "process_consent_authorization_invalid"
  | "process_consent_authorization_expired"
  | "process_consent_authorization_used"
  | "process_consent_target_mismatch"
  // Medição que inclui processos além do alvo autorizado (achado da revisão Codex).
  | "process_consent_payload_out_of_scope";

export class ConsentDenial extends Error {
  readonly code: CodigoRecusaConsent;
  constructor(code: CodigoRecusaConsent, message: string) {
    super(message);
    this.name = "ConsentDenial";
    this.code = code;
  }
}

export interface DescritorConsent {
  providerKey: string;
  /**
   * Rótulo HUMANO do fornecedor, sanitizado e com teto de caracteres. Serve para a
   * UI dizer «a autorização é com o fornecedor X» sem chamar `/api/ai/status` (que
   * sonda o provider lá fora) e sem nunca revelar URL ou chave. Não é identidade: a
   * identidade é `providerKey`.
   */
  providerLabel: string;
  purpose: string;
  fields: string[];
  installationId: string;
  validityDays: number;
  /**
   * TTL da autorização única, em segundos. É um número e não um prazo: a UI mostra
   * «esta autorização vale para um envio» sem prometer janelas temporais inventadas.
   */
  oneShotTtlSeconds: number;
}

export interface GrantConsent {
  id: string;
  userId: string;
  installationId: string;
  providerKey: string;
  purpose: string;
  fields: string[];
  allowFutureProcesses: boolean;
  persistent: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revision: number;
}

/**
 * Forma canónica do endpoint do fornecedor. Canónica SÓ onde não pode mudar o
 * destino: scheme e host em minúsculas, e o fragmento removido (é do cliente e
 * nunca chega a sair para o fornecedor). Tudo o resto é preservado EXACTAMENTE:
 * barras internas do caminho, barra terminal, ordem e repetição do query. Motivo:
 * `/tenant//v1` pode ser outro endpoint, e `?tenant=A&tenant=B` com a ordem trocada
 * pode ser resolvido para outro tenant pelo primeiro valor — colapsar ou ordenar
 * fundiria dois fornecedores diferentes numa chave só, que é exactamente o erro
 * que um grant persistente não pode cometer. O `/` terminal também não é cortado:
 * sem prova de que o SDK os trata igualmente, a identidade fecha-se por defeito.
 * O hash leva esta forma; a forma nunca é devolvida nem registada.
 */
export function endpointCanonica(bruto: string): string {
  const url = new URL(String(bruto).trim());
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
}

/**
 * Identidade do fornecedor SEM segredo: rótulo + endpoint canónico. A chave de API
 * nunca entra aqui, nem em nenhuma coluna, nem em nenhuma resposta.
 */
export function providerKeyDe(identidade: { provider: string; baseURL: string }): string {
  return createHash("sha256")
    .update(`${String(identidade.provider).trim().toLowerCase()}|${endpointCanonica(identidade.baseURL)}`)
    .digest("hex");
}

/**
 * Identificador OPACO desta instalação: um UUIDv4 gerado uma vez e guardado na BD
 * local. Não é hardware ID, não é derivado do utilizador, não é segredo.
 */
export function installationIdActual(): string {
  const db = getDb();
  const linha = db.prepare("SELECT id FROM app_installation LIMIT 1").get() as { id?: string } | undefined;
  if (linha?.id) return linha.id;
  const id = randomUUID();
  db.prepare("INSERT INTO app_installation (id, createdAt) VALUES (?, ?)").run(id, new Date().toISOString());
  return id;
}

export function descriptorActual(): DescritorConsent {
  return {
    providerKey: providerKeyDe({ provider: AI_CONFIG.provider, baseURL: AI_CONFIG.baseURL }),
    providerLabel: rotuloFornecedor(AI_CONFIG.provider),
    purpose: PURPOSE,
    fields: [...FIELDS_AUTORIZADOS],
    installationId: installationIdActual(),
    validityDays: VALIDITY_DAYS,
    oneShotTtlSeconds: ONE_SHOT_TTL_SECONDS,
  };
}

const ehHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);

/**
 * Sanificação do rótulo do fornecedor: sem espaços de controlo, colapsados, e 32
 * caracteres no máximo. O URL nunca entra aqui — pode levar tenant ou chave.
 * Vazio depois de limpo é `desconhecido`, nunca o valor cru do ambiente.
 */
export function rotuloFornecedor(bruto: unknown): string {
  const limpo = String(bruto ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 32);
  return limpo.length > 0 ? limpo : "desconhecido";
}

const mesmaLista = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/**
 * Forma EXACTA do corpo de POST: cinco chaves, tipos certos, as duas opções a
 * `true` literal. «Forma errada» é `invalid_request` (defeito do pedido); «forma
 * certa mas outra identidade» é recusa de autorização. São caminhos diferentes:
 * uma decisão da pessoa não se confunde com um bug da app.
 */
export function corpoExatoValido(body: unknown): { ok: true } | { ok: false; mensagem: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, mensagem: "O corpo do consentimento não é um objecto." };
  }
  const corpo = body as Record<string, unknown>;
  const esperadas = ["allowFutureProcesses", "fields", "persistent", "providerKey", "purpose"];
  const chaves = Object.keys(corpo).sort();
  if (chaves.length !== esperadas.length || !esperadas.every((k, i) => chaves[i] === esperadas[i])) {
    return { ok: false, mensagem: "O corpo do consentimento tem de trazer exactamente as cinco chaves pedidas." };
  }
  if (!ehHex64(corpo.providerKey)) return { ok: false, mensagem: "O identificador do fornecedor não tem a forma esperada." };
  if (typeof corpo.purpose !== "string" || corpo.purpose.length === 0 || corpo.purpose.length > 120) {
    return { ok: false, mensagem: "A finalidade pedida não tem a forma esperada." };
  }
  if (!Array.isArray(corpo.fields) || corpo.fields.length === 0 ||
    corpo.fields.some((f) => typeof f !== "string" || f.length === 0 || f.length > 60)) {
    return { ok: false, mensagem: "A lista de campos pedidos não tem a forma esperada." };
  }
  if (corpo.allowFutureProcesses !== true || corpo.persistent !== true) {
    return { ok: false, mensagem: "A escolha persistente exige `allowFutureProcesses: true` e `persistent: true`." };
  }
  return { ok: true };
}

type LinhaGrant = {
  id: string; userId: string; installationId: string; providerKey: string; purpose: string;
  fields: string; allowFutureProcesses: number; persistent: number;
  createdAt: string; expiresAt: string; revokedAt: string | null; revision: number;
};

function paraGrant(linha: LinhaGrant): GrantConsent {
  let fields: string[] = [];
  try { fields = JSON.parse(linha.fields) as string[]; } catch { fields = []; }
  return {
    id: linha.id,
    userId: linha.userId,
    installationId: linha.installationId,
    providerKey: linha.providerKey,
    purpose: linha.purpose,
    fields,
    allowFutureProcesses: linha.allowFutureProcesses === 1,
    persistent: linha.persistent === 1,
    createdAt: linha.createdAt,
    expiresAt: linha.expiresAt,
    revokedAt: linha.revokedAt ?? null,
    revision: linha.revision,
  };
}

/**
 * Um registo só é utilizável se for AUTO-CONSISTENTE. `Date.parse` aceita `NaN` e
 * o `<=` de `NaN` é sempre false, pelo que uma data corrompida passaria a
 * verificação de expiração «aberta» — exatamente o modo como um registo danificado
 * se transforma numa autorização perpétua. Aqui fecha-se: datas com a forma ISO
 * que o validador central exige, fim estritamente depois do início, validade nunca
 * acima do que foi escolhido, e `fields` como lista de textos. Um registo que
 * falha isto não é «expirado», é inválido, e não chega ao fornecedor.
 */
const isoExacta = (texto: unknown): number => {
  if (typeof texto !== "string") return NaN;
  const ms = Date.parse(texto);
  if (!Number.isFinite(ms)) return NaN;
  return new Date(ms).toISOString() === texto ? ms : NaN;
};

const MAX_MS_VALIDADE = VALIDITY_DAYS * 86_400_000;

function camposGuardados(linha: LinhaGrant): string[] | null {
  let interpretado: unknown;
  try { interpretado = JSON.parse(linha.fields); } catch { return null; }
  if (!Array.isArray(interpretado) || interpretado.length === 0) return null;
  return interpretado.every((c) => typeof c === "string" && c.length > 0 && c.length <= 60)
    ? (interpretado as string[]) : null;
}

function registoSano(linha: LinhaGrant): boolean {
  const criado = isoExacta(linha.createdAt);
  const expira = isoExacta(linha.expiresAt);
  if (!Number.isFinite(criado) || !Number.isFinite(expira)) return false;
  if (expira <= criado) return false;
  if (expira - criado > MAX_MS_VALIDADE) return false;
  if (typeof linha.purpose !== "string" || linha.purpose.length === 0) return false;
  if (!ehHex64(linha.providerKey)) return false;
  if (camposGuardados(linha) === null) return false;
  return Number.isInteger(linha.revision) && linha.revision >= 1;
}

/**
 * Criar um grant. A correspondência é sempre contra o descriptor ACTUAL: o
 * fornecedor tem de ser aquele que a app está a usar AGORA (mesmo rótulo com
 * outro endpoint é outro fornecedor e exige grant novo) e a finalidade/campos têm
 * de ser exactamente os autorizados. Nada é arredondado nem completado.
 */
export function criarGrant(userId: string, body: unknown): GrantConsent {
  const forma = corpoExatoValido(body);
  if (forma.ok === false) throw new Error(forma.mensagem);
  const corpo = body as { providerKey: string; purpose: string; fields: string[] };
  const descriptor = descriptorActual();
  if (corpo.providerKey.toLowerCase() !== descriptor.providerKey.toLowerCase()) {
    throw new ConsentDenial("process_consent_provider_mismatch",
      "A autorização não pode ser guardada: o fornecedor indicado não é aquele que a app está a usar.");
  }
  if (corpo.purpose !== descriptor.purpose || !mesmaLista(corpo.fields, descriptor.fields)) {
    throw new ConsentDenial("process_consent_scope_changed",
      "A autorização não pode ser guardada: a finalidade ou os campos pedidos não são os que estão autorizados.");
  }
  const db = getDb();
  const anterior = db.prepare(
    "SELECT MAX(revision) AS revisao FROM process_consent_grants WHERE userId = ? AND installationId = ?",
  ).get(userId, descriptor.installationId) as { revisao: number | null } | undefined;
  const revision = (anterior?.revisao ?? 0) + 1;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + descriptor.validityDays * 86_400_000).toISOString();
  db.prepare(`
    INSERT INTO process_consent_grants
      (id, userId, installationId, providerKey, purpose, fields, allowFutureProcesses, persistent, createdAt, expiresAt, revokedAt, revision)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, NULL, ?)
  `).run(id, userId, descriptor.installationId, descriptor.providerKey, descriptor.purpose,
    JSON.stringify(descriptor.fields), createdAt, expiresAt, revision);
  const linha = db.prepare("SELECT * FROM process_consent_grants WHERE id = ?").get(id) as LinhaGrant;
  return paraGrant(linha);
}

/**
 * O grant mais recente ainda válido desta conta nesta instalação. Expirado é
 * MARCADO como revogado (transição real, não filtro de apresentação) e deixa de
 * aparecer: «não perguntar outra vez» nunca significa «nunca mais expira».
 */
export function grantActivo(userId: string): GrantConsent | null {
  const db = getDb();
  const installationId = installationIdActual();
  const agora = new Date().toISOString();
  db.prepare(
    "UPDATE process_consent_grants SET revokedAt = ? WHERE userId = ? AND installationId = ? AND revokedAt IS NULL AND expiresAt <= ?",
  ).run(agora, userId, installationId, agora);
  const linha = db.prepare(
    "SELECT * FROM process_consent_grants WHERE userId = ? AND installationId = ? AND revokedAt IS NULL ORDER BY createdAt DESC, revision DESC LIMIT 20",
  ).all(userId, installationId) as LinhaGrant[];
  // Teto explícito: uma conta com histórico longo não transforma um GET em varredura.
  const sano = linha.find(registoSano);
  return sano ? paraGrant(sano) : null;
}/**
 * Decisão ANTES do fornecedor para um pedido que traz `consentGrantId`.
 * Estados distintos e não confundíveis: não existe / é de outra conta / é de
 * outra instalação / já foi revogado → `grant_invalid`; passou da data →
 * `expired`; o fornecedor actual deixou de ser o autorizado → `provider_mismatch`;
 * a finalidade ou os campos deixaram de ser os autorizados → `scope_changed`.
 * Qualquer um deles NEGÁVEL sem downgrade: nunca cai para o caminho one-shot.
 */
export function resolverGrantParaEnvio(opts: { userId: string; grantId: unknown }):
  { ok: true; grant: GrantConsent } | { ok: false; code: CodigoRecusaConsent; mensagem: string } {
  const { userId, grantId } = opts;
  if (typeof grantId !== "string" || grantId.length === 0 || grantId.length > 64) {
    return { ok: false, code: "process_consent_grant_invalid", mensagem: "O identificador de autorização não tem a forma esperada." };
  }
  const db = getDb();
  const linha = db.prepare("SELECT * FROM process_consent_grants WHERE id = ?").get(grantId) as LinhaGrant | undefined;
  if (!linha || linha.userId !== userId || linha.revokedAt !== null) {
    return { ok: false, code: "process_consent_grant_invalid",
      mensagem: "A autorização persistente deixa de estar disponível: o envio não acontece." };
  }
  // Corrompido não é o mesmo que expirado: um registo que não passa a sua própria
  // aritmética não pode ser apresentado como «autorização que caducou», nem como
  // autorização válida. Fecha-se como inválido e não chega ao fornecedor.
  if (!registoSano(linha)) {
    return { ok: false, code: "process_consent_grant_invalid",
      mensagem: "O registo da autorização não é consistente: o envio não acontece." };
  }
  const descriptor = descriptorActual();
  if (linha.installationId !== descriptor.installationId) {
    return { ok: false, code: "process_consent_grant_invalid",
      mensagem: "A autorização pertence a outra instalação: o envio não acontece." };
  }
  if (Date.parse(linha.expiresAt) <= Date.now()) {
    db.prepare("UPDATE process_consent_grants SET revokedAt = ? WHERE id = ?").run(new Date().toISOString(), linha.id);
    return { ok: false, code: "process_consent_expired",
      mensagem: "A autorização expirou: volta a ser preciso autorizar explicitamente." };
  }
  if (linha.providerKey.toLowerCase() !== descriptor.providerKey.toLowerCase()) {
    return { ok: false, code: "process_consent_provider_mismatch",
      mensagem: "O fornecedor mudou desde a autorização: o envio não acontece até autorizar de novo." };
  }
  const camposGuardadosNaLinha = camposGuardados(linha) ?? [];
  if (linha.purpose !== descriptor.purpose || !mesmaLista(camposGuardadosNaLinha, descriptor.fields)) {
    return { ok: false, code: "process_consent_scope_changed",
      mensagem: "A finalidade ou os campos autorizados deixaram de corresponder: o envio não acontece." };
  }
  if (linha.allowFutureProcesses !== 1 || linha.persistent !== 1) {
    return { ok: false, code: "process_consent_grant_invalid",
      mensagem: "A autorização não cobre processos futuros: o envio não acontece." };
  }
  return { ok: true, grant: paraGrant(linha) };
}

/**
 * Comparação do `consentProviderKey` que a UI manda (one-shot e persistente).
 * Presente e diferente do descriptor actual => recusar ANTES do fornecedor, mesmo
 * com `processConsent: true`. Ausente => caminho legado intacto.
 */
export function chaveDoPedidoBateActual(corpo: unknown): { presente: boolean; ok: boolean } {
  const chave = (corpo as { consentProviderKey?: unknown } | null)?.consentProviderKey;
  if (chave === undefined) return { presente: false, ok: true };
  if (typeof chave !== "string" || !ehHex64(chave)) return { presente: true, ok: false };
  return { presente: true, ok: chave.toLowerCase() === descriptorActual().providerKey.toLowerCase() };
}

/**
 * Revogação: fecha todos os grants desta conta NESTA instalação e, com eles, as
 * autorizações únicas ainda por consumir. Não alcança outras contas nem outras
 * instalações, e reporta o que fez em vez de prometer.
 *
 * Porque as duas coisas juntas: «revogar» é uma decisão sobre o FUTURO. Deixar uma
 * autorização única pendente viva depois de um DELETE era a porta pela qual a
 * revogação não revogava nada.
 */
export function revogarGrants(userId: string): { revoked: number; revokedOneShots: number; installationId: string } {
  const db = getDb();
  const installationId = installationIdActual();
  const agora = new Date().toISOString();
  const resultado = db.prepare(
    "UPDATE process_consent_grants SET revokedAt = ? WHERE userId = ? AND installationId = ? AND revokedAt IS NULL",
  ).run(agora, userId, installationId);
  const unicas = db.prepare(
    "UPDATE process_consent_one_shots SET revokedAt = ? WHERE userId = ? AND installationId = ? AND consumedAt IS NULL AND revokedAt IS NULL",
  ).run(agora, userId, installationId);
  return { revoked: resultado.changes, revokedOneShots: unicas.changes, installationId };
}

// ═══════════════════════════════════════════════════════════════════════════
// TP-MATRIX-R2-CONSENT — autorização única emitida e consumida pelo SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════
//
// Defeito que isto fecha: até à R1 a autorização «deste envio» era o booleano
// `processConsent: true` que vinha NO CORPO DO PEDIDO. Qualquer cliente (ou script)
// que escrevesse esse campo levava telemetria de processos ao fornecedor sem que
// ninguém tivesse autorizado nada — o servidor perguntava ao pedido se o pedido
// estava autorizado. Agora a autorização de um envio é um registo criado AQUI, por
// este processo, para ESTA conta, ESTA instalação, ESTE fornecedor, ESTES campos e
// ESTE alvo (pid + startedAt), com prazo curto e consumo atómico.
//
// O que continua guardado: metadados. O alvo é identificado por pid+início, que é o
// mínimo para amarrar «o processo que a pessoa apontou» — não há coluna para
// métricas, texto de conversa, chave ou URL.

export const ONE_SHOT_TTL_SECONDS = 120;
const ONE_SHOT_TTL_MS = ONE_SHOT_TTL_SECONDS * 1_000;

/** Forma que a UI envia para pedir autorização de um envio. Cinco chaves, exactas. */
const corpoUnicoValido = (body: unknown): { ok: true } | { ok: false; mensagem: string } => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, mensagem: "O corpo do pedido de autorização não é um objecto." };
  }
  const corpo = body as Record<string, unknown>;
  const esperadas = ["fields", "providerKey", "purpose", "target"];
  const chaves = Object.keys(corpo).sort();
  if (chaves.length !== esperadas.length || !esperadas.every((k, i) => chaves[i] === k)) {
    return { ok: false, mensagem: "O pedido de autorização tem de trazer exactamente as quatro chaves pedidas." };
  }
  if (!ehHex64(corpo.providerKey)) return { ok: false, mensagem: "O identificador do fornecedor não tem a forma esperada." };
  if (typeof corpo.purpose !== "string" || corpo.purpose.length === 0 || corpo.purpose.length > 120) {
    return { ok: false, mensagem: "A finalidade pedida não tem a forma esperada." };
  }
  if (!Array.isArray(corpo.fields) || corpo.fields.length === 0 ||
    corpo.fields.some((f) => typeof f !== "string" || f.length === 0 || f.length > 60)) {
    return { ok: false, mensagem: "A lista de campos pedidos não tem a forma esperada." };
  }
  const alvo = corpo.target as Record<string, unknown> | null;
  if (!alvo || typeof alvo !== "object" || Array.isArray(alvo)) {
    return { ok: false, mensagem: "O alvo da autorização não tem a forma esperada." };
  }
  const chavesAlvo = Object.keys(alvo).sort();
  if (chavesAlvo.length !== 2 || chavesAlvo[0] !== "pid" || chavesAlvo[1] !== "startedAt") {
    return { ok: false, mensagem: "O alvo da autorização tem de trazer pid e startedAt, e mais nada." };
  }
  if (typeof alvo.pid !== "number" || !Number.isInteger(alvo.pid) || alvo.pid <= 0 || alvo.pid > 0xffffffff) {
    return { ok: false, mensagem: "O pid do alvo não tem a forma esperada." };
  }
  if (!Number.isFinite(isoExacta(alvo.startedAt))) {
    return { ok: false, mensagem: "O início do alvo não é um instante ISO válido." };
  }
  return { ok: true };
};

export interface AutorizacaoUnica {
  /** Token opaco, devolvido UMA vez. A base só guarda o seu hash. */
  token: string;
  providerKey: string;
  purpose: string;
  fields: string[];
  target: { pid: number; startedAt: string };
  createdAt: string;
  expiresAt: string;
  ttlSeconds: number;
}

type LinhaAutorizacaoUnica = {
  id: string; tokenHash: string; userId: string; installationId: string; providerKey: string;
  purpose: string; fields: string; targetPid: number; targetStartedAt: string;
  createdAt: string; expiresAt: string; consumedAt: string | null; revokedAt: string | null;
};

const hashDoToken = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenComForma = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

function registoUnicoSano(linha: LinhaAutorizacaoUnica): boolean {
  const criado = isoExacta(linha.createdAt);
  const expira = isoExacta(linha.expiresAt);
  if (!Number.isFinite(criado) || !Number.isFinite(expira)) return false;
  if (expira <= criado) return false;
  if (expira - criado > ONE_SHOT_TTL_MS) return false;
  if (typeof linha.purpose !== "string" || linha.purpose.length === 0) return false;
  if (!ehHex64(linha.providerKey)) return false;
  if (camposGuardados(linha as unknown as LinhaGrant) === null) return false;
  if (!Number.isInteger(linha.targetPid) || linha.targetPid <= 0 || linha.targetPid > 0xffffffff) return false;
  if (!Number.isFinite(isoExacta(linha.targetStartedAt))) return false;
  return typeof linha.tokenHash === "string" && /^[0-9a-f]{64}$/.test(linha.tokenHash);
}

/**
 * Emite a autorização de UM envio, para UM alvo, contra o descriptor ACTUAL.
 * Emitir outra invalida a anterior ainda por consumir: não se acumulam autorizações
 * pendentes para a mesma conta/instalação. Fornecedor, finalidade ou campos
 * diferentes do descriptor actual são recusados — a autorização nasce amarrada ao
 * que a app está a usar AGORA, não ao que o cliente diz que ela usa.
 */
export function criarAutorizacaoUnica(userId: string, body: unknown): AutorizacaoUnica {
  const forma = corpoUnicoValido(body);
  if (forma.ok === false) throw new Error(forma.mensagem);
  const corpo = body as { providerKey: string; purpose: string; fields: string[]; target: { pid: number; startedAt: string } };
  const descriptor = descriptorActual();
  if (corpo.providerKey.toLowerCase() !== descriptor.providerKey.toLowerCase()) {
    throw new ConsentDenial("process_consent_provider_mismatch",
      "A autorização não pode ser emitida: o fornecedor indicado não é aquele que a app está a usar.");
  }
  if (corpo.purpose !== descriptor.purpose || !mesmaLista(corpo.fields, descriptor.fields)) {
    throw new ConsentDenial("process_consent_scope_changed",
      "A autorização não pode ser emitida: a finalidade ou os campos pedidos não são os que estão autorizados.");
  }
  const db = getDb();
  const installationId = descriptor.installationId;
  const agora = new Date();
  const createdAt = agora.toISOString();
  const expiresAt = new Date(agora.getTime() + ONE_SHOT_TTL_MS).toISOString();
  // Nenhuma autorização pendente sobrevive à emissão de outra: um cliente que peça
  // autorização duas vezes não fica com duas chaves para o mesmo envio.
  db.prepare(
    "UPDATE process_consent_one_shots SET revokedAt = ? WHERE userId = ? AND installationId = ? AND consumedAt IS NULL AND revokedAt IS NULL",
  ).run(createdAt, userId, installationId);
  const token = randomUUID();
  db.prepare(`
    INSERT INTO process_consent_one_shots
      (id, tokenHash, userId, installationId, providerKey, purpose, fields, targetPid, targetStartedAt, createdAt, expiresAt, consumedAt, revokedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    randomUUID(), hashDoToken(token), userId, installationId, descriptor.providerKey, descriptor.purpose,
    JSON.stringify(descriptor.fields), corpo.target.pid, corpo.target.startedAt, createdAt, expiresAt,
  );
  return {
    token, providerKey: descriptor.providerKey, purpose: descriptor.purpose,
    fields: [...descriptor.fields], target: { pid: corpo.target.pid, startedAt: corpo.target.startedAt },
    createdAt, expiresAt, ttlSeconds: ONE_SHOT_TTL_SECONDS,
  };
}

/**
 * A medição cabe no alvo autorizado?
 *
 * Achado da revisão R2: comparar só `selectedProcess` deixava um token emitido para A
 * levar as medições de B dentro do MESMO pedido — o validador central aceita até cinco
 * `topProcesses` e `trends` de qualquer um deles, pelo que «alvo A» não limitava nada
 * sobre o resto. Uma autorização única para A autoriza A: qualquer identidade
 * (pid + início) diferente de A em `topProcesses` ou em `trends` está fora do âmbito.
 * Não se FILTRA em silêncio: filtrar mudaria o significado de «top process» apresentado
 * ao utilizador. Recusa-se, e o cliente estreita o payload ao alvo que a pessoa
 * autorizou (ram/cpuPercent globais continuam campos permitidos, como antes).
 * O grant persistente NÃO passa por aqui: cobre processos futuros por definição.
 */
export function medicaoDentroDoAlvo(payload: unknown, target: { pid: number; startedAt: string }): boolean {
  const medicao = (payload as {
    processIntelligence?: { topProcesses?: unknown; trends?: unknown; selectedProcess?: unknown };
  } | null)?.processIntelligence;
  if (!medicao || typeof medicao !== "object") return false;
  const mesmaIdentidade = (e: unknown) => {
    const entrada = e as { pid?: unknown; startedAt?: unknown } | null;
    return !!entrada && typeof entrada === "object"
      && entrada.pid === target.pid && entrada.startedAt === target.startedAt;
  };
  const tops = Array.isArray(medicao.topProcesses) ? medicao.topProcesses : [];
  const trends = Array.isArray(medicao.trends) ? medicao.trends : [];
  return mesmaIdentidade(medicao.selectedProcess) && tops.every(mesmaIdentidade) && trends.every(mesmaIdentidade);
}

/**
 * Confere a autorização única SEM a gastar: identidade, estado, prazo, fornecedor,
 * âmbito e alvo — e agora também que a medição não inclui outros processos.
 *
 * O consumo é acto separado (`consumirAutorizacaoUnica`) de propósito: a forma do
 * pedido e o payload são decididos antes, pelo que um pedido inválido não queima a
 * autorização; só a tentativa real de envio a consome.
 */
export function conferirAutorizacaoUnica(opts: { userId: string; token: unknown; payload: unknown }):
  { ok: true; tokenHash: string } | { ok: false; code: CodigoRecusaConsent; mensagem: string } {
  const { userId, token, payload } = opts;
  if (!tokenComForma(token)) {
    return { ok: false, code: "process_consent_authorization_invalid",
      mensagem: "A autorização deste envio não tem a forma esperada: o envio não acontece." };
  }
  const db = getDb();
  const linha = db.prepare("SELECT * FROM process_consent_one_shots WHERE tokenHash = ?")
    .get(hashDoToken(token)) as LinhaAutorizacaoUnica | undefined;
  if (!linha || linha.userId !== userId || linha.revokedAt !== null) {
    return { ok: false, code: "process_consent_authorization_invalid",
      mensagem: "A autorização deste envio deixa de estar disponível: o envio não acontece." };
  }
  if (!registoUnicoSano(linha)) {
    return { ok: false, code: "process_consent_authorization_invalid",
      mensagem: "O registo da autorização não é consistente: o envio não acontece." };
  }
  const descriptor = descriptorActual();
  if (linha.installationId !== descriptor.installationId) {
    return { ok: false, code: "process_consent_authorization_invalid",
      mensagem: "A autorização pertence a outra instalação: o envio não acontece." };
  }
  if (Date.parse(linha.expiresAt) <= Date.now()) {
    db.prepare("UPDATE process_consent_one_shots SET revokedAt = ? WHERE tokenHash = ?")
      .run(new Date().toISOString(), linha.tokenHash);
    return { ok: false, code: "process_consent_authorization_expired",
      mensagem: "A autorização deste envio expirou: volta a ser preciso autorizar." };
  }
  if (linha.providerKey.toLowerCase() !== descriptor.providerKey.toLowerCase()) {
    return { ok: false, code: "process_consent_provider_mismatch",
      mensagem: "O fornecedor mudou desde a autorização: o envio não acontece até autorizar de novo." };
  }
  const campos = camposGuardados(linha as unknown as LinhaGrant) ?? [];
  if (linha.purpose !== descriptor.purpose || !mesmaLista(campos, descriptor.fields)) {
    return { ok: false, code: "process_consent_scope_changed",
      mensagem: "A finalidade ou os campos autorizados deixaram de corresponder: o envio não acontece." };
  }
  // O alvo autorizado é confrontado com a MEDIÇÃO do pedido (não com o corpo):
  // `processIntelligence.selectedProcess` é o processo que a pessoa apontou, e é
  // isso — pid + início — que a autorização nomeia. Ler outra chave aqui deixaria
  // a comparação sempre vazia, que é o mesmo que não comparar nada.
  const alvoAutorizado = { pid: linha.targetPid, startedAt: linha.targetStartedAt };
  if (!medicaoDentroDoAlvo(payload, alvoAutorizado)) {
    const seleccionado = (payload as { processIntelligence?: { selectedProcess?: { pid?: unknown; startedAt?: unknown } | null } } | null)
      ?.processIntelligence?.selectedProcess;
    // Alvo errado e medição a mais são recusas diferentes: a primeira diz «não é
    // este processo», a segunda diz «este processo veio acompanhado de outros».
    if (!seleccionado || seleccionado.pid !== linha.targetPid || seleccionado.startedAt !== linha.targetStartedAt) {
      return { ok: false, code: "process_consent_target_mismatch",
        mensagem: "A autorização foi dada para outro alvo: este envio não acontece." };
    }
    return { ok: false, code: "process_consent_payload_out_of_scope",
      mensagem: "A medição inclui processos além do alvo autorizado: este envio não acontece." };
  }
  return { ok: true, tokenHash: linha.tokenHash };
}

/**
 * Consome (uma única vez) a autorização já conferida, imediatamente antes do envio.
 * A atomicidade vive na própria UPDATE: duas tentativas concorrentes com o mesmo
 * token, só uma vê `changes === 1`.
 */
export function consumirAutorizacaoUnica(opts: { userId: string; tokenHash: string }):
  { ok: true } | { ok: false; code: CodigoRecusaConsent; mensagem: string } {
  const consumido = getDb().prepare(
    "UPDATE process_consent_one_shots SET consumedAt = ? WHERE tokenHash = ? AND userId = ? AND consumedAt IS NULL AND revokedAt IS NULL",
  ).run(new Date().toISOString(), opts.tokenHash, opts.userId);
  if (consumido.changes !== 1) {
    return { ok: false, code: "process_consent_authorization_used",
      mensagem: "Esta autorização já foi usada: cada autorização vale para um envio." };
  }
  return { ok: true };
}
