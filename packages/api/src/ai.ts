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
//   CYBERSAFE_AI_MODEL      -> modelo (default: groq/compound — o antigo llama-3.1-8b-instant foi retirado do parque)
export const AI_CONFIG = (() => {
  const apiKey =
    process.env.CYBERSAFE_AI_API_KEY?.trim() ||
    process.env.GROQ_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  return {
    provider: process.env.CYBERSAFE_AI_PROVIDER?.trim() || "groq",
    apiKey,
    baseURL: process.env.CYBERSAFE_AI_BASE_URL?.trim() || "https://api.groq.com/openai/v1",
    model: process.env.CYBERSAFE_AI_MODEL?.trim() || "groq/compound",
    maxHistory: 16,
    maxTokens: 400,
    temperature: 0.7,
  };
})();

export const aiEnabled = AI_CONFIG.apiKey.length > 0;

// Nunca logamos a chave — apenas provider/modelo (sem segredos).
if (aiEnabled) {
  console.log(`[AI] Provider=${AI_CONFIG.provider} model=${AI_CONFIG.model} baseURL=${AI_CONFIG.baseURL}`);
} else {
  console.log("[AI] Sem chave configurada — a matriz fica em MODO LOCAL (falha graciosa).");
}

const client = new OpenAI({
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

  const safe = Array.isArray(userMessages)
    ? userMessages
        .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"))
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
    : [];

  const trimmed = safe.slice(-AI_CONFIG.maxHistory);
  return [{ role: "system", content: system }, ...trimmed];
}

export type AiErrorKind =
  | "no_provider"
  | "rate_limited"
  | "auth"
  | "timeout"
  | "aborted"
  | "network"
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

function classifyError(err: unknown, aborted = false): MatrixAiError {
  if (aborted) return new MatrixAiError("aborted", "Pedido cancelado.");
  const e = err as { status?: number; code?: string; name?: string; message?: string };
  if (e?.status === 429) return new MatrixAiError("rate_limited", "Limite de pedidos atingido. Tenta novamente em breve.", 429);
  if (e?.status === 401 || e?.status === 403) return new MatrixAiError("auth", "A chave da IA é inválida ou sem permissão.", e.status);
  if (e?.name === "AbortError" || e?.code === "ECONNABORTED") return new MatrixAiError("timeout", "O serviço de IA demorou demasiado.", 408);
  if (e && "message" in e) return new MatrixAiError("network", String(e.message));
  return new MatrixAiError("unknown", "Erro desconhecido do serviço de IA.");
}

// ── Sonda de disponibilidade do provider (sem expor segredos) ──
// Verdade única para o estado ONLINE/LOCAL: a chave existir (aiEnabled) NÃO
// garante que o provider esteja acessível. Consultar /models é barato e não
// gera tokens. Resultado em cache breve para não martelar o provider.
let availabilityCache: { checkedAt: number; reachable: boolean } | null = null;
const AVAILABILITY_CACHE_MS = 15_000;

export async function checkAiAvailability(): Promise<boolean> {
  const cached = availabilityCache;
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_CACHE_MS) {
    return cached.reachable;
  }
  if (!aiEnabled) {
    availabilityCache = { checkedAt: Date.now(), reachable: false };
    return false;
  }
  try {
    await client.models.list({ timeout: 3500 });
    availabilityCache = { checkedAt: Date.now(), reachable: true };
  } catch {
    availabilityCache = { checkedAt: Date.now(), reachable: false };
  }
  return availabilityCache.reachable;
}

// ── Chat não-streaming (JSON) ──
export async function chatCompletion(
  userMessages: AiMessage[],
  context?: string,
  page?: string,
): Promise<string> {
  if (!aiEnabled) {
    throw new MatrixAiError("no_provider", "IA indisponível: sem chave de provider configurada.", 503);
  }
  const messages = buildMessages(userMessages, context, page);
  try {
    const completion = await client.chat.completions.create({
      model: AI_CONFIG.model,
      messages: messages as any,
      temperature: AI_CONFIG.temperature,
      max_tokens: AI_CONFIG.maxTokens,
    });
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
  if (!aiEnabled) {
    res.status(503).json({ message: "IA indisponível: sem chave de provider configurada.", code: "no_provider" });
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
      { signal: controller.signal },
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