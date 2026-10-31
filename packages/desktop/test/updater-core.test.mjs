import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import path from "node:path";

import { compareSemVer, isDowngrade, isUpgrade, isValidSemVer, parseSemVer } from "../src/updater/semver.ts";
import { canonicalManifestBytes, validateManifest } from "../src/updater/manifest.ts";
import { isUrlAllowed, resolveUpdaterConfig } from "../src/updater/config.ts";
import { CachePathError, artifactCachePath } from "../src/updater/cache.ts";
import { createEd25519ManifestVerifier, fingerprintFromPublicKey, sha256Hex } from "../src/updater/crypto.ts";

/**
 * TP-UPDATE-01 — unidades PURAS do updater. Nada toca rede/disco/instalador.
 * Cobrem a lógica em que a segurança assenta: semver, validação de manifesto,
 * config fail-closed, política de caminho de cache, e o verificador ed25519 real
 * (com chaves EFÉMERAS só para exercitar o mecanismo, nunca como origem).
 */

function minimalRaw(overrides = {}) {
  return {
    schema: "cybersafe-release/1",
    channel: "stable",
    version: "0.2.0",
    publishedAt: "2026-10-17T00:00:00Z",
    notes: "Notas simples.",
    file: {
      url: "https://updates.example.test/app/setup.exe",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
    },
    signature: { algorithm: "ed25519", value: "AAAA", signedByFingerprint: "ABCD" },
    publisher: { name: "CyberSafe, Lda." },
    ...overrides,
  };
}

