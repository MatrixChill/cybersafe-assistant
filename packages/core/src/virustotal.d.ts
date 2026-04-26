import type { VirusTotalResult } from "@cybersafe/shared-types";
export declare class VirusTotalClient {
    private apiKey;
    private cache;
    private lastRequestAt;
    private enabled;
    constructor(apiKey?: string);
    isEnabled(): boolean;
    setApiKey(key: string): void;
    scanHash(sha256: string): Promise<VirusTotalResult | null>;
    clearCache(): void;
    getCacheSize(): number;
}
