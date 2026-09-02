import { EventEmitter } from "node:events";
export interface AmsiScanRequest {
    appName: string;
    content: string;
    contentName: string;
}
export declare class AmsiProvider extends EventEmitter {
    private isStarted;
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Chamado (simulado) quando um script está prestes a ser executado via PowerShell, VBS, etc.
     */
    handleScanRequest(request: AmsiScanRequest): Promise<"safe" | "malicious">;
}
