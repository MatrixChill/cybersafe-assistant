import type { AnalysisResult, QuarantineEntry } from "@cybersafe/shared-types";
export declare class QuarantineManager {
    private readonly quarantineDir;
    private readonly manifestPath;
    private entries;
    constructor(baseDir: string);
    init(): Promise<void>;
    private flush;
    quarantine(analysis: AnalysisResult): Promise<QuarantineEntry | null>;
    restore(id: string, restoredBy?: string): Promise<boolean>;
    delete(id: string): Promise<boolean>;
    list(): QuarantineEntry[];
}
export declare function killProcessTree(pid: number): Promise<boolean>;
