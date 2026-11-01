import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { createUpdater } from "../src/updater/updater.ts";
import { HttpsFeedSource, LocalFixtureSource } from "../src/updater/sources.ts";
import { validateManifest, canonicalManifestBytes } from "../src/updater/manifest.ts";
import { createEd25519ManifestVerifier, fingerprintFromPublicKey, sha256Hex } from "../src/updater/crypto.ts";
import { SourceError } from "../src/updater/types.ts";
import {
  canonicalManifestBytes as toolCanonicalBytes,
  normalizeForSigning,
} from "../../../scripts/release-signing.mjs";

/**
 * FASE D — fecho dos buracos §12.7/§12.3/§12.4 deixados pela linha R7:
 * limite de pedidos; pré-release não elegível no canal estável; falha do
 * instalador (retorna-falha E lança); artefacto ausente após download;
 * mapeamento de respostas HTTP do HttpsFeedSource; campos buildId/
 * sourceCommit/compatibility com bytes canónicos idênticos tool↔updater e
 * compatibilidade total com manifestos antigos. Nada de rede real.
 */

const HOST = "updates.example.test";
const PUBLISHER = "CyberSafe, Lda.";

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, pubPem, fingerprint: fingerprintFromPublicKey(publicKey) };
}

function signedRelease(extra = {}, version = "0.2.0") {
  const signer = makeKeys();
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const raw = {
    schema: "cybersafe-release/1",
    channel: "stable",
    version,
    publishedAt: "2026-10-31T00:00:00Z",
    notes: "Melhorias.",
    file: { url: `https://${HOST}/app/setup.exe`, sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    signature: { algorithm: "ed25519", value: "AAAA", signedByFingerprint: signer.fingerprint },
    publisher: { name: PUBLISHER },
    requiresElevation: false,
    ...extra,
  };
  const canonical = canonicalManifestBytes(validateManifest(raw).manifest);
  raw.signature.value = Buffer.from(cryptoSign(null, Buffer.from(canonical, "utf8"), signer.privateKey)).toString("base64");
  return { raw, bytes, sha: sha256Hex(bytes), signer };
}

function memoryFs() {
  const files = new Map();
  return {
    files,
    ensureDir: async () => {},
    statFile: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readFile: async (p) => (files.has(p) ? files.get(p) : null),
    removePath: async (p) => { files.delete(p); },
    writeAtomic: async (destPath, tmpSuffix, data) => {
      files.set(destPath.replace(/\.tmp$/, tmpSuffix), data);
    },
  };
}

function fixedConfig(over = {}) {
  return {
    ok: true,
    config: {
      channel: "stable",
      feedManifestUrl: `https://${HOST}/app/stable/latest.json`,
      originAllowlist: [HOST],
      pinnedKeyFingerprint: "PINNED",
      expectedPublisherName: PUBLISHER,
      cacheDir: "/tmp/cs-gap-cache",
      timeoutMs: 5000,
      maxDownloadBytes: 500 * 1024 * 1024,
      automaticCheckEnabled: false,
      ...over,
    },
  };
}

function harness(release, depsOver = {}, configOver = {}) {
  const fs = memoryFs();
  let clockNow = 1_000_000;
  const keys = makeKeys();
  const base = {
    config: fixedConfig(configOver),
    runtimeSupported: true,
    installed: { version: "0.1.0" },
    clock: { now: () => clockNow, iso: () => new Date(clockNow).toISOString() },
    downloader: {
      async download(url, destination, signal, onProgress) {
        const payload = release?.bytes ?? new Uint8Array([1]);
        fs.files.set(destination, payload);
        onProgress(payload.length, undefined);
        return { path: destination, bytes: payload.length };
      },
    },
    signatureVerifier: createEd25519ManifestVerifier({ publicKey: release.signer.pubPem, pinnedFingerprint: release.signer.fingerprint }),
    publisherVerifier: { async verify() { return { ok: true }; } },
    installer: { async install() { return { ok: true }; } },
    cacheFs: fs,
    scanProbe: async () => "idle",
    source: new LocalFixtureSource(() => ({ kind: "latest", manifest: release.raw })),
  };
  const deps = { ...base, ...depsOver };
  const updater = createUpdater(deps);
  return { updater, fs, advance: (ms) => { clockNow += ms; } };
}

async function downloadedHarness(release, depsOver = {}, configOver = {}) {
  const h = harness(release, depsOver, configOver);
  assert.equal((await h.updater.check()).ok, true);
  const dl = await h.updater.download();
  assert.equal(dl.ok, true, JSON.stringify(dl.snapshot.error));
  return h;
}

describe("D1 limite de pedidos (§12.3)", () => {
  it("segundo check imediato é rate-limited sem tocar no feed; após o intervalo passa", async () => {
    const release = signedRelease();
    let fetches = 0;
    const h = harness(release, {
      source: { fetchLatest: async () => { fetches += 1; return { kind: "latest", manifest: release.raw }; } },
    }, { minCheckIntervalMs: 30_000 });
    const first = await h.updater.check();
    assert.equal(first.ok, true);
    const second = await h.updater.check();
    assert.equal(second.ok, false);
    assert.equal(second.error, "rate-limited");
    assert.equal(fetches, 1, "check rate-limited NÃO pode contactar o feed");
    assert.equal(second.snapshot.phase, "error");
    h.advance(30_001);
    const third = await h.updater.check();
    assert.equal(third.ok, true);
    assert.equal(fetches, 2);
  });

  it("check que falha no feed conta para o intervalo (anti-hammering em erro)", async () => {
    const release = signedRelease();
    let fetches = 0;
    const h = harness(release, {
      source: { fetchLatest: async () => { fetches += 1; throw new SourceError("offline", "sem rede"); } },
    }, { minCheckIntervalMs: 30_000 });
    const first = await h.updater.check();
    assert.equal(first.error, "offline");
    const second = await h.updater.check();
    assert.equal(second.error, "rate-limited");
    assert.equal(fetches, 1);
  });

  it("config sem minCheckIntervalMs não limita (fikes antigos intactos)", async () => {
    const release = signedRelease();
    const h = harness(release, {}, {});
    assert.equal((await h.updater.check()).ok, true);
    assert.equal((await h.updater.check()).ok, true);
  });
});

describe("D3 pré-release/interno não elegível no canal estável", () => {
  it("manifesto assinado mas com pré-release é bloqueado antes de available", async () => {
    const release = signedRelease({}, "0.3.0-internal.pap-r7.20261031");
    const h = harness(release);
    const res = await h.updater.check();
    assert.equal(res.ok, false);
    assert.equal(res.error, "invalid-manifest");
    assert.equal(h.updater.snapshotCopy().latest, undefined, "notas de upstream não são promovidas");
    assert.notEqual(h.updater.snapshotCopy().phase, "available");
  });

  it("versão core igual à instalada continua upToDate sem erro", async () => {
    const release = signedRelease({}, "0.1.0");
    const h = harness(release);
    const res = await h.updater.check();
    assert.equal(res.ok, true);
    assert.equal(res.snapshot.phase, "upToDate");
  });
});

describe("D4 §12.7 cenários sem teste na R7", () => {
  it("instalador que reporta falha → erro installation, canInstall limpo, bytes preservados", async () => {
    const release = signedRelease();
    const h = await downloadedHarness(release, {
      installer: { async install() { return { ok: false, message: "instalação falhou" }; } },
    });
    const before = h.fs.files.size;
    const res = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "installation");
    assert.equal(res.snapshot.canInstall, false);
    assert.ok(h.fs.files.size >= before, "cache não é destruída por falha de instalação");
  });

  it("instalador que lança → erro installation fail-closed", async () => {
    const release = signedRelease();
    const h = await downloadedHarness(release, {
      installer: { async install() { throw new Error("boom"); } },
    });
    const res = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "installation");
  });

  it("artefacto ausente após download → integridade recusa, nada é instalado", async () => {
    const release = signedRelease();
    const fs = memoryFs();
    let clockNow = 1_000_000;
    const h = harness(release, {
      cacheFs: fs,
      downloader: {
        async download(url, destination, signal, onProgress) {
          // escreve em staging mas NADA chega ao destino lido após commit
          onProgress(8, 8);
          return { path: destination, bytes: 8 };
        },
      },
    });
    await h.updater.check();
    const res = await h.updater.download();
    assert.equal(res.ok, false);
    assert.equal(res.error, "integrity");
    assert.equal(res.snapshot.canInstall, false);
  });

  it("manifesto válido propaga buildId e sourceCommit para o snapshot", async () => {
    const release = signedRelease({
      buildId: "20261031-215559",
      sourceCommit: "edb5f1c012345678901234567890123456789012",
      compatibility: { minWindowsBuild: 19041, fromVersion: "0.1.0" },
    });
    const h = harness(release);
    const res = await h.updater.check();
    assert.equal(res.ok, true);
    assert.equal(res.snapshot.latest.buildId, "20261031-215559");
    assert.equal(res.snapshot.latest.sourceCommit, "edb5f1c012345678901234567890123456789012");
  });

  it("campos malformados são manifesto inválido (falha fechada)", () => {
    const mk = (extra) => validateManifest({
      channel: "stable", version: "0.2.0", publishedAt: "2026-10-31T00:00:00Z", notes: "n",
      file: { url: `https://${HOST}/s.exe`, sha256: "a".repeat(64), sizeBytes: 1 },
      signature: { algorithm: "ed25519", value: "AAAA", signedByFingerprint: "FP" },
      publisher: { name: PUBLISHER },
      ...extra,
    });
    assert.equal(mk({ sourceCommit: "not-hex-zzzzzzz" }).ok, false);
    assert.equal(mk({ buildId: 123 }).ok, false);
    assert.equal(mk({ compatibility: { fromVersion: "0.1" } }).ok, false);
    assert.equal(mk({ compatibility: "sim" }).ok, false);
    assert.equal(mk({ buildId: "ok", sourceCommit: "abc1234", compatibility: { minWindowsBuild: 19041, fromVersion: "0.1.0" } }).ok, true);
  });
});

