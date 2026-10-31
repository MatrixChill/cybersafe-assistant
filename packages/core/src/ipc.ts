import type { EventType, SecurityEvent, ServiceCommandMap, ServiceResponseMap } from "@cybersafe/shared-types";

export interface RpcRequest<K extends keyof ServiceCommandMap = keyof ServiceCommandMap> {
  id: string;
  type: "request";
  method: K;
  payload: ServiceCommandMap[K];
}

export interface RpcResponse<K extends keyof ServiceResponseMap = keyof ServiceResponseMap> {
  id: string;
  type: "response";
  ok: boolean;
  result?: ServiceResponseMap[K];
  error?: string;
}

export interface RpcEvent {
  type: "event";
  event: SecurityEvent;
}

export interface EventSubscription {
  eventType?: EventType;
}

export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeMessages(buffer: string): { messages: any[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const messages = parts
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { messages, rest };
}

/**
 * ── DECODER COM LIMITES (AUD-002) ──────────────────────────────────────────
 *
 * O framing continua a ser um objeto JSON por linha. A diferença é que um
 * cliente autenticado mas defeituoso/hostil deixa de poder fazer crescer o
 * buffer da ligação sem limite: há um tecto para o resto incompleto, para cada
 * frame e para o número de mensagens de um chunk. Em violação devolve o código
 * correspondente (nunca lança) — quem chama decide fechar a ligação.
 */
export const RPC_MAX_FRAME_BYTES = 512 * 1024;
export const RPC_MAX_REST_BYTES = 1024 * 1024;
export const RPC_MAX_MESSAGES_PER_CHUNK = 256;

export type RpcDecodeError =
  | "frame-too-large"
  | "rest-too-large"
  | "too-many-messages"
  | "invalid-json";

export interface RpcDecodeLimits {
  maxFrameBytes?: number;
  maxRestBytes?: number;
  maxMessages?: number;
}

export interface BoundedDecodeResult {
  messages: any[];
  rest: string;
  error: RpcDecodeError | null;
}

export function decodeMessagesBounded(buffer: string, limits: RpcDecodeLimits = {}): BoundedDecodeResult {
  const maxFrame = limits.maxFrameBytes ?? RPC_MAX_FRAME_BYTES;
  const maxRest = limits.maxRestBytes ?? RPC_MAX_REST_BYTES;
  const maxMessages = limits.maxMessages ?? RPC_MAX_MESSAGES_PER_CHUNK;
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  // Um `rest` sem newline é o caso que cresce indefinidamente: sem este tecto
  // uma ligação que nunca envia "\n" acumulava tudo em memória.
  if (rest.length > maxRest) return { messages: [], rest: "", error: "rest-too-large" };
  const messages: any[] = [];
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > maxFrame) return { messages, rest: "", error: "frame-too-large" };
    if (messages.length >= maxMessages) return { messages, rest: "", error: "too-many-messages" };
    try {
      messages.push(JSON.parse(line));
    } catch {
      return { messages, rest: "", error: "invalid-json" };
    }
  }
  return { messages, rest, error: null };
}
