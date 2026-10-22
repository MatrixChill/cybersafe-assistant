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
export declare function encodeMessage(message: unknown): string;
export declare function decodeMessages(buffer: string): {
    messages: any[];
    rest: string;
};