describe("D2 bytes canónicos tool↔updater (§12.4)", () => {
  it("manifesto antigo (sem campos novos): canonical IDÊNTICO ao de R7 — zero rutura", () => {
    const release = signedRelease();
    const updaterBytes = canonicalManifestBytes(validateManifest(release.raw).manifest);
    const toolManifest = normalizeForSigning(JSON.parse(JSON.stringify(release.raw)));
    const toolBytes = toolCanonicalBytes(toolManifest);
    assert.equal(updaterBytes, toolBytes);
    // forma exata esperada (ordem fixa, sem chaves novas):
    const body = JSON.parse(updaterBytes);
    assert.deepEqual(Object.keys(body), ["schema", "channel", "version", "publishedAt", "notes", "file", "publisher", "requiresElevation"]);
  });

  it("com buildId/sourceCommit/compatibility: tool e updater produzem os mesmos bytes", () => {
    const release = signedRelease({
      buildId: "b-1", sourceCommit: "ABCDEF01234567", compatibility: { minWindowsBuild: 19041, fromVersion: "0.1.0" },
    });
    const validated = validateManifest(release.raw).manifest;
    assert.equal(validated.sourceCommit, "abcdef01234567", "commit é normalizado a minúsculas");
    const updaterBytes = canonicalManifestBytes(validated);
    const toolBytes = toolCanonicalBytes(normalizeForSigning(JSON.parse(JSON.stringify(release.raw))));
    assert.equal(updaterBytes, toolBytes);
    assert.match(updaterBytes, /"buildId":"b-1"/);
    assert.match(updaterBytes, /"compatibility":\{"minWindowsBuild":19041,"fromVersion":"0.1\.0"\}/);
  });
});

