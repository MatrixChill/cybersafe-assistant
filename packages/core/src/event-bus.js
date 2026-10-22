import { EventEmitter } from "node:events";
export class SecurityEventBus extends EventEmitter {
    sequence = 0;
    replay = [];
    replayLimit;
    constructor(options = {}) {
        super();
        this.replayLimit = options.replayLimit ?? 250;
    }
    publish(type, severity, summary, data) {
        const event = {
            id: `evt-${Date.now()}-${this.sequence + 1}`,
            type,
            timestamp: new Date().toISOString(),
            sequence: ++this.sequence,
            severity,
            summary,
            data,
        };
        this.replay.push(event);
        if (this.replay.length > this.replayLimit) {
            this.replay.splice(0, this.replay.length - this.replayLimit);
        }
        this.emit("event", event);
        this.emit(type, event);
        return event;
    }
    getReplay(cursor, limit = 100) {
        const filtered = typeof cursor === "number"
            ? this.replay.filter((event) => event.sequence > cursor)
            : this.replay;
        return filtered.slice(-limit);
    }
    getLastSequence() {
        return this.sequence;
    }
}