describe("semver — comparação de precedência", () => {
  it("ordena maior > menor e ignora metadados de build", () => {
    assert.equal(compareSemVer("1.0.0", "0.9.9"), 1);
    assert.equal(compareSemVer("1.2.3", "1.2.4"), -1);
    assert.equal(compareSemVer("1.0.0+build1", "1.0.0+build2"), 0, "build não afeta precedência");
  });

  it("pré-lançamento precede o lançamento e ordena identificadores", () => {
    assert.equal(compareSemVer("1.0.0-alpha", "1.0.0"), -1);
    assert.equal(compareSemVer("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
    assert.equal(compareSemVer("1.0.0-alpha", "1.0.0-alpha.1"), -1, "conjunto mais curto é prefixo");
    assert.equal(compareSemVer("1.0.0-1", "1.0.0-alpha"), -1, "numérico < alfanumérico");
  });

  it("isUpgrade/isDowngrade são estritos (igual não é upgrade)", () => {
    assert.equal(isUpgrade("0.2.0", "0.1.0"), true);
    assert.equal(isUpgrade("0.1.0", "0.1.0"), false);
    assert.equal(isDowngrade("0.0.9", "0.1.0"), true);
    assert.equal(isValidSemVer("v1.2.3"), false, "sem prefixo v");
    assert.deepEqual(parseSemVer("1.2.3-rc.1").prerelease, ["rc", "1"]);
    assert.equal(parseSemVer("1.2"), null);
  });
});

describe("manifest — valida e rejeita (fail-closed)", () => {
  it("aceita um manifesto bem-formado", () => {
    const r = validateManifest(minimalRaw());
    assert.equal(r.ok, true);
    assert.equal(r.manifest.channel, "stable");
    assert.equal(r.manifest.file.sha256, "a".repeat(64));
  });

  it("recusa http, sha inválido, tamanho <=0, canal errado, publisher ausente, semver inválido", () => {
    const bad = [
      { file: { ...minimalRaw().file, url: "http://x.test/a.exe" } },
      { file: { ...minimalRaw().file, url: "file:///C:/evil.exe" } },
      { file: { ...minimalRaw().file, sha256: "xyz" } },
      { file: { ...minimalRaw().file, sizeBytes: 0 } },
      { channel: "beta" },
      { publisher: { name: "" } },
      { publisher: undefined },
      { signature: { algorithm: "rsa", value: "AAAA", signedByFingerprint: "ABCD" } },
      { version: "1.2" },
    ];
    for (const override of bad) {
      const r = validateManifest(minimalRaw(override));
      assert.equal(r.ok, false, JSON.stringify(override));
      assert.equal(r.code, "invalid-manifest");
    }
  });

  it("recusa o que nem é objeto", () => {
    for (const junk of [null, undefined, "texto", 42, []]) {
      assert.equal(validateManifest(junk).ok, false, String(junk));
    }
  });

  it("bytes canónicos ignoram a assinatura e são estáveis", () => {
    const a = validateManifest(minimalRaw()).manifest;
    const b = validateManifest(minimalRaw({ signature: { algorithm: "ed25519", value: "ZZZZ", signedByFingerprint: "OTHER" } })).manifest;
    assert.equal(canonicalManifestBytes(a), canonicalManifestBytes(b), "a assinatura não entra no canonical");
  });
});

describe("config — fail-closed unconfigured", () => {
  const good = {
    channel: "stable",
    feedManifestUrl: "https://updates.example.test/app/stable/latest.json",
    originAllowlist: ["updates.example.test"],
    pinnedKeyFingerprint: "ABCD",
    expectedPublisherName: "CyberSafe, Lda.",
    cacheDir: "C:/cache/updater",
    timeoutMs: 5000,
    maxDownloadBytes: 500 * 1024 * 1024,
    automaticCheckEnabled: false,
  };

  it("aceita config completa e automática desligada por omissão", () => {
    const r = resolveUpdaterConfig(good);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.config.automaticCheckEnabled, false);
  });

  it("recusa cada peça de segurança em falta", () => {
    const cases = [
      ["missing-origin-allowlist", { originAllowlist: [] }],
      ["missing-feed-url", { feedManifestUrl: "" }],
      ["feed-origin-not-allowed", { feedManifestUrl: "https://evil.test/latest.json" }],
      ["missing-pinned-key", { pinnedKeyFingerprint: "" }],
      ["missing-publisher", { expectedPublisherName: "" }],
      ["missing-cache-dir", { cacheDir: "" }],
      ["bad-limits", { timeoutMs: 0 }],
    ];
    for (const [reason, patch] of cases) {
      const r = resolveUpdaterConfig({ ...good, ...patch });
      assert.equal(r.ok, false, reason);
      if (!r.ok) assert.equal(r.unconfigured.reason, reason);
    }
  });

  it("isUrlAllowed é por origem EXATA e só https", () => {
    assert.equal(isUrlAllowed("https://updates.example.test/a", ["updates.example.test"]), true);
    assert.equal(isUrlAllowed("http://updates.example.test/a", ["updates.example.test"]), false);
    assert.equal(isUrlAllowed("https://evil-updates.example.test/a", ["updates.example.test"]), false, "prefixo não basta");
  });
});

describe("cache — política de caminho contida", () => {
  it("gera caminho dentro da cache para nome válido", () => {
    const p = artifactCachePath("C:/cache/updater", "0.2.0", "b".repeat(64));
    assert.ok(p.startsWith(path.resolve("C:/cache/updater")), p);
  });
  it("recusa versão com travessia e hash inválido", () => {
    assert.throws(() => artifactCachePath("C:/cache/updater", "../evil", "b".repeat(64)), CachePathError);
    assert.throws(() => artifactCachePath("C:/cache/updater", "0.2.0", "nothex"), CachePathError);
  });
});

describe("crypto — ed25519 real com chaves efémeras (mecanismo)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprint = fingerprintFromPublicKey(publicKey);

  it("verifica assinatura válida e rejeita adulteração", async () => {
    const body = "manifesto-canónico";
    const sigB64 = Buffer.from(cryptoSign(null, Buffer.from(body, "utf8"), privateKey)).toString("base64");
    const verifier = createEd25519ManifestVerifier({ publicKey: pubPem, pinnedFingerprint: fingerprint });

    assert.equal((await verifier.verify(body, sigB64, fingerprint)).ok, true);
    assert.equal((await verifier.verify(body + "X", sigB64, fingerprint)).ok, false, "corpo adulterado");
    assert.equal((await verifier.verify(body, sigB64, "DEADBEEF")).ok, false, "fingerprint do manifesto errado");
  });

  it("verificador mal configurado (chave ≠ pinada) nega sempre", async () => {
    const verifier = createEd25519ManifestVerifier({ publicKey: pubPem, pinnedFingerprint: "FFFF".repeat(16) });
    const res = await verifier.verify("x", "AAAA", fingerprint);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "pinned-key-mismatch");
  });

  it("sha256Hex é determinístico", () => {
    assert.equal(sha256Hex("abc"), sha256Hex(new Uint8Array(Buffer.from("abc"))));
  });
});
