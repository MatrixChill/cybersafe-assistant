import path from "node:path";
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

export class TrustEngine {
  private allowedHashes = new Set<string>();
  private allowedPublishers = new Set<string>([
    "Microsoft Windows",
    "Microsoft Corporation",
  ]);
  private trustedRoots = [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ];

  allowHash(sha256: string) {
    this.allowedHashes.add(sha256.toLowerCase());
  }

  allowPublisher(publisher: string) {
    this.allowedPublishers.add(publisher);
  }

  evaluate(context: TrustContext): TrustResult {
    const artifactPath = path.normalize(context.artifactPath);
    const systemPathTrusted = this.trustedRoots.some((root) =>
      artifactPath.toLowerCase().startsWith(root.toLowerCase()),
    );
    const publisherTrusted = !!context.signer && this.allowedPublishers.has(context.signer);

    if (this.allowedHashes.has(context.sha256.toLowerCase())) {
      return {
        decision: "trusted",
        reason: "allowlisted-hash",
        publisherTrusted,
        systemPathTrusted,
      };
    }

    if (publisherTrusted || systemPathTrusted) {
      return {
        decision: "trusted",
        reason: publisherTrusted ? "trusted-publisher" : "trusted-system-path",
        publisherTrusted,
        systemPathTrusted,
      };
    }

    return {
      decision: "neutral",
      reason: "unknown",
      publisherTrusted,
      systemPathTrusted,
    };
  }
}
