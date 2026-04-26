import { EventEmitter } from "node:events";
import type { EventType, SecurityEvent, Severity } from "@cybersafe/shared-types";
export interface EventBusOptions {
    replayLimit?: number;
}
export declare class SecurityEventBus extends EventEmitter {
    private sequence;
    private replay;
    private readonly replayLimit;
    constructor(options?: EventBusOptions);
    publish<T>(type: EventType, severity: Severity, summary: string, data: T): SecurityEvent<T>;
    getReplay(cursor?: number, limit?: number): SecurityEvent[];
    getLastSequence(): number;
}
