#!/usr/bin/env node
/**
 * Assinatura Ed25519 do manifesto de release (papel de BUILD, não do updater).
 *
 * O verificador de produção vive em `packages/desktop/src/updater/crypto.ts` e
 * assina/verifica os MESMOS bytes canónicos de `manifest.ts`. Este script não
 * duplica a política do updater: apenas produz a assinatura que ele verifica.
 *
 * Regras:
 *  - a chave privada NUNCA pode estar dentro do repositório (nem por symlink);
 *  - a chave é lida de um ficheiro fora do repo e nunca é impressa;
 *  - a assinatura é sobre `canonicalManifestBytes`, sem o bloco `signature`;
 *  - a chave pública é identificada por SHA-256 do DER SPKI, em maiúsculas,
 *    exatamente como `fingerprintFromPublicKey` no updater;
 *  - a chave privada não é gerada aqui. A geração/approvação é humana e está
 *    documentada em docs/RELEASE-SIGNING-RUNBOOK.md.
 *
 * Uso:
 *   node scripts/release-signing.mjs --fingerprint <public.pem>
 *   node scripts/release-signing.mjs --check-key <private.pem> <public.pem> <fingerprint>
 *   node scripts/release-signing.mjs --sign <manifest.json> --key <private.pem> --out <sig.txt>
 *   node scripts/release-signing.mjs --verify <manifest.json> --key <public.pem> --sig <sig.txt>
 *   node scripts/release-signing.mjs --sign-manifest <manifest.json> --key <private.pem> --fingerprint <fp> --out <signed.json>
 *   node scripts/release-signing.mjs --verify-embedded <signed.json> --key <public.pem>
 *
 * `--sign-manifest` é o caminho do workflow: só aceita manifesto DENTRO do
 * repositório, valida o caminho por realpath (sem symlink/junction para fora) e
 * escreve o manifesto completo com o bloco `signature` que o updater lê.
 *
 * Códigos: 0 = ok, 1 = falha de chave/assinatura/manifesto, 2 = uso inválido.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function usage() {
  return [
    "Uso:",
    "  node scripts/release-signing.mjs --fingerprint <public.pem>",
    "  node scripts/release-signing.mjs --check-key <private.pem> <public.pem> <fingerprint>",
    "  node scripts/release-signing.mjs --sign <manifest.json> --key <private.pem> --out <sig.txt>",
    "  node scripts/release-signing.mjs --verify <manifest.json> --key <public.pem> --sig <sig.txt>",
    "  node scripts/release-signing.mjs --sign-manifest <manifest.json> --key <private.pem> --fingerprint <fp> --out <signed.json>",
    "  node scripts/release-signing.mjs --verify-embedded <signed.json> --key <public.pem>",
    "",
    "A chave privada tem de estar FORA do repositório. Nunca é impressa.",
  ].join("\n");
}

function fail(message) {
  throw new Error(message);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Normaliza e valida o subconjunto que o updater assina (falha fechado). */
export function normalizeForSigning(raw) {
  const m = asRecord(raw);
  if (!m) fail("manifesto não é um objeto JSON");
  if (m.channel !== "stable") fail(`canal não suportado: ${String(m.channel)}`);
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) fail("version não é semver válido");
  if (typeof m.publishedAt !== "string" || Number.isNaN(Date.parse(m.publishedAt))) fail("publishedAt inválido");
  if (typeof m.notes !== "string") fail("notes tem de ser texto");
  const file = asRecord(m.file);
  if (!file) fail("falta o bloco file");
  if (typeof file.url !== "string") fail("file.url ausente");
  let url;
  try {
    url = new URL(file.url);
  } catch {
    fail("file.url inválido");
  }
  if (url.protocol !== "https:") fail("file.url tem de ser HTTPS");
  if (typeof file.sha256 !== "string" || !SHA256_HEX.test(file.sha256)) fail("file.sha256 inválido");
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) fail("file.sizeBytes inválido");
  const publisher = asRecord(m.publisher);
  if (!publisher || typeof publisher.name !== "string" || publisher.name.length === 0) fail("publisher.name ausente");
  return {
    schema: typeof m.schema === "string" ? m.schema : "cybersafe-release/1",
    channel: "stable",
    version: m.version,
    publishedAt: m.publishedAt,
    notes: m.notes,
    file: { url: file.url, sha256: file.sha256.toLowerCase(), sizeBytes: file.sizeBytes },
    publisher: { name: publisher.name },
    requiresElevation: m.requiresElevation === true,
  };
}

/** Bytes canónicos — mesma ordem e campos de `manifest.ts`. */
export function canonicalManifestBytes(manifest) {
  return JSON.stringify({
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
  });
}

