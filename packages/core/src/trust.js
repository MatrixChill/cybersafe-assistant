import path from "node:path";
export class TrustEngine {
    allowedHashes = new Set();
    allowedPublishers = new Set([
        "Microsoft Windows",
        "Microsoft Corporation",
    ]);
    trustedRoots = [
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files (x86)",
    ];
    allowHash(sha256) {
        this.allowedHashes.add(sha256.toLowerCase());
    }
    allowPublisher(publisher) {
        this.allowedPublishers.add(publisher);
    }
    evaluate(context) {
        const artifactPath = path.normalize(context.artifactPath);
        const systemPathTrusted = this.trustedRoots.some((root) => artifactPath.toLowerCase().startsWith(root.toLowerCase()));
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
