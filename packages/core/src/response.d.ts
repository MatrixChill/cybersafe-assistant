import type { AnalysisResult, QuarantineEntry } from "@cybersafe/shared-types";
export declare class QuarantineManager {
    private readonly quarantineDir;
    private readonly manifestPath;
    private entries;
    constructor(baseDir: string);
    init(): Promise<void>;
    private flush;
    quarantine(analysis: AnalysisResult): Promise<QuarantineEntry | null>;
    restore(id: string, restoredBy?: string): Promise<{ success: boolean; error?: string }>;
    delete(id: string): Promise<{ success: boolean; error?: string }>;
    list(): QuarantineEntry[];
}
export declare function killProcessTree(pid: number): Promise<boolean>;
