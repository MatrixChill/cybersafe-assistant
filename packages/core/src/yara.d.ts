export interface YaraMatch {
    ruleId: string;
    label: string;
    severity: "high" | "critical";
}
export declare class YaraEngine {
    private scanner;
    private rulesPath;
    constructor(rulesPath?: string);
    load(filePath: string): Promise<void>;
    /**
     * Garante que o arquivo de regras existe. Se não existir, tenta baixar um conjunto básico.
     */
    ensureRules(): Promise<void>;
    /**
     * Mantendo compatibilidade com a interface antiga para Buffers
     */
    match(buffer: Buffer): YaraMatch[];
    /**
     * Nova funcionalidade de scan de arquivo (mais eficiente que ler o buffer)
     */
    scanFile(filePath: string): Promise<YaraMatch[]>;
}
