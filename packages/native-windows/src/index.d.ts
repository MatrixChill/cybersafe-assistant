import { EventEmitter } from "node:events";
import type { ConnectionSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";
export * from "./wfp-filter.js";
export * from "./amsi-provider.js";
export * from "./etw-consumer.js";
export interface FileObservation {
    kind: "file.created" | "file.modified" | "file.renamed";
    path: string;
    observedAt: string;
}
export interface PersistenceObservation {
    kind: "registry.persistence.changed" | "scheduledtask.changed";
    path: string;
    observedAt: string;
    value?: string;
}
export interface NativeWindowsWatcherEvents {
    "file.created": (event: FileObservation) => void;
    "file.modified": (event: FileObservation) => void;
    "file.renamed": (event: FileObservation) => void;
    "registry.persistence.changed": (event: PersistenceObservation) => void;
    "scheduledtask.changed": (event: PersistenceObservation) => void;
}
export declare class NativeWindowsWatcher extends EventEmitter {
    private watcher;
    private registryTimer;
    private lastRegistrySnapshot;
    private validatedPaths;
    getDefaultPaths(): string[];
    /**
     * Validates and filters paths to only include those that are accessible.
     * Logs detailed information about paths that fail validation.
     */
    private validateAndFilterPaths;
    start(paths?: string[]): Promise<void>;
    private captureRegistrySnapshot;
    stop(): Promise<void>;
}
export declare class ProcessMonitor extends EventEmitter {
    private timer;
    private previous;
    start(): Promise<void>;
    stop(): Promise<void>;
    list(): Promise<ProcessSnapshot[]>;
    private poll;
}
export declare function snapshotProcesses(): Promise<Map<number, ProcessSnapshot>>;
export declare function snapshotConnections(): Promise<ConnectionSnapshot[]>;
export declare function terminateProcessTree(pid: number): Promise<boolean>;
