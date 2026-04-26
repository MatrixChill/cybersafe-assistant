export interface ExclusionConfig {
    paths: string[];
    extensions: string[];
    files: string[];
}
export declare class ExclusionManager {
    private config;
    constructor(config?: Partial<ExclusionConfig>);
    /**
     * Verifica se um arquivo deve ser ignorado pela varredura.
     */
    isExcluded(filePath: string): boolean;
    /**
     * Atualiza as exclusões em runtime.
     */
    updateConfig(newConfig: Partial<ExclusionConfig>): void;
    getConfig(): ExclusionConfig;
}
