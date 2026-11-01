/**
 * Validação do manifesto de release (TP-UPDATE-01).
 *
 * Falha FECHADO: qualquer campo ausente/malformado/fora-de-formato devolve
 * `{ ok:false, code }` em vez de tentar tolerar. Um manifesto que o updater não
 * consegue validar com certeza NÃO se converte em "update disponível".
 *
 * O URL é validado por ESQUEMA aqui (só HTTPS). A allowlist de ORIGENS é decisão
 * de política e vive no `config.ts`/`updater.ts` (precisa da config), para o
 * manifesto não conhecer a configuração.
 */
import { isCoreVersion, isValidSemVer } from "./semver.ts";
import type { RawReleaseManifest, ValidatedManifest } from "./types.ts";

export type ManifestValidation =
  | { ok: true; manifest: ValidatedManifest }
  | { ok: false; code: "invalid-manifest"; message: string };

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const COMMIT_HEX = /^[0-9a-fA-F]{7,40}$/;

function invalid(message: string): ManifestValidation {
  return { ok: false, code: "invalid-manifest", message };
}

/** JSON `null`/primitivos não são um manifesto. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Só HTTPS; `file:`, `http:`, `data:`, `blob:`, relativos → recusado.
  return url.protocol === "https:";
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

export function validateManifest(raw: unknown): ManifestValidation {
  const obj = asRecord(raw);
  if (!obj) return invalid("manifesto não é um objeto JSON");

  if (obj.channel !== "stable") {
    return invalid(`canal não suportado: ${String(obj.channel)}`);
  }
  if (typeof obj.version !== "string" || !isValidSemVer(obj.version)) {
    return invalid("version não é semver válido");
  }
  if (!isIsoDate(obj.publishedAt)) {
    return invalid("publishedAt não é data ISO");
  }
  if (typeof obj.notes !== "string") {
    return invalid("notes tem de ser texto simples (nunca HTML de upstream)");
  }

  const file = asRecord(obj.file);
  if (!file) return invalid("falta o bloco file");
  if (!isHttpsUrl(file.url)) return invalid("file.url não é HTTPS válido/absoluto");
  if (typeof file.sha256 !== "string" || !SHA256_HEX.test(file.sha256)) {
    return invalid("file.sha256 não é hex de 64");
  }
  if (
    typeof file.sizeBytes !== "number" ||
    !Number.isInteger(file.sizeBytes) ||
    file.sizeBytes <= 0 ||
    !Number.isSafeInteger(file.sizeBytes)
  ) {
    return invalid("file.sizeBytes tem de ser inteiro positivo");
  }

  const signature = asRecord(obj.signature);
  if (!signature) return invalid("falta a assinatura do manifesto");
  if (signature.algorithm !== "ed25519") {
    return invalid(`algoritmo de assinatura não suportado: ${String(signature.algorithm)}`);
  }
  if (typeof signature.value !== "string" || !BASE64.test(signature.value)) {
    return invalid("signature.value não é base64");
  }
  if (typeof signature.signedByFingerprint !== "string" || signature.signedByFingerprint.length === 0) {
    return invalid("signature.signedByFingerprint ausente");
  }

  const publisher = asRecord(obj.publisher);
  if (!publisher || typeof publisher.name !== "string" || publisher.name.length === 0) {
    return invalid("publisher.name ausente (obrigatório antes de instalar)");
  }

  const requiresElevation = obj.requiresElevation === true;

  // Campos de identidade/compatibilidade (§12.4): opcionais, mas quando
  // presentes têm tipo estrito — um valor malformado é manifesto inválido,
  // nunca "ignora-se e segue-se em frente".
  let buildId: string | null = null;
  if (obj.buildId !== undefined && obj.buildId !== null) {
    if (typeof obj.buildId !== "string" || obj.buildId.length === 0 || obj.buildId.length > 64) {
      return invalid("buildId presente mas inválido (string 1..64)");
    }
    buildId = obj.buildId;
  }
  let sourceCommit: string | null = null;
  if (obj.sourceCommit !== undefined && obj.sourceCommit !== null) {
    if (typeof obj.sourceCommit !== "string" || !COMMIT_HEX.test(obj.sourceCommit)) {
      return invalid("sourceCommit presente mas não é hex de 7..40");
    }
    sourceCommit = obj.sourceCommit.toLowerCase();
  }
  let compatibility: ValidatedManifest["compatibility"] = null;
  if (obj.compatibility !== undefined && obj.compatibility !== null) {
    const comp = asRecord(obj.compatibility);
    if (!comp) return invalid("compatibility presente mas não é objeto");
    let minWindowsBuild: number | null = null;
    if (comp.minWindowsBuild !== undefined && comp.minWindowsBuild !== null) {
      if (
        typeof comp.minWindowsBuild !== "number" ||
        !Number.isSafeInteger(comp.minWindowsBuild) ||
        comp.minWindowsBuild <= 0
      ) {
        return invalid("compatibility.minWindowsBuild inválido");
      }
      minWindowsBuild = comp.minWindowsBuild;
    }
    let fromVersion: string | null = null;
    if (comp.fromVersion !== undefined && comp.fromVersion !== null) {
      if (typeof comp.fromVersion !== "string" || !isCoreVersion(comp.fromVersion)) {
        return invalid("compatibility.fromVersion não é X.Y.Z");
      }
      fromVersion = comp.fromVersion;
    }
    compatibility = { minWindowsBuild, fromVersion };
  }

  return {
    ok: true,
    manifest: {
      schema: typeof obj.schema === "string" ? obj.schema : "cybersafe-release/1",
      channel: "stable",
      version: obj.version,
      publishedAt: obj.publishedAt as string,
      notes: obj.notes,
      file: {
        url: file.url,
        sha256: (file.sha256 as string).toLowerCase(),
        sizeBytes: file.sizeBytes as number,
      },
      signature: {
        algorithm: "ed25519",
        value: signature.value,
        signedByFingerprint: signature.signedByFingerprint,
      },
      publisher: { name: publisher.name },
      requiresElevation,
      buildId,
      sourceCommit,
      compatibility,
    },
  };
}

/**
 * Bytes CANÓNICOS sobre os quais a assinatura ed25519 incide. Ordem de chaves
 * fixa, sem `signature`, para que assinante e verificador cansem a mesma string
 * independentemente de como o JSON foi serializado na origem.
 */
export function canonicalManifestBytes(manifest: ValidatedManifest): string {
  const body: Record<string, unknown> = {
    schema: manifest.schema,
    channel: manifest.channel,
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    notes: manifest.notes,
    file: {
      url: manifest.file.url,
      sha256: manifest.file.sha256,
      sizeBytes: manifest.file.sizeBytes,
    },
    publisher: { name: manifest.publisher.name },
    requiresElevation: manifest.requiresElevation,
  };
  // Compatibilidade: campos declarados só entram nos bytes canónicos quando
  // existem — um manifesto sem eles assina/verifica exatamente como antes.
  if (manifest.buildId !== null) body.buildId = manifest.buildId;
  if (manifest.sourceCommit !== null) body.sourceCommit = manifest.sourceCommit;
  if (manifest.compatibility !== null) body.compatibility = manifest.compatibility;
  return JSON.stringify(body);
}
