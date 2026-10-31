import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as url from "node:url";

import {
  assertPrivateKeyOutsideRepo,
  canonicalManifestBytes,
  checkKeyPair,
  fingerprintFromPublicKeyPem,
  loadPrivateKey,
  loadPublicKey,
  normalizeForSigning,
  signCanonical,
  verifyCanonical,
} from "../release-signing.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "release-signing.mjs");

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function manifest(overrides = {}) {
  return {
    schema: "cybersafe-release/1",
    channel: "stable",
    version: "0.1.11",
    publishedAt: "2026-10-31T12:00:00.000Z",
    notes: "Candidata interna; não distribuir.",
    file: {
      url: "https://github.com/MatrixChill/cybersafe-assistant/releases/download/v0.1.11/setup.exe",
      sha256: "a".repeat(64),
      sizeBytes: 123456,
    },
    publisher: { name: "CyberSafe Assistant — academic unsigned" },
    requiresElevation: false,
    ...overrides,
  };
}

describe("release-signing — canónico e Ed25519", () => {
  it("o canónico exclui a assinatura e mantém a ordem do updater", () => {
    const normalized = normalizeForSigning(manifest());
    const canonical = canonicalManifestBytes(normalized);
    assert.ok(!canonical.includes("signature"));
    assert.equal(
      canonical,
      JSON.stringify({
        schema: "cybersafe-release/1",
        channel: "stable",
        version: "0.1.11",
        publishedAt: "2026-10-31T12:00:00.000Z",
        notes: "Candidata interna; não distribuir.",
        file: {
          url: "https://github.com/MatrixChill/cybersafe-assistant/releases/download/v0.1.11/setup.exe",
          sha256: "a".repeat(64),
          sizeBytes: 123456,
        },
        publisher: { name: "CyberSafe Assistant — academic unsigned" },
        requiresElevation: false,
      }),
    );
  });

  it("assina e verifica; um byte alterado falha", () => {
    const { privateKey, publicKey } = pair();
    const canonical = canonicalManifestBytes(normalizeForSigning(manifest()));
    const signature = signCanonical(privateKey, canonical);
    assert.equal(verifyCanonical(publicKey, canonical, signature), true);
    assert.equal(verifyCanonical(publicKey, `${canonical} `, signature), false);
    assert.equal(verifyCanonical(publicKey, canonical, Buffer.from("lixo").toString("base64")), false);
  });

  it("fingerprint é SHA-256 do DER SPKI, maiúsculo", () => {
    const { publicKey, publicPem } = pair();
    const expected = fingerprintFromPublicKeyPem(publicPem);
    assert.match(expected, /^[0-9A-F]{64}$/);
    assert.equal(expected, fingerprintFromPublicKeyPem(publicKey.export({ format: "pem", type: "spki" }).toString()));
  });

  it("recusa chave privada dentro do repositório", () => {
    assert.throws(
      () => assertPrivateKeyOutsideRepo(path.join(REPO_ROOT, "package.json")),
      /dentro do repositório/,
    );
  });

  it("checkKeyPair confirma que a pública pertence à privada", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-signing-"));
    try {
      const { privatePem, publicPem } = pair();
      const privatePath = path.join(dir, "private.pem");
      const publicPath = path.join(dir, "public.pem");
      fs.writeFileSync(privatePath, privatePem);
      fs.writeFileSync(publicPath, publicPem);
      const fingerprint = fingerprintFromPublicKeyPem(publicPem);
      const result = checkKeyPair(privatePath, publicPath, fingerprint, REPO_ROOT);
      assert.equal(result.fingerprint, fingerprint);
      assert.equal(loadPrivateKey(privatePath).asymmetricKeyType, "ed25519");
      assert.equal(loadPublicKey(publicPath).asymmetricKeyType, "ed25519");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI assina e verifica o mesmo manifesto", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-signing-cli-"));
    try {
      const { privatePem, publicPem } = pair();
      const privatePath = path.join(dir, "private.pem");
      const publicPath = path.join(dir, "public.pem");
      const manifestPath = path.join(dir, "manifest.json");
      const signaturePath = path.join(dir, "manifest.sig");
      fs.writeFileSync(privatePath, privatePem);
      fs.writeFileSync(publicPath, publicPem);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
      execFileSync(process.execPath, [SCRIPT, "--sign", manifestPath, "--key", privatePath, "--out", signaturePath], {
        encoding: "utf8",
      });
      const out = execFileSync(
        process.execPath,
        [SCRIPT, "--verify", manifestPath, "--key", publicPath, "--sig", signaturePath],
        { encoding: "utf8" },
      );
      assert.match(out, /^OK/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
