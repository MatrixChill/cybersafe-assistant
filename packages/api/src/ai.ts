import { parseParentAiConfiguration } from "./ai-parent-config.js";
import dotenv from "dotenv";
// Carrega .env ANTES de ler a configuração (ESM hoista imports: precisa de
// correr aqui para o config abaixo já ver as variáveis de ambiente).
dotenv.config();
import OpenAI from "openai";
import type express from "express";

// ── Configuração via ambiente (padrão OpenAI-compatible) ──
//   CYBERSAFE_AI_PROVIDER   -> rótulo do provider (ex.: groq, openai, custom)
//   CYBERSAFE_AI_API_KEY    -> chave da API (fallback: GROQ_API_KEY / OPENAI_API_KEY)
//   CYBERSAFE_AI_BASE_URL   -> base URL OpenAI-compatible (default: Groq)
//   CYBERSAFE_AI_MODEL      -> modelo (default: openai/gpt-oss-120b — verificado em 2026-10-14: groq/compound não consta na lista /models desta conta; llama-3.1-8b-instant também já não é servido)
export const AI_CONFIG = (() => {
  const apiKey = process.env.CYBERSAFE_AI_PARENT_CONFIG === "1" ? "" :
    process.env.CYBERSAFE_AI_API_KEY?.trim() ||
    process.env.GROQ_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  return {
    provider: process.env.CYBERSAFE_AI_PARENT_CONFIG === "1" ? "groq" : process.env.CYBERSAFE_AI_PROVIDER?.trim() || "groq",
    apiKey,
    baseURL: process.env.CYBERSAFE_AI_PARENT_CONFIG === "1" ? "https://api.groq.com/openai/v1" : process.env.CYBERSAFE_AI_BASE_URL?.trim() || "https://api.groq.com/openai/v1",
    model: process.env.CYBERSAFE_AI_MODEL?.trim() || "openai/gpt-oss-120b",
    maxHistory: 16,
    maxTokens: 400,
    temperature: 0.7,
  };
})();

export let aiEnabled = AI_CONFIG.apiKey.length > 0;

// Nunca logamos a chave — apenas provider/modelo (sem segredos).
if (aiEnabled) {
  console.log(`[AI] Provider=${AI_CONFIG.provider} model=${AI_CONFIG.model} baseURL=${AI_CONFIG.baseURL}`);
} else {
  console.log("[AI] Sem chave configurada — a matriz fica em MODO LOCAL (falha graciosa).");
}