/**
 * Confina o manifesto de entrada ao repositório antes de o ler. O realpath
 * resolve symlinks/junctions; a verificação de containment acontece ANTES de
 * qualquer leitura de conteúdo e exige ficheiro regular. Recusa aspas/controlos
 * (não são nomes Windows válidos e não devem chegar ao shell).
 */
export function resolveManifestPath(manifestPath, root = ROOT) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    fail("manifesto: caminho vazio");
  }
  if (/[\u0000-\u001f"]/u.test(manifestPath)) {
    fail("manifesto: caminho com caracteres inválidos");
  }
  const rootReal = fs.realpathSync(path.resolve(root));
  const candidate = path.resolve(rootReal, manifestPath);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    fail(`manifesto não existe: ${manifestPath}`);
  }
  const norm = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const rel = path.relative(norm(rootReal), norm(real));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail("manifesto fora do repositório: recusado");
  }
  if (!fs.statSync(real).isFile()) {
    fail("manifesto não é ficheiro regular");
  }
  return real;
}

function normalizeFingerprint(value) {
  return String(value).replace(/[:\s-]/g, "").toUpperCase();
}

export function fingerprintFromPublicKeyPem(pem) {
  const key = createPublicKey(pem);
  const der = key.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").toUpperCase();
}

export function signCanonical(privateKey, canonical) {
  return sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
}

/**
 * Produz o documento FINAL que o updater valida: corpo normalizado + bloco
 * `signature` embutido. A assinatura cobre os bytes canónicos do corpo, que são
 * exactamente os campos que aqui ficam. Campos desconhecidos do input não são
 * copiados, para não ficarem fora da assinatura.
 */
export function buildSignedManifest(raw, privateKey, expectedFingerprint) {
  const manifest = normalizeForSigning(raw);
  const derivedPublic = createPublicKey(privateKey);
  const fingerprint = fingerprintFromPublicKeyPem(
    derivedPublic.export({ format: "pem", type: "spki" }).toString(),
  );
  if (normalizeFingerprint(expectedFingerprint) !== fingerprint) {
    fail(`fingerprint esperado não corresponde: ${String(expectedFingerprint)} != ${fingerprint}`);
  }
  const signature = signCanonical(privateKey, canonicalManifestBytes(manifest));
  return {
    signed: {
      ...manifest,
      signature: { algorithm: "ed25519", value: signature, signedByFingerprint: fingerprint },
    },
    fingerprint,
    signature,
  };
}

