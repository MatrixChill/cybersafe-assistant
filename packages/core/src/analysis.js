import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { analyzeDownloadFilename, } from "@cybersafe/shared-types";
import { sha256File } from "./hashing.js";
import { scoreThreat } from "./scoring.js";
const MAGIC_NUMBERS = {
    "4d5a": "MZ",
    "504b": "ZIP",
    "7f454c46": "ELF",
    "25504446": "PDF",
};
const EXECUTABLE_EXTENSIONS = new Set([
    ".exe", ".bat", ".cmd", ".msi", ".scr", ".ps1", ".js", ".vbs", ".com",
]);
function detectMagic(buffer) {
    const header = buffer.toString("hex", 0, Math.min(4, buffer.length)).toLowerCase();
    return Object.entries(MAGIC_NUMBERS).find(([magic]) => header.startsWith(magic))?.[1];
}
function calculateEntropy(buffer) {
    const freq = new Map();
    for (const byte of buffer)
        freq.set(byte, (freq.get(byte) ?? 0) + 1);
    let entropy = 0;
    const len = buffer.length || 1;
    for (const count of freq.values()) {
        const p = count / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
export class MalwareAnalyzer {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async analyze(artifactPath, signer) {
        const fileName = path.basename(artifactPath);
        const extension = path.extname(fileName).toLowerCase();
        const metadata = analyzeDownloadFilename(fileName);
        const sha256 = await sha256File(artifactPath);
        const stats = statSync(artifactPath);
        // Gatekeeper para arquivos gigantes (previne crash de memória e lentidão)
        if (stats.size > 100 * 1024 * 1024) { // 100MB limit
            return this.generateResultForLargeFile(artifactPath, sha256, stats, fileName, extension, signer);
        }
        const fileHandle = await fs.open(artifactPath, "r");
        const header = Buffer.alloc(8192);
        const { bytesRead } = await fileHandle.read(header, 0, header.length, 0);
        await fileHandle.close();
        const sample = header.slice(0, Math.max(bytesRead, 1));
        const magic = detectMagic(sample);
        const entropy = Number(calculateEntropy(sample).toFixed(2));
        // Scan completo com YARA
        const yaraMatches = await this.deps.yara.scanFile(artifactPath);
        // Scan com ClamAV
        let clamavDetected = false;
        try {
            const { execSync } = await import("node:child_process");
            // Timeout de 10 segundos para não travar a interface
            execSync(`clamscan --no-summary "${artifactPath}"`, {
                stdio: "ignore",
                timeout: 10000
            });
        }
        catch (error) {
            if (error.status === 1) {
                clamavDetected = true;
            }
        }
        const signatureMatch = this.deps.signatures.match(sha256);
        const trust = this.deps.trust.evaluate({ sha256, artifactPath, signer });
        const rules = new Set(metadata.rulesTriggered);
        const isExecutable = EXECUTABLE_EXTENSIONS.has(extension) || magic === "MZ";
        if (signatureMatch)
            rules.add("known_bad_hash");
        if (yaraMatches.length > 0)
            rules.add("yara_match");
        if (clamavDetected)
            rules.add("known_malware");
        if (artifactPath.toLowerCase().includes("\\downloads\\") || artifactPath.toLowerCase().includes("\\temp\\")) {
            rules.add("suspicious_location");
        }
        if (trust.publisherTrusted)
            rules.add("trusted_publisher");
        if (trust.systemPathTrusted)
            rules.add("trusted_system_path");
        if (!signer && isExecutable)
            rules.add("unsigned_binary");
        if (entropy > 7.4)
            rules.add("high_entropy");
        if (magic === "ZIP") {
            try {
                const zip = new AdmZip(artifactPath);
                if (zip.getEntries().some((entry) => !entry.isDirectory && EXECUTABLE_EXTENSIONS.has(path.extname(entry.entryName).toLowerCase()))) {
                    rules.add("archive_with_exe");
                }
            }
            catch {
                // Ignore invalid archives.
            }
        }
        const score = scoreThreat({
            signatureMatch: !!signatureMatch,
            yaraMatches: yaraMatches.length,
            rulesTriggered: Array.from(rules),
            trustDecision: trust.decision,
        });
        return {
            artifactPath,
            fileName,
            sha256,
            verdict: score.verdict,
            severity: score.severity,
            riskScore: score.riskScore,
            confidence: signatureMatch ? 0.99 : yaraMatches.length > 0 ? 0.92 : metadata.confidence,
            rulesTriggered: Array.from(rules),
            factors: score.factors,
            recommendedAction: score.recommendedAction,
            signer,
            publisherTrusted: trust.publisherTrusted,
            systemPathTrusted: trust.systemPathTrusted,
            isExecutable,
            magicNumber: magic,
            detectedExtension: magic === "MZ" ? ".exe" : magic === "ZIP" ? ".zip" : "",
            extension,
            size: stats.size,
            entropy,
            scanTimestamp: new Date().toISOString(),
        };
    }
    generateResultForLargeFile(artifactPath, sha256, stats, fileName, extension, signer) {
        const trust = this.deps.trust.evaluate({ sha256, artifactPath, signer });
        const rules = new Set();
        if (trust.publisherTrusted)
            rules.add("trusted_publisher");
        if (trust.systemPathTrusted)
            rules.add("trusted_system_path");
        if (!signer && (extension === ".exe" || extension === ".msi"))
            rules.add("unsigned_binary");
        const score = scoreThreat({
            signatureMatch: false,
            yaraMatches: 0,
            rulesTriggered: Array.from(rules),
            trustDecision: trust.decision,
        });
        return {
            artifactPath,
            fileName,
            sha256,
            verdict: score.verdict,
            severity: score.severity,
            riskScore: score.riskScore,
            confidence: 0.5,
            rulesTriggered: Array.from(rules),
            factors: score.factors,
            recommendedAction: score.recommendedAction,
            signer,
            publisherTrusted: trust.publisherTrusted,
            systemPathTrusted: trust.systemPathTrusted,
            isExecutable: true,
            magicNumber: undefined,
            detectedExtension: extension,
            extension,
            size: stats.size,
            entropy: 0,
            scanTimestamp: new Date().toISOString(),
        };
    }
}
