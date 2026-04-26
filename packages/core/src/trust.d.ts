import type { TrustDecision } from "@cybersafe/shared-types";
export interface TrustContext {
    sha256: string;
    artifactPath: string;
    signer?: string;
}
export interface TrustResult {
    decision: TrustDecision;
    reason: string;
    publisherTrusted: boolean;
    systemPathTrusted: boolean;
}
export declare class TrustEngine {
    private allowedHashes;
    private allowedPublishers;
    private trustedRoots;
    allowHash(sha256: string): void;
    allowPublisher(publisher: string): void;
    evaluate(context: TrustContext): TrustResult;
}
