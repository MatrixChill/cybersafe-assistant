import { EventEmitter } from "node:events";
export interface EtwProcessEvent {
    pid: number;
    ppid: number;
    imageFileName: string;
    commandLine: string;
    timestamp: string;
}
export declare class EtwConsumer extends EventEmitter {
    private isStarted;
    start(): Promise<void>;
    stop(): Promise<void>;
}
