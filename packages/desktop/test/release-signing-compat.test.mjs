import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalManifestBytes as updaterCanonical } from "../src/updater/manifest.ts";
import { canonicalManifestBytes as signerCanonical } from "../../../scripts/release-signing.mjs";

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