let client = new OpenAI({
  apiKey: AI_CONFIG.apiKey || "missing-key",
  baseURL: AI_CONFIG.baseURL,
});

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Persona & política da Matrix ──
// Nota: esta é a INSTRUÇÃO do modelo. Mudanças de tom/comprimento são feitas
// aqui (e nas regras abaixo), nunca com respostas hardcoded na UI.
const PERSONA = `Tu és a Matrix, a assistente de IA do CyberSafe. Falas português europeu, de forma natural e humana — como uma amiga inteligente, não como um manual nem como um call-center.

REGRA DE OURO — RESPONDE PRIMEIRO AO QUE FOI PEDIDO:
- Responde À LETRA ao pedido do utilizador. Se ele disser "diga só oi", responde "Oi!" e nada mais — sem apresentação, sem explicação, sem emoji extra, sem conselho, sem pergunta final.
- Se ele disser "resumido", "curto", "só...", "mais nada", obedece estritamente ao que foi pedido.

COMPRIMENTO — REGRA RÍGIDA:
- Por defeito: MÁXIMO 1 a 3 frases. Uma pergunta simples = uma resposta curta. NUNCA mais de 4 frases sem pedido explícito de detalhe.
- Nunca listes "8 motivos", "5 dicas" ou listas longas por iniciativa própria. Se tiveres vários pontos, escolhe os 1-2 mais relevantes.
- Expande APENAS quando o utilizador pedir explicitamente ("detalha", "explica mais", "passo a passo", "relatório completo").
- NUNCA respondas com tabelas, headings markdown ou listas numeradas em perguntas simples. Responde em prosa curta.
- Se a resposta couber em 1 frase, usa 1 frase. Não enches de palavras.

NATURALIDADE:
- Não te apresentes repetidamente. Sais que és a Matrix; não precisas de o dizer em cada resposta.
- Zero marketing do produto. Não promovas funcionalidades, VPN, 2FA, limpezas, reinícios ou atualizações a não ser que isso responda à pergunta concreta.
- NUNCA despejes o estado do sistema (protection score, CPU, RAM, disco, quarentena) se o utilizador não pediu. Usa esses dados apenas quando a pergunta os pede.
- Respeita a preferência recente na conversa: se o utilizador pediu "fala mais resumido", mantém-te breve continuamente até ele pedir mais detalhe.
- Quando o utilizador fizer uma pergunta sobre algo específico (phishing, link, ameaça, ficheiro), responde sobre ESSA coisa concreta — nunca listes teoria geral nem dês uma aula sobre o tema. Responde ao caso real.

EMOJIS: no máximo 0-1, apenas quando combinar com a conversa. Nada de 🚀🛡️😄 em cada resposta.

HONESTIDADE — nunca inventar:
- Podes receber um bloco [CONTEXTO CYBERSAFE] com dados reais do PC. Usa-os para responder com precisão, mas NUNCA os recites de fonte formada — o contexto serve para RESPONDER, não para ser repetido.
- Distingue observação de hipótese. Se não houver dados que respondam, diz isso naturalmente, ou pede a informação que falta.
- Se a proteção estiver degradada, não digas "está 100% seguro". Diz algo como: "Não há ameaça crítica agora, mas a proteção está degradada porque alguns componentes precisam de atenção."
SEGURANÇA — continua a ser defensiva:
- Se pedirem construção de malware, ransomware, roubo de credenciais, phishing operacional, invasão, persistência maliciosa, evasão de antivírus, exploração ofensiva ou destruição de dados: NÃO forneças instruções perigosas. Recusa com naturalidade e oferece apenas a vertente defensiva (deteção, prevenção, mitigação, recuperação, educação).
- Ajuda com entusiasmo quando o assunto é legítimo e educativo.

PRIVACIDADE: nunca peças passwords, tokens ou chaves API. Se o utilizador colar segredos, avisa para NÃO os partilhar no chat e para os revogar. Não registes nem repitas segredos.`;


export function buildContextBlock(context?: string, page?: string): string {
  const parts: string[] = [];
  if (page) parts.push(`Página atual do CyberSafe: ${page}`);
  if (context && context.trim()) parts.push(context.trim());
  return parts.join("\n");
}

// ── Construção das mensagens (limita histórico no servidor) ──
export function buildMessages(
  userMessages: AiMessage[],
  context?: string,
  page?: string,
): AiMessage[] {
  const systemContent = PERSONA;
  const ctx = buildContextBlock(context, page);
  const system = ctx
    ? `${systemContent}\n\n[CONTEXTO CYBERSAFE]\n${ctx}\nUsa os dados acima quando fizerem sentido. Não inventes o que não está lá. Não os recites na resposta.`
    : systemContent;

  // O cliente envia mensagens com papéis user/assistant. O papel `system` (a
  // persona e a política) é SEMPRE montado aqui no servidor — um `system` vindo
  // do cliente é descartado, nunca pode reescrever a persona nem injetar regras.
  const safe = Array.isArray(userMessages)
    ? userMessages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
    : [];

  const trimmed = safe.slice(-AI_CONFIG.maxHistory);
  return [{ role: "system", content: system }, ...trimmed];
}

