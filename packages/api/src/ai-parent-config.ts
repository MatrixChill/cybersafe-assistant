/** Configuration is accepted only over Node's private parent IPC, never HTTP. */
export interface ParentAiConfiguration { provider: "groq" | "openai"; apiKey: string; baseURL: string; model: string }
export function parseParentAiConfiguration(message: unknown): { id: string; config: ParentAiConfiguration } | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.type !== "cybersafe-ai-configure" || typeof m.id !== "string" || !/^[a-f0-9-]{36}$/.test(m.id)) return null;
  if (m.provider !== "groq" && m.provider !== "openai") return null;
  if (m.apiKey !== null && (typeof m.apiKey !== "string" || m.apiKey.length < 16 || m.apiKey.length > 512 || /[\r\n\x00]/.test(m.apiKey))) return null;
  return { id: m.id, config: { provider: m.provider, apiKey: m.apiKey ?? "",
    baseURL: m.provider === "groq" ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1",
    model: m.provider === "groq" ? "openai/gpt-oss-120b" : "gpt-4o-mini" } };
}