export function verifyCanonical(publicKey, canonical, signatureBase64) {
  try {
    return verify(
      null,
      Buffer.from(canonical, "utf8"),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * A chave privada tem de estar fora do repositório. A comparação usa o
 * `realpath` (apanha symlinks) e é case-insensitive em Windows.
 */
export function assertPrivateKeyOutsideRepo(keyPath, root = ROOT) {
  const keyReal = fs.realpathSync(path.resolve(keyPath));
  const rootReal = fs.realpathSync(path.resolve(root));
  const norm = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const rel = path.relative(norm(rootReal), norm(keyReal));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    fail("chave privada dentro do repositório: recusado");
  }
  const stat = fs.statSync(keyReal);
  if (!stat.isFile()) fail("chave privada não é um ficheiro regular");
  return keyReal;
}

export function loadPrivateKey(keyPath, root = ROOT) {
  const real = assertPrivateKeyOutsideRepo(keyPath, root);
  const key = createPrivateKey(fs.readFileSync(real));
  if (key.asymmetricKeyType !== "ed25519") fail(`chave privada não é ed25519: ${key.asymmetricKeyType}`);
  return key;
}

export function loadPublicKey(keyPath) {
  const key = createPublicKey(fs.readFileSync(path.resolve(keyPath)));
  if (key.asymmetricKeyType !== "ed25519") fail(`chave pública não é ed25519: ${key.asymmetricKeyType}`);
  return key;
}

export function checkKeyPair(privatePath, publicPath, expectedFingerprint, root = ROOT) {
  const privateKey = loadPrivateKey(privatePath, root);
  const publicKey = loadPublicKey(publicPath);
  const derivedPublic = createPublicKey(privateKey);
  const fingerprint = fingerprintFromPublicKeyPem(derivedPublic.export({ format: "pem", type: "spki" }).toString());
  if (fingerprint !== fingerprintFromPublicKeyPem(publicKey.export({ format: "pem", type: "spki" }).toString())) {
    fail("chave pública não corresponde à privada");
  }
  if (normalizeFingerprint(expectedFingerprint) !== fingerprint) {
    fail(`fingerprint esperado não corresponde: ${String(expectedFingerprint)} != ${fingerprint}`);
  }
  return { fingerprint, publicKey, privateKey };
}

function readManifest(file) {
  return normalizeForSigning(JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
}

function signFile(manifestPath, keyPath, outPath) {
  const manifest = readManifest(manifestPath);
  const canonical = canonicalManifestBytes(manifest);
  const signature = signCanonical(loadPrivateKey(keyPath), canonical);
  fs.writeFileSync(path.resolve(outPath), `${signature}\n`, "utf8");
  return signature;
}

function verifyFile(manifestPath, keyPath, sigPath) {
  const manifest = readManifest(manifestPath);
  const canonical = canonicalManifestBytes(manifest);
  const signature = fs.readFileSync(path.resolve(sigPath), "utf8").trim();
  if (!BASE64.test(signature)) return { ok: false, reason: "assinatura não é base64" };
  const ok = verifyCanonical(loadPublicKey(keyPath), canonical, signature);
  return { ok, reason: ok ? null : "assinatura inválida" };
}

function signEmbeddedFile(manifestPath, keyPath, expectedFingerprint, outPath) {
  const real = resolveManifestPath(manifestPath);
  const raw = JSON.parse(fs.readFileSync(real, "utf8"));
  const result = buildSignedManifest(raw, loadPrivateKey(keyPath), expectedFingerprint);
  fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(result.signed, null, 2)}\n`, "utf8");
  return result;
}

function verifyEmbeddedFile(signedPath, keyPath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(signedPath), "utf8"));
  const signature = asRecord(raw.signature);
  if (
    !signature ||
    signature.algorithm !== "ed25519" ||
    typeof signature.value !== "string" ||
    !BASE64.test(signature.value) ||
    typeof signature.signedByFingerprint !== "string"
  ) {
    return { ok: false, reason: "bloco signature inválido" };
  }
  const manifest = normalizeForSigning(raw);
  const publicKey = loadPublicKey(keyPath);
  const fingerprint = fingerprintFromPublicKeyPem(
    publicKey.export({ format: "pem", type: "spki" }).toString(),
  );
  if (normalizeFingerprint(signature.signedByFingerprint) !== fingerprint) {
    return { ok: false, reason: "fingerprint do manifesto não corresponde à chave" };
  }
  const ok = verifyCanonical(publicKey, canonicalManifestBytes(manifest), signature.value);
  return { ok, reason: ok ? null : "assinatura inválida" };
}

function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  try {
    const [command, ...rest] = argv;
    if (command === "--fingerprint") {
      if (!rest[0]) return 2;
      process.stdout.write(`${fingerprintFromPublicKeyPem(fs.readFileSync(path.resolve(rest[0]), "utf8"))}\n`);
      return 0;
    }
    if (command === "--check-key") {
      if (rest.length < 3) return 2;
      const result = checkKeyPair(rest[0], rest[1], rest[2]);
      process.stdout.write(`chave ed25519 coerente: ${result.fingerprint}\n`);
      return 0;
    }
    if (command === "--sign" || command === "--verify" || command === "--sign-manifest" || command === "--verify-embedded") {
      const manifestPath = rest.find(
        (arg) => !arg.startsWith("--") && !["--key", "--out", "--sig", "--fingerprint"].includes(arg),
      );
      const value = (flag) => {
        const index = rest.indexOf(flag);
        return index >= 0 ? rest[index + 1] : undefined;
      };
      const keyPath = value("--key");
      if (!manifestPath || !keyPath) return 2;
      if (command === "--sign") {
        const outPath = value("--out");
        if (!outPath) return 2;
        const signature = signFile(manifestPath, keyPath, outPath);
        process.stdout.write(`assinatura escrita (${signature.length} chars base64)\n`);
        return 0;
      }
      if (command === "--sign-manifest") {
        const outPath = value("--out");
        const expectedFingerprint = value("--fingerprint");
        if (!outPath || !expectedFingerprint) return 2;
        const result = signEmbeddedFile(manifestPath, keyPath, expectedFingerprint, outPath);
        process.stdout.write(`manifesto assinado escrito (fingerprint ${result.fingerprint})\n`);
        return 0;
      }
      if (command === "--verify-embedded") {
        const result = verifyEmbeddedFile(manifestPath, keyPath);
        process.stdout.write(`${result.ok ? "OK" : `FALHA: ${result.reason}`}\n`);
        return result.ok ? 0 : 1;
      }
      const sigPath = value("--sig");
      if (!sigPath) return 2;
      const result = verifyFile(manifestPath, keyPath, sigPath);
      process.stdout.write(`${result.ok ? "OK" : `FALHA: ${result.reason}`}\n`);
      return result.ok ? 0 : 1;
    }
    process.stderr.write(`comando desconhecido: ${command}\n${usage()}\n`);
    return 2;
  } catch (error) {
    process.stderr.write(`release-signing: FALHA: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
