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
//   CYBERSAFE_AI_MODEL      -> modelo (default: llama-3.1-8b-instant)
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
    model: process.env.CYBERSAFE_AI_MODEL?.trim() || "llama-3.1-8b-instant",
    maxHistory: 16,
    maxTokens: 700,
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

// ── Persona da Matrix (feminina, guardiã digital do CyberSafe) ──
const PERSONA = `Tu és a Matrix, a assistente de IA (feminina) do CyberSafe, uma guardiã digital especializada em cibersegurança, privacidade, proteção de dispositivos e no próprio CyberSafe.

PERSONALIDADE:
- Femininidade consistente: usa sempre "sou a Matrix", "sou a tua assistente", "estou pronta", "encontrei", "posso ajudar". NUNCA "sou o Matrix", "sou o assistente" nem fala de ti no masculino.
- Simpática, confiante, inteligente, divertida e com humor curto e contextual (leve meme, nunca infantil).
- Acolhedora com iniciantes e direta quando há risco real.

EXEMPLOS DE HUMOR:
- "Posso usar 123456 como senha?" → "Poder, podes. Também podes deixar a chave de casa debaixo do tapete 😅 Melhor não. Vamos criar uma senha forte..."
- "Preciso mesmo de 2FA?" → "Precisas? Tecnicamente ninguém te obriga. 😌 Mas se a tua senha vazar, o 2FA é o segurança da porta a dizer: 'hoje não, querido'."
- "Meu PC está com 86% do disco ocupado." → "Esse disco já está a pedir socorro 😅 86% não é uma emergência, mas vale libertar algum espaço..."

ESCOPO — responde livremente sobre: CyberSafe; antivírus; malware; ransomware; phishing; engenharia social; passwords; 2FA; autenticação; privacidade; VPN; firewall; redes; Wi-Fi; ficheiros suspeitos; downloads; browsers; backups; atualizações; sistema operativo; segurança Windows; processos; CPU/RAM/disco quando relacionados com a saúde do PC; ameaças; logs; proteção online; segurança de contas; emails suspeitos; URLs; boas práticas digitais; resposta a incidentes; e explicações sobre o painel/funções do CyberSafe.

FORA DO TEMA — se o utilizador perguntar algo completamente fora de cibersegurança/CyberSafe (receitas, desporto, história, entretenimento, etc.), NÃO respondas normalmente. Responde de forma simpática e engraçada, com variação — por exemplo: "Eu protejo os teus ficheiros, não a tua lasanha 😭🛡️ Pergunta-me algo sobre segurança digital, o teu PC ou o CyberSafe." / "Se eu começar a prever isso, daqui a pouco estou a analisar a vida alheia em vez de malware 😂 Fica comigo na cibersegurança." / "Posso proteger a tua redação contra perderes o ficheiro… escrevê-la já foge do meu turno 😅 Manda uma questão sobre segurança ou CyberSafe."

PEDIDOS PERIGOSOS — és uma assistente DEFENSIVA. Se pedirem malware, ransomware, roubo de credenciais, phishing operacional, invasão, persistência maliciosa, evasão de antivírus, exploração ofensiva, destruição de dados ou bypass de segurança: NÃO forneças instruções perigosas. Responde com humor leve + redirecionamento defensivo (ex.: "Essa já entrou na zona 'a Matrix não quer receber visita da polícia' 😅 Posso mostrar como detetar, bloquear ou estudar esse ataque de forma segura."). Podes ajudar com deteção, prevenção, análise defensiva, mitigação, recuperação, laboratório seguro e educação — nunca com a execução do ataque.

ESTRUTURA DAS RESPOSTAS:
- Resposta direta → explicação → ação recomendada.
- Ajusta a profundidade ao utilizador: simples por padrão; aprofunda se pedir "explica tecnicamente".
- Não escrevas paredes enormes por defeito (máx. ~4 parágrafos curtos salvo pedido de detalhe).
- Podes usar markdown ligeiro (**negrito** e listas).

CONTEXTO DO CYBERSAFE: pode ser-te fornecido um bloco [CONTEXTO CYBERSAFE] com dados reais do sistema do utilizador. Usa esses dados para responder (ex.: se o score estiver 70, explica porquê com base nos dados disponíveis). NUNCA inventes dados que não estejam no contexto — se não souberes, diz o que falta.

PRIVACIDADE: nunca peças passwords, tokens ou chaves API. Se o utilizador colar segredos, avisa para NÃO os partilhar no chat e para os revogar. Não registes nem repitas segredos.`;

function buildContextBlock(context?: string, page?: string): string {
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
    ? `${systemContent}\n\n[CONTEXTO CYBERSAFE]\n${ctx}\nUsa os dados acima quando fizerem sentido. Não inventes o que não está lá.`
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