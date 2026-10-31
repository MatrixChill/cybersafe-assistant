/**
 * Primitivas criptográficas do updater (TP-UPDATE-01).
 *
 * Usa só `node:crypto` (builtin). NÃO adiciona dependências. Dois papéis distintos
 * e que NÃO se confundem:
 *  - **integridade** = SHA-256 do ficheiro (deteita corrupção/alteração);
 *  - **autenticidade** = assinatura ed25519 do MANIFESTO contra a chave PINADA.
 *
 * Um SHA-256 que combine não prova quem publicou; por isso o `PublisherVerifier`
 * (Authenticode) é obrigatório ANTES de instalar, em separado daqui.
 *
 * Chaves efémeras só aparecem em TESTES (para exercitar o mecanismo), nunca como
 * "origem de produção". Em produção a chave pinada é material de build/config.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { ManifestSignatureVerifier, SignatureVerifyResult } from "./types.ts";

export function sha256Hex(data: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  return hash.digest("hex");
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[:\s-]/g, "").toUpperCase();
}

/** Fingerprint = SHA-256 do DER (SPKI) da chave pública ed25519. */
export function fingerprintFromPublicKey(publicKey: KeyObject | string): string {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  const der = key.export({ format: "der", type: "spki" });
  return sha256Hex(new Uint8Array(der)).toUpperCase();
}

export interface Ed25519VerifierOptions {
  /** PEM (ou KeyObject) da chave pública pinada pelo produto. */
  publicKey: KeyObject | string;
  /** Fingerprint esperado, para o verificador se auto-checar contra a config. */
  pinnedFingerprint: string;
}

/**
 * Verificador de manifesto ed25519. Recusa se:
 *  - a chave fornida não corresponde ao fingerprint pinado (config errada);
 *  - o `signedByFingerprint` do manifesto difere da chave pinada;
 *  - a assinatura não valida sobre os bytes canónicos.
 */
export function createEd25519ManifestVerifier(
  options: Ed25519VerifierOptions,
): ManifestSignatureVerifier {
  let key: KeyObject;
  try {
    key = typeof options.publicKey === "string" ? createPublicKey(options.publicKey) : options.publicKey;
  } catch {
    // Chave ilegível: verificador sempre nega (fail-closed), nunca deixa passar.
    return {
      verify: async () => ({ ok: false, reason: "unpinnable-key" }),
    };
  }
  const keyFingerprint = fingerprintFromPublicKey(key);
  const expected = normalizeFingerprint(options.pinnedFingerprint);

  return {
    async verify(
      canonicalBytes: string,
      signatureBase64: string,
      signedByFingerprint: string,
    ): Promise<SignatureVerifyResult> {
      if (keyFingerprint !== expected) {
        return { ok: false, reason: "pinned-key-mismatch" };
      }
      if (normalizeFingerprint(signedByFingerprint) !== keyFingerprint) {
        return { ok: false, reason: "fingerprint-mismatch" };
      }
      try {
        const ok = cryptoVerify(
          null,
          Buffer.from(canonicalBytes, "utf8"),
          key,
          Buffer.from(signatureBase64, "base64"),
        );
        return ok ? { ok: true } : { ok: false, reason: "invalid-signature" };
      } catch {
        return { ok: false, reason: "verify-threw" };
      }
    },
  };
}