// ── GUARD DE CREDENCIAIS (P0 privacidade) ────────────────────────────────────
// O cliente monta o payload (mensagem nova + histórico + contexto + page) e ele
// sai SEM redação para o fornecedor externo. Este guard corre NA API, ANTES de
// buildMessages e do SDK, e recusa pedidos cujo conteúdo tenha padrões
// reconhecíveis de credenciais — chaves privadas, tokens, chaves de API,
// cadeias de ligação com palavra-passe e atribuições óbvias de password.
//
// REGRAS:
//  · Aplica-se igualmente a message, history, context e page — e aos dois
//    modos (stream e JSON), porque entra nas duas funções de chat.
//  · O erro é ESTÁVEL (código + mensagem fixos) e NÃO ecoa o conteúdo recusado.
//  · O texto recusado NÃO é guardado nem logado: a violação carrega apenas o
//    campo, o índice (para mensagens) e o padrão que disparou.
//  · Conteúdo permitido passa intacto (o guard só lê, nunca reescreve).
export const CREDENTIAL_BLOCKED_CODE = "credential_blocked" as const;
export const CREDENTIAL_BLOCKED_MESSAGE =
  "O pedido foi recusado: o conteúdo parece conter uma credencial ou segredo (chave, token, palavra-passe ou cadeia de ligação). Remove esses dados do chat e tenta novamente.";

interface SecretPattern {
  name: string;
  re: RegExp;
}

// Regex sem flag /g: stateless, sem estado lastIndex entre chamadas.
const SECRET_PATTERNS: SecretPattern[] = [
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i },
  { name: "putty-key", re: /PuTTY-User-Key-File-\d+/i },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}=*/i },
  { name: "connection-string", re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqp|amqps|mssql|sqlserver):\/\/[^\s:@/]+:[^\s@/]+@/i },
  // Atribuição de password: só quando o valor parece mesmo um segredo —
  // entre aspas, com dígito, ou suficientemente longo. Evita falsos positivos
  // como «o campo password: obrigatório».
  { name: "password-assignment", re: /\b(?:password|passwd|pwd|senha)\b\s*[:=]\s*(?:"[^"]{3,}"|'[^']{3,}'|[^\s"']*\d[^\s"']{2,}|[^\s"']{12,})/i },
  { name: "secret-assignment", re: /\b(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/i },
  { name: "secret-in-query", re: /[?&](?:token|api_key|apikey|access_token|key|secret)=[A-Za-z0-9._-]{8,}/i },
];

// ── VALIDAÇÃO DE FORMA DO PEDIDO (P0 — fecha o bypass de tipos) ──────────────
// O guard de credenciais só sabia ler TEXTO. Um cliente podia enviar
// `content: [segredo]` ou `page: [segredo]`: o guard saltava (não era string) e
// o `String(m.content)` de buildMessages transformava-o em texto que saía para o
// fornecedor. Aqui o pedido é validado ANTES do guard, do buildMessages e do
// SDK, e o que não respeitar a forma é RECUSADO (fail-closed) — nunca coagido.
//
// REGRAS:
//  · `messages` é opcional, mas quando existe tem de ser uma lista de objetos
//    com `content` em TEXTO (o papel é filtrado depois, em buildMessages).
//  · `context` e `page`, quando existem, têm de ser texto.
//  · Limites explícitos de contagem/tamanho: recusa, não trunca em silêncio.
//  · A recusa é ESTÁVEL, devolve só a razão (nome do campo) e nunca o conteúdo.
export const INVALID_REQUEST_CODE = "invalid_request" as const;
export const INVALID_REQUEST_MESSAGE =
  "O pedido foi recusado: o formato dos dados não é o esperado (messages tem de ser uma lista de mensagens com conteúdo em texto; context e page têm de ser texto).";

export const MAX_MESSAGES = 500;
export const MAX_MESSAGE_CHARS = 100_000;
export const MAX_CONTEXT_CHARS = 100_000;

export interface RequestShapeInput {
  messages?: unknown;
  context?: unknown;
  page?: unknown;
}

/**
 * Devolve a RAZÃO da recusa (nunca o conteúdo), ou null se o pedido for válido.
 */
export function findShapeViolation(input: RequestShapeInput): string | null {
  const { messages } = input;
  if (messages !== undefined) {
    if (!Array.isArray(messages)) return "messages não é uma lista";
    if (messages.length > MAX_MESSAGES) return "messages excede o número máximo de entradas";
    for (const entry of messages) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return "messages contém uma entrada inválida";
      }
      const content = (entry as { content?: unknown }).content;
      if (typeof content !== "string") return "messages contém conteúdo que não é texto";
      if (content.length > MAX_MESSAGE_CHARS) return "uma mensagem excede o tamanho máximo";
    }
  }
  const extra: Array<[string, unknown]> = [
    ["context", input.context],
    ["page", input.page],
  ];
  for (const [field, value] of extra) {
    if (value === undefined) continue;
    if (typeof value !== "string") return `${field} não é texto`;
    if (value.length > MAX_CONTEXT_CHARS) return `${field} excede o tamanho máximo`;
  }
  return null;
}

