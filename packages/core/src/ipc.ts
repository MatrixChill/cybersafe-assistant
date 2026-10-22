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