describe("HttpsFeedSource — mapeamento de respostas (§12.7 'resposta HTTP inválida')", () => {
  const cfg = fixedConfig().config;
  const mk = (status, bodyText) => new HttpsFeedSource(cfg, { async fetch() { return { status, bodyText }; } });
  const sig = new AbortController().signal;

  it("404 e 204 → sem atualização (kind none)", async () => {
    assert.deepEqual(await mk(404, "").fetchLatest(sig), { kind: "none" });
    assert.deepEqual(await mk(204, "").fetchLatest(sig), { kind: "none" });
  });

  it("5xx → offline; 4xx (não-404) → invalid-manifest", async () => {
    await assert.rejects(mk(500, "boom").fetchLatest(sig), (e) => e instanceof SourceError && e.code === "offline");
    await assert.rejects(mk(403, "nope").fetchLatest(sig), (e) => e instanceof SourceError && e.code === "invalid-manifest");
  });

  it("JSON inválido → invalid-manifest", async () => {
    await assert.rejects(mk(200, "{isto não é json").fetchLatest(sig), (e) => e.code === "invalid-manifest");
  });

  it("falha de transporte sem abort → offline; com abort → propaga (updater classifica)", async () => {
    const boom = new HttpsFeedSource(cfg, { async fetch() { throw new Error("ECONNREFUSED"); } });
    await assert.rejects(boom.fetchLatest(sig), (e) => e.code === "offline");
    const ac = new AbortController();
    ac.abort();
    const aborted = new HttpsFeedSource(cfg, { async fetch() { const e = new Error("abort"); throw e; } });
    await assert.rejects(aborted.fetchLatest(ac.signal), (e) => !(e instanceof SourceError));
  });

  it("feed fora da allowlist no momento do pedido → untrusted-metadata", async () => {
    const evil = new HttpsFeedSource({ ...cfg, originAllowlist: [] }, { async fetch() { return { status: 200, bodyText: "{}" }; } });
    await assert.rejects(evil.fetchLatest(sig), (e) => e.code === "untrusted-metadata");
  });
});