/** Lança o erro ESTÁVEL se o pedido não respeitar a forma esperada. */
export function assertRequestShape(input: RequestShapeInput): void {
  if (findShapeViolation(input)) {
    throw new MatrixAiError(INVALID_REQUEST_CODE, INVALID_REQUEST_MESSAGE, 400);
  }
}

export interface OutboundViolation {
  /** Onde estava o segredo, para o registo (nunca o segredo em si). */
  field: "message" | "history" | "context" | "page";
  /** Índice dentro de `messages`, quando `field` é message/history. */
  index?: number;
  /** Nome do padrão que disparou. */
  pattern: string;
}

function scanText(
  text: unknown,
  field: OutboundViolation["field"],
  index?: number,
): OutboundViolation | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const normalized = text.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(normalized)) return { field, index, pattern: pattern.name };
  }
  return null;
}

/**
 * Procura conteúdo suspeito no que vai PARA FORA. Última mensagem = "message";
 * as anteriores = "history" (tanto faz qual é nova ou antiga no array: todas
 * saem para o fornecedor). Devolution estável, sem nunca conter o texto.
 */
export function findOutboundViolation(input: {
  messages?: AiMessage[];
  context?: string;
  page?: string;
}): OutboundViolation | null {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  // Da mais recente para a mais antiga: o segredo mais provável é o que o
  // utilizador acabou de escrever.
  for (let i = messages.length - 1; i >= 0; i--) {
    const violation = scanText(messages[i]?.content, i === messages.length - 1 ? "message" : "history", i);
    if (violation) return violation;
  }
  const extraViolation = scanText(input.context, "context") ?? scanText(input.page, "page");
  if (extraViolation) return extraViolation;
  // Conservative detection of adjacent fragments across the outbound fields.
  // Normalize only the inspection view; never rewrite the provider payload.
  const fragments = [input.page, input.context, ...messages.map(message => message?.content)]
    .filter((text): text is string => typeof text === "string");
  return scanText(fragments.join(""), "message");
}

/** Lança o erro ESTÁVEL se o pedido contiver um segredo reconhecível. */
export function assertOutboundSafe(input: {
  messages?: AiMessage[];
  context?: string;
  page?: string;
}): void {
  const violation = findOutboundViolation(input);
  if (violation) {
    throw new MatrixAiError(CREDENTIAL_BLOCKED_CODE, CREDENTIAL_BLOCKED_MESSAGE, 400);
  }
}

export type AiErrorKind =
  | "no_provider"
  | "rate_limited"
  | "auth"
  | "timeout"
  | "aborted"
  | "network"
  | "model_unavailable"
  | "provider_unavailable"
  | "provider_rejected"
  | "credential_blocked"
  | "invalid_request"
  | "unknown";

