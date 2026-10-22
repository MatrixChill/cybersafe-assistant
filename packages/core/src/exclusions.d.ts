export interface ExclusionConfig {
    paths: string[];
    extensions: string[];
    files: string[];
}
export declare class ExclusionManager {
    private config;
    constructor(config?: Partial<ExclusionConfig>);
    isExcluded(filePath: string): boolean;
    exclusionReason(filePath: string): string | null;
    updateConfig(newConfig: Partial<ExclusionConfig>): void;
    getConfig(): ExclusionConfig;
}
