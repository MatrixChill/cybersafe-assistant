import { type AnalysisResult } from "@cybersafe/shared-types";
import type { SignatureDatabase } from "./signatures.js";
import type { TrustEngine } from "./trust.js";
import type { YaraEngine } from "./yara.js";
export interface AnalyzerDependencies {
    signatures: SignatureDatabase;
    trust: TrustEngine;
    yara: YaraEngine;
}
export declare class MalwareAnalyzer {
    private readonly deps;
    constructor(deps: AnalyzerDependencies);
    analyze(artifactPath: string, signer?: string): Promise<AnalysisResult>;
    private generateResultForLargeFile;
}