export class MatrixAiError extends Error {
  kind: AiErrorKind;
  status?: number;
  constructor(kind: AiErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export function classifyError(err: unknown, aborted = false): MatrixAiError {
  if (aborted) return new MatrixAiError("aborted", "Pedido cancelado.");
  const e = err as { status?: number; code?: string; name?: string; message?: string };
  if (e?.status === 429) return new MatrixAiError("rate_limited", "Limite de pedidos atingido. Tenta novamente em breve.", 429);
  if (e?.status === 401 || e?.status === 403) return new MatrixAiError("auth", "A chave da IA é inválida ou sem permissão.", e.status);
  if (e?.name === "AbortError" || e?.code === "ECONNABORTED") return new MatrixAiError("timeout", "O serviço de IA demorou demasiado.", 408);
  if (e?.status === 404) return new MatrixAiError("model_unavailable", "O modelo configurado não está disponível para esta conta. Verifica CYBERSAFE_AI_MODEL.", 404);
  if (e?.name === "APIConnectionTimeoutError") return new MatrixAiError("timeout", "O serviço de IA demorou demasiado.", 408);
  // Um número de estado HTTP é a prova de que a ligação FAILHOU NÃO: o provider
  // respondeu. Chamar-lhe «network» manda o utilizador para a rede quando a
  // avaria é do serviço (5xx) ou do próprio pedido (outros 4xx), e a UI decide
  // retry com base nessa diferença. Só o que não tem estado é ligação.
  if (typeof e?.status === "number" && e.status >= 500 && e.status <= 599)
    return new MatrixAiError("provider_unavailable", "O serviço de IA está indisponível neste momento. Tenta novamente daqui a pouco.", 503);
  if (typeof e?.status === "number" && e.status >= 400 && e.status <= 499)
    return new MatrixAiError("provider_rejected", "O serviço de IA recusou este pedido.", e.status);
  if (e && "message" in e) return new MatrixAiError("network", "Não foi possível ligar ao serviço de IA.");
  return new MatrixAiError("unknown", "Erro desconhecido do serviço de IA.");
}

// ── Sonda de disponibilidade do provider (sem expor segredos) ──
// Verdade única para o estado ONLINE/LOCAL: a chave existir (aiEnabled) NÃO
// garante que o provider esteja acessível. Consultar /models é barato e não
// gera tokens. Resultado em cache breve para não martelar o provider.
let availabilityCache: { checkedAt: number; reachable: boolean } | null = null;
const AVAILABILITY_CACHE_MS = 15_000;
let configurationAbort = new AbortController();
let availabilityError: string | null = null;
export const aiAvailabilityError = () => availabilityError;
export function applyParentAiConfiguration(message: unknown): boolean {
  const parsed = parseParentAiConfiguration(message);
  if (!parsed) return false;
  configurationAbort.abort(); configurationAbort = new AbortController();
  Object.assign(AI_CONFIG, parsed.config);
  aiEnabled = AI_CONFIG.apiKey.length > 0;
  client = new OpenAI({ apiKey: AI_CONFIG.apiKey || "missing-key", baseURL: AI_CONFIG.baseURL });
  availabilityCache = null; availabilityError = null;
  return true;
}
if (process.send && process.env.CYBERSAFE_AI_PARENT_CONFIG === "1") {
  process.on("message", (message) => {
    const parsed = parseParentAiConfiguration(message);
    if (!parsed) return;
    const ok = applyParentAiConfiguration(message);
    try { process.send?.({ type: "cybersafe-ai-configured", id: parsed.id, ok }, () => {}); } catch { /* parent closed */ }
  });
}

export async function checkAiAvailability(): Promise<boolean> {
  const cached = availabilityCache;
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_CACHE_MS) {
    return cached.reachable;
  }
  if (!aiEnabled) {
    availabilityCache = { checkedAt: Date.now(), reachable: false };
    return false;
  }
  const current = configurationAbort;
  try {
    await client.models.list({ timeout: 3500, signal: current.signal });
    if (current !== configurationAbort) return false;
    availabilityError = null;
    availabilityCache = { checkedAt: Date.now(), reachable: true };
  } catch (error) {
    if (current !== configurationAbort) return false;
    availabilityError = classifyError(error).kind;
    availabilityCache = { checkedAt: Date.now(), reachable: false };
  }
  return availabilityCache.reachable;
}

// ── Chat não-streaming (JSON) ──
/** Limite do pedido JSON ao provider: sem isto um provider lento prende a rota indefinidamente. */
export const AI_REQUEST_TIMEOUT_MS = 30_000;

export async function chatCompletion(
  userMessages: AiMessage[],
  context?: string,
  page?: string,
  signal?: AbortSignal,
): Promise<string> {
  signal = AbortSignal.any([configurationAbort.signal, ...(signal ? [signal] : [])]);
  // Forma do pedido primeiro: um pedido malformado é recusado mesmo que o
  // provider esteja indisponível — é erro do cliente, não do serviço.
  assertRequestShape({ messages: userMessages, context, page });
  if (!aiEnabled) {
    throw new MatrixAiError("no_provider", "IA indisponível: sem chave de provider configurada.", 503);
  }
  // Guard central (P0): recusa credenciais ANTES de buildMessages e do SDK.
  // Aplica-se a message + history (o array), context e page. Erro estável, sem
  // ecoar nem registar o conteúdo recusado.
  assertOutboundSafe({ messages: userMessages, context, page });
  const messages = buildMessages(userMessages, context, page);
  try {
    const completion = await client.chat.completions.create(
      {
        model: AI_CONFIG.model,
        messages: messages as any,
        temperature: AI_CONFIG.temperature,
        max_tokens: AI_CONFIG.maxTokens,
      },
      { timeout: AI_REQUEST_TIMEOUT_MS, signal },
    );
    return completion.choices[0]?.message?.content || "";
  } catch (err) {
    throw classifyError(err);
  }
}

// ── Chat com streaming (SSE, OpenAI-compatible quando o provider suporta) ──
export async function streamChatCompletion(
  res: express.Response,
  req: express.Request,
  userMessages: AiMessage[],
  context?: string,
  page?: string,
): Promise<void> {
  // Forma do pedido antes de tudo (fecha o bypass de tipos também no stream).
  if (findShapeViolation({ messages: userMessages, context, page })) {
    if (!res.headersSent) {
      res.status(400).json({ message: INVALID_REQUEST_MESSAGE, code: INVALID_REQUEST_CODE });
    }
    return;
  }
  if (!aiEnabled) {
    res.status(503).json({ message: "IA indisponível: sem chave de provider configurada.", code: "no_provider" });
    return;
  }

  // Guard central (P0): recusa credenciais ANTES de abrir headers, de
  // buildMessages e do SDK. Stream e JSON usam o mesmo filtro — um segredo
  // nunca chega ao fornecedor em nenhum dos modos.
  const violation = findOutboundViolation({ messages: userMessages, context, page });
  if (violation) {
    if (!res.headersSent) {
      res.status(400).json({ message: CREDENTIAL_BLOCKED_MESSAGE, code: CREDENTIAL_BLOCKED_CODE });
    }
    return;
  }

  const messages = buildMessages(userMessages, context, page);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (obj: Record<string, unknown>) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const controller = new AbortController();
  let aborted = false;
  // NOTA: `req.on("close")` dispara logo após o body ser consumido (não é
  // desligamento). Usamos `res.on("close")` + `writableEnded` para detetar
  // uma desconexão real do cliente e cancelar o upstream.
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      controller.abort();
    }
  });

  const TIMEOUT_MS = 60_000;
  const timer = setTimeout(() => {
    aborted = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const stream = await client.chat.completions.create(
      {
        model: AI_CONFIG.model,
        messages: messages as any,
        temperature: AI_CONFIG.temperature,
        max_tokens: AI_CONFIG.maxTokens,
        stream: true,
      },
      { signal: AbortSignal.any([controller.signal, configurationAbort.signal]) },
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        send({ delta });
      }
    }

    if (!aborted) {
      send({ done: true });
      res.end();
    }
  } catch (err) {
    clearTimeout(timer);
    const apiErr = classifyError(err, aborted);
    if (apiErr.kind === "aborted") {
      if (res.writable && !res.writableEnded) res.end();
      return;
    }
    if (res.writable && !res.writableEnded) {
      // Se ainda não escrevemos nada, devolve o status real (429/503/etc.).
      if (!res.headersSent) {
        res.status(apiErr.status && apiErr.status >= 400 && apiErr.status < 500 ? apiErr.status : 500);
        res.json({ message: apiErr.message, code: apiErr.kind });
      } else {
        send({ error: apiErr.kind, message: apiErr.message });
        res.end();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}