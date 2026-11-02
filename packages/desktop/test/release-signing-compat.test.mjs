import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  canonicalManifestBytes as updaterCanonical,
  validateManifest,
} from "../src/updater/manifest.ts";
import { createEd25519ManifestVerifier } from "../src/updater/crypto.ts";
import {
  buildSignedManifest,
  canonicalManifestBytes as signerCanonical,
  fingerprintFromPublicKeyPem,
} from "../../../scripts/release-signing.mjs";

/**
 * O assinador de release e o verificador de produção não podem divergir no
 * canónico: uma assinatura válida sobre outra serialização seria rejeitada em
 * runtime (ou, pior, assinaria campos que o updater não lê).
 */
test("assinador e updater canonicalizam os mesmos bytes", () => {
  const manifest = {
    schema: "cybersafe-release/1",
    channel: "stable",
    version: "0.1.11",
    publishedAt: "2026-10-31T12:00:00.000Z",
    notes: "Candidata interna.",
    file: {
      url: "https://github.com/MatrixChill/cybersafe-assistant/releases/download/v0.1.11/setup.exe",
      sha256: "b".repeat(64),
      sizeBytes: 987654,
    },
    signature: { algorithm: "ed25519", value: "ignorado", signedByFingerprint: "ignorado" },
    publisher: { name: "CyberSafe Assistant — academic unsigned" },
    requiresElevation: true,
  };
  assert.equal(signerCanonical(manifest), updaterCanonical(manifest));
});

test("manifesto assinado embutido é aceite pelo validador e verificador do updater", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const fingerprint = fingerprintFromPublicKeyPem(publicPem);
  const signed = buildSignedManifest(
    {
      schema: "cybersafe-release/1",
      channel: "stable",
      version: "0.1.11",
      publishedAt: "2026-10-31T12:00:00.000Z",
      notes: "Candidata interna.",
      file: {
        url: "https://github.com/MatrixChill/cybersafe-assistant/releases/download/v0.1.11/setup.exe",
        sha256: "c".repeat(64),
        sizeBytes: 123456,
      },
      publisher: { name: "CyberSafe Assistant — academic unsigned" },
      requiresElevation: false,
    },
    privateKey,
    fingerprint,
  ).signed;

  const validation = validateManifest(signed);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const verifier = createEd25519ManifestVerifier({
    publicKey: publicPem,
    pinnedFingerprint: fingerprint,
  });
  const result = await verifier.verify(
    updaterCanonical(validation.manifest),
    validation.manifest.signature.value,
    validation.manifest.signature.signedByFingerprint,
  );
  assert.deepEqual(result, { ok: true });
});

test('real artifact bytes -> release producer -> signer -> client share the contract', async t => {
 const fs=await import('node:fs/promises');
 const path=await import('node:path');
 const {fileURLToPath}=await import('node:url');
 const {construirManifesto}=await import('../../../scripts/release-manifest.mjs');
 const {createHash}=await import('node:crypto');
 const dir=await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)),'release-chain-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 // The file is real; the bytes are explicitly a benign fixture, not a setup.
 const bytes=Buffer.from('benign artifact fixture; never executed');
 const file=path.join(dir,'fixture.bin');await fs.writeFile(file,bytes);
 const manifest=await construirManifesto({ficheiro:file,url:'https://github.com/MatrixChill/cybersafe-assistant/releases/download/v0.2.0/fixture.bin',version:'0.2.0',channel:'stable',notes:'Isolated fixture only; not a published release',requiresElevation:false});
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const publicPem=publicKey.export({format:'pem',type:'spki'}).toString();
 const fingerprint=fingerprintFromPublicKeyPem(publicPem);
 const signed=buildSignedManifest(manifest,privateKey,fingerprint).signed;
 const parsed=validateManifest(signed);assert.equal(parsed.ok,true);
 assert.equal(parsed.manifest.file.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal(parsed.manifest.file.sizeBytes,bytes.length);
 assert.deepEqual(await createEd25519ManifestVerifier({publicKey:publicPem,pinnedFingerprint:fingerprint}).verify(updaterCanonical(parsed.manifest),parsed.manifest.signature.value,parsed.manifest.signature.signedByFingerprint),{ok:true});
});
