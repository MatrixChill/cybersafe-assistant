import { EventEmitter } from "node:events";
import type { EventType, SecurityEvent, Severity } from "@cybersafe/shared-types";

export interface EventBusOptions {
  replayLimit?: number;
}

export class SecurityEventBus extends EventEmitter {
  private sequence = 0;
  private replay: SecurityEvent[] = [];
  private readonly replayLimit: number;

  constructor(options: EventBusOptions = {}) {
    super();
    this.replayLimit = options.replayLimit ?? 250;
  }

  publish<T>(type: EventType, severity: Severity, summary: string, data: T): SecurityEvent<T> {
    const event: SecurityEvent<T> = {
      id: `evt-${Date.now()}-${this.sequence + 1}`,
      type,
      timestamp: new Date().toISOString(),
      sequence: ++this.sequence,
      severity,
      summary,
      data,
    };

    this.replay.push(event as SecurityEvent);
    if (this.replay.length > this.replayLimit) {
      this.replay.splice(0, this.replay.length - this.replayLimit);
    }

    this.emit("event", event);
    this.emit(type, event);
    return event;
  }

  getReplay(cursor?: number, limit = 100): SecurityEvent[] {
    const filtered = typeof cursor === "number"
      ? this.replay.filter((event) => event.sequence > cursor)
      : this.replay;
    return filtered.slice(-limit);
  }

  getLastSequence(): number {
    return this.sequence;
  }
}
