import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  analyzeDownloadFilename,
  type AnalysisResult,
  type HeuristicRuleId,
} from "@cybersafe/shared-types";
import { sha256File } from "./hashing.js";
import {
  DEV_CANARY_SIGNATURE,
  getDevCanaryContent,
  isDevCanaryEnabled,
  type SignatureDatabase,
  type SignatureRecord,
} from "./signatures.js";
import type { TrustEngine } from "./trust.js";
import type { YaraEngine } from "./yara.js";
import type { ClamavBridge, ClamavFileOutcome } from "./clamav.js";
import { scoreThreat, type AuthenticodeStatus } from "./scoring.js";

const MAGIC_NUMBERS: Record<string, string> = {
  "4d5a": "MZ",
  "504b": "ZIP",
  "7f454c46": "ELF",
  "25504446": "PDF",
};

const EXECUTABLE_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".msi", ".scr", ".ps1", ".js", ".vbs", ".com",
]);

function detectMagic(buffer: Buffer): string | undefined {
  const header = buffer.toString("hex", 0, Math.min(4, buffer.length)).toLowerCase();
  return Object.entries(MAGIC_NUMBERS).find(([magic]) => header.startsWith(magic))?.[1];
}

function calculateEntropy(buffer: Buffer) {
  const freq = new Map<number, number>();
  for (const byte of buffer) freq.set(byte, (freq.get(byte) ?? 0) + 1);
  let entropy = 0;
  const len = buffer.length || 1;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export interface AnalyzerDependencies {
  signatures: SignatureDatabase;
  trust: TrustEngine;
  yara: YaraEngine;
  /** Opcional: se existir, o clamscan é usado; caso contrário o motor é reportado como unavailable. */
  clamav?: ClamavBridge;
}

export class MalwareAnalyzer {
  constructor(private readonly deps: AnalyzerDependencies) {}

  async analyze(
    artifactPath: string,
    signer?: string,
    signatureStatus: AuthenticodeStatus = "unavailable",
    options?: { signal?: AbortSignal; clamavOutcome?: ClamavFileOutcome },
  ): Promise<AnalysisResult> {
    // A signer name, or lack of one, does not establish signature validity.
    const verifiedSigner = signatureStatus === "verified" || signatureStatus === "trusted" ? signer : undefined;
    const fileName = path.basename(artifactPath);
    const extension = path.extname(fileName).toLowerCase();
    const metadata = analyzeDownloadFilename(fileName);
    const sha256 = await sha256File(artifactPath);
    const stats = statSync(artifactPath);
    
    // Gatekeeper para arquivos gigantes (previne crash de memória e lentidão)
    if (stats.size > 100 * 1024 * 1024) { // 100MB limit
      return this.generateResultForLargeFile(artifactPath, sha256, stats, fileName, extension, verifiedSigner, signatureStatus);
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
    const strongYaraMatches = yaraMatches.filter(match => match.evidence === "strong").length;
    
    // Scan com ClamAV — só quando o binário existe; nunca simula proteção.
    // O signal propaga-se para que cancelar um scan termine o clamscan em
    // curso em vez de o deixar a varrer sozinho com ~1 GB de RAM.
    //
    // O `verdict` é tão importante como o `detected`. Um `error` significa "o
    // motor não conseguiu avaliar este ficheiro" — e o ficheiro pode ter
    // deixado de existir a meio (medido: o Defender apaga-o enquanto o
    // clamscan o abre). Tratar isso como `detected: false` é publicar um
    // veredicto sobre um ficheiro que ninguém examinou.
    let clamavDetected = false;
    let clamavVerdict: "detected" | "clean" | "error" | undefined;
    let clamavDetail: string | undefined;
    if (options?.clamavOutcome) {
      // BATCH (Fase 4). O veredicto já foi obtido numa única invocação para
      // todos os ficheiros; aqui só se consome. O caminho por omissão continua
      // a ser `scanFile`, para que um scan avulso (processo, ficheiro
      // observado) não dependa de nenhum prefetch.
      clamavDetected = options.clamavOutcome.verdict === "detected";
      clamavVerdict = options.clamavOutcome.verdict;
      clamavDetail = options.clamavOutcome.detail;
    } else if (this.deps.clamav) {
      const clamResult = await this.deps.clamav.scanFile(artifactPath, { signal: options?.signal });
      clamavDetected = clamResult.detected;
      clamavVerdict = clamResult.verdict ?? (clamResult.detected ? "detected" : "clean");
      clamavDetail = clamResult.detail;
    }
    const scanInconclusive = clamavVerdict === "error";

    const signatureMatch = this.deps.signatures.match(sha256);

    // Canário dev-only (benigno): detetado por hash (conteúdo exato) ou por
    // conteúdo no cabeçalho já lido (robusto a newline/BOM do teste manual).
    // Em NODE_ENV=production nunca deteta — segue como ficheiro limpo.
    let devCanary: SignatureRecord | undefined;
    if (isDevCanaryEnabled()) {
      if (signatureMatch?.source === DEV_CANARY_SIGNATURE.source) {
        devCanary = signatureMatch;
      } else {
        // Conteúdo registado apenas por fixtures de teste. Vazio numa app
        // empacotada, por isso a app nunca pode sinalizar o próprio bundle.
        const canaryContent = getDevCanaryContent();
        if (canaryContent.length > 0 && sample.toString("utf8").includes(canaryContent)) {
          devCanary = DEV_CANARY_SIGNATURE;
        }
      }
    }
    // O canário NÃO usa o caminho known_bad_hash: severity media, sem quarentena.
    const knownBadHash = !!signatureMatch && !devCanary;

    const trust = this.deps.trust.evaluate({ sha256, artifactPath, signer: verifiedSigner });

    const rules = new Set<HeuristicRuleId>(metadata.rulesTriggered);
    const isExecutable = EXECUTABLE_EXTENSIONS.has(extension) || magic === "MZ";

    if (knownBadHash) rules.add("known_bad_hash");
    if (devCanary) rules.add("dev_canary_signature");
    if (yaraMatches.length > 0) rules.add("yara_match");
    if (clamavDetected) rules.add("known_malware");
    // Não é uma ameaça, é uma LACUNA. Entra nas regras e no `summary` com
    // peso zero, para que o utilizador leia "análise não concluída" em vez de
    // "limpo" quando o motor não chegou a ver o ficheiro.
    if (scanInconclusive) rules.add("scan_inconclusive");
    if (artifactPath.toLowerCase().includes("\\downloads\\") || artifactPath.toLowerCase().includes("\\temp\\")) {
      rules.add("suspicious_location");
    }
    if (trust.publisherTrusted) rules.add("trusted_publisher");
    if (trust.systemPathTrusted) rules.add("trusted_system_path");
    if (signatureStatus === "unsigned" && isExecutable) rules.add("unsigned_binary");
    if (entropy > 7.4) rules.add("high_entropy");
    if (magic === "ZIP") {
      try {
        const zip = new AdmZip(artifactPath);
        if (zip.getEntries().some((entry) => !entry.isDirectory && EXECUTABLE_EXTENSIONS.has(path.extname(entry.entryName).toLowerCase()))) {
          rules.add("archive_with_exe");
        }
      } catch {
        // Ignore invalid archives.
      }
    }

    const score = scoreThreat({
      signatureMatch: knownBadHash,
      yaraMatches: yaraMatches.length,
      strongYaraMatches,
      signatureStatus,
      rulesTriggered: Array.from(rules),
      trustDecision: trust.decision,
    });

    // Com o scan inconclusivo, a confiança no veredicto cai. Dizer "limpo,
    // com 92% de certeza" sobre um ficheiro que o motor não conseguiu abrir é
    // a forma mais concreta de mentir. A confiança reflete o que foi medido.
    const baseConfidence = knownBadHash || devCanary ? 0.99 : strongYaraMatches > 0 ? 0.92 : metadata.confidence;

    return {
      artifactPath,
      fileName,
      sha256,
      // O veredicto NUNCA diz "safe" sobre um ficheiro que o motor não
      // examinou. `scan_inconclusive` tem peso 0 (um motor que não leu não é
      // uma ameaça), mas peso 0 faz `hasStrongEvidence` falso e o `scoring`
      // caía no `else` que devolve "safe" — publicando um veredicto sobre um
      // ficheiro que ninguém abriu. "inconclusive" é a única resposta honesta:
      // não é ameaça, não é garantia, é lacuna.
      verdict: scanInconclusive && score.verdict === "safe" ? "inconclusive" : score.verdict,
      severity: score.severity,
      riskScore: score.riskScore,
      confidence: scanInconclusive ? Math.min(baseConfidence, 0.3) : baseConfidence,
      rulesTriggered: Array.from(rules),
      // (ver o comentário do `verdict` abaixo)
      factors: scanInconclusive
        ? [
            ...score.factors,
            {
              id: "clamav-inconclusive",
              label: clamavDetail ?? "O motor de scan não conseguiu avaliar este ficheiro",
              weight: 0,
              category: "heuristic" as const,
            },
          ]
        : score.factors,
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

  private generateResultForLargeFile(artifactPath: string, sha256: string, stats: any, fileName: string, extension: string, signer?: string, signatureStatus: AuthenticodeStatus = "unavailable"): AnalysisResult {
    const trust = this.deps.trust.evaluate({ sha256, artifactPath, signer });
    const rules = new Set<HeuristicRuleId>();
    
    if (trust.publisherTrusted) rules.add("trusted_publisher");
    if (trust.systemPathTrusted) rules.add("trusted_system_path");
    if (signatureStatus === "unsigned" && (extension === ".exe" || extension === ".msi")) rules.add("unsigned_binary");

    const score = scoreThreat({
      signatureMatch: false,
      yaraMatches: 0,
      signatureStatus,
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
