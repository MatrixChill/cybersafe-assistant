import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { createUpdater } from "../src/updater/updater.ts";
import { resolveUpdaterConfig } from "../src/updater/config.ts";
import { HttpsFeedSource } from "../src/updater/sources.ts";
import { fingerprintFromPublicKey, sha256Hex } from "../src/updater/crypto.ts";
import { canonicalManifestBytes, validateManifest } from "../src/updater/manifest.ts";

/*
 * Integração do atualizador com feed assinado e artefacto de LABORATÓRIO.
 * Chaves efémeras geradas em memória (nunca a chave de produção). A rede é
 * simulada por rotas em memória que devolvem bytes reais; o pipeline de
 * verificação (assinatura, SHA-256, tamanho, origem) é o do produto.
 */

const FEED = "https://updates.example.test/app/stable/latest.json";
const ARTIFACT_URL = "https://updates.example.test/app/stable/setup.exe";
const PUBLISHER = "CyberSafe, Lda.";

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    fp: fingerprintFromPublicKey(publicKey),
  };
}

/** Manifesto assinado com `k`; `overrides` permite forjar campos depois de assinar. */
function signedFeed(k, { version = "0.3.0", artifact, fileOverride, postSignTamper } = {}) {
  const file = fileOverride ?? { url: ARTIFACT_URL, sha256: sha256Hex(artifact), sizeBytes: artifact.length };
  const base = {
    channel: "stable",
    version,
    publishedAt: "2026-11-01T00:00:00Z",
    notes: "Laboratório.",
    file,
    publisher: { name: PUBLISHER },
  };
  // Assina exatamente os bytes que o updater recalcula: canonicalManifestBytes do manifesto VALIDADO.
  const placeholder = { ...base, signature: { algorithm: "ed25519", value: "AA==", signedByFingerprint: k.fp } };
  const v = validateManifest(placeholder);
  if (!v.ok) throw new Error("manifesto de teste inválido: " + v.message);
  const canonical = canonicalManifestBytes(v.manifest);
  const value = Buffer.from(cryptoSign(null, Buffer.from(canonical, "utf8"), k.privateKey)).toString("base64");
  const signed = { ...base, signature: { algorithm: "ed25519", value, signedByFingerprint: k.fp } };
  const out = postSignTamper ? postSignTamper(signed) : signed;
  return JSON.stringify(out);
}

/** Rotas HTTPS simuladas: url -> { status, body }. Regista os pedidos feitos. */
function fakeNetwork(routes) {
  const requested = [];
  async function get(url, signal) {
    requested.push(url);
    if (signal.aborted) throw new Error("aborted");
    const r = routes[url];
    if (!r) throw new Error(`sem rota: ${url}`);
    return { status: r.status ?? 200, bytes: Buffer.from(r.body) };
  }
  return { requested, get };
}

function memoryFs() {
  const files = new Map();
  return {
    files,
    fs: {
      async ensureDir() {},
      async statFile(p) { const b = files.get(p); return b ? { size: b.length } : null; },
      async writeAtomic(p, _tmp, data) { files.set(p, Buffer.from(data)); },
      async readFile(p) { const b = files.get(p); return b ? new Uint8Array(b) : null; },
    },
  };
}

function makeUpdater({ k, net, installed = "0.2.0", fsMem = memoryFs() }) {
  const resolution = resolveUpdaterConfig({
    channel: "stable",
    feedManifestUrl: FEED,
    originAllowlist: ["updates.example.test"],
    pinnedKeyFingerprint: k.fp,
    expectedPublisherName: PUBLISHER,
    cacheDir: "C:/lab/cache",
    timeoutMs: 5000,
    maxDownloadBytes: 10 * 1024 * 1024,
    automaticCheckEnabled: false,
    minCheckIntervalMs: 30000,
  });
  assert.equal(resolution.ok, true, JSON.stringify(resolution.unconfigured));

  const feedFetcher = {
    async fetch(url, signal) {
      const r = await net.get(url, signal);
      return { status: r.status, bodyText: r.bytes.toString("utf8") };
    },
  };
  const downloader = {
    async download(url, destination, signal, onProgress) {
      const r = await net.get(url, signal);
      onProgress?.(r.bytes.length, r.bytes.length);
      fsMem.files.set(destination, r.bytes);
      return { path: destination, bytes: r.bytes.length };
    },
  };

  return createUpdater({
    config: resolution,
    runtimeSupported: true,
    installed: { version: installed },
    manualDownloadOnly: true,
    source: new HttpsFeedSource(resolution.config, feedFetcher),
    downloader,
    signatureVerifier: {
      async verify(canonicalBytes, signatureBase64, signedByFingerprint) {
        const ok =
          signedByFingerprint === k.fp &&
          cryptoVerify(null, Buffer.from(canonicalBytes, "utf8"), k.pem, Buffer.from(signatureBase64, "base64"));
        return ok ? { ok: true } : { ok: false, reason: "invalid" };
      },
    },
    publisherVerifier: { async verify() { return { ok: true, publisher: PUBLISHER }; } },
    installer: { async install() { return { ok: false, message: "instalação proibida nos testes" }; } },
    cacheFs: fsMem.fs,
    scanProbe: async () => "idle",
  });
}

describe("integração updater — feed assinado e artefacto de laboratório", () => {
  const artifact = Buffer.from("MZ-laboratorio-benigno-0.3.0");

  it("deteta versão mais nova, valida assinatura e descarrega bytes verificados", async () => {
    const k = makeKeys();
    const net = fakeNetwork({
      [FEED]: { body: signedFeed(k, { artifact }) },
      [ARTIFACT_URL]: { body: artifact },
    });
    const u = makeUpdater({ k, net });
    const c = await u.check();
    assert.equal(c.ok, true, JSON.stringify(c.snapshot?.error));
    const d = await u.download();
    assert.equal(d.ok, true, JSON.stringify(d.snapshot?.error));
  });

  it("recusa versão igual ou antiga (proteção contra downgrade)", async () => {
    const k = makeKeys();
    // Igual: "upToDate", nunca "available". Anterior: falha explícita "downgrade".
    const same = makeUpdater({ k, net: fakeNetwork({ [FEED]: { body: signedFeed(k, { version: "0.2.0", artifact }) } }) });
    const sameRes = await same.check();
    assert.equal(sameRes.snapshot.phase, "upToDate");
    assert.equal(sameRes.snapshot.latest, undefined);
    const older = makeUpdater({ k, net: fakeNetwork({ [FEED]: { body: signedFeed(k, { version: "0.1.9", artifact }) } }) });
    const olderRes = await older.check();
    assert.equal(olderRes.ok, false);
    assert.equal(olderRes.error, "downgrade");
  });

  it("recusa manifesto adulterado depois de assinado", async () => {
    const k = makeKeys();
    const body = signedFeed(k, {
      artifact,
      postSignTamper: (m) => ({ ...m, notes: "Adulterado." }),
    });
    const net = fakeNetwork({ [FEED]: { body } });
    const c = await makeUpdater({ k, net }).check();
    assert.notEqual(c.ok, true);
  });

  it("recusa assinatura de outra chave (fingerprint pinado não coincide)", async () => {
    const pinned = makeKeys();
    const attacker = makeKeys();
    const net = fakeNetwork({ [FEED]: { body: signedFeed(attacker, { artifact }) } });
    const c = await makeUpdater({ k: pinned, net }).check();
    assert.notEqual(c.ok, true);
  });

  it("recusa artefacto com SHA-256 errado após download", async () => {
    const k = makeKeys();
    const net = fakeNetwork({
      [FEED]: { body: signedFeed(k, { artifact }) },
      [ARTIFACT_URL]: { body: Buffer.from("conteudo-trocado-xxxxxxxxxxxxxxxx") },
    });
    const u = makeUpdater({ k, net });
    assert.equal((await u.check()).ok, true);
    const d = await u.download();
    assert.notEqual(d.ok, true, "SHA-256 divergente não pode ser aceite");
  });

  it("recusa artefacto com tamanho diferente do manifesto", async () => {
    const k = makeKeys();
    const body = signedFeed(k, {
      artifact,
      fileOverride: { url: ARTIFACT_URL, sha256: sha256Hex(artifact), sizeBytes: artifact.length + 1 },
    });
    const net = fakeNetwork({ [FEED]: { body }, [ARTIFACT_URL]: { body: artifact } });
    const u = makeUpdater({ k, net });
    assert.equal((await u.check()).ok, true);
    const d = await u.download();
    assert.notEqual(d.ok, true, "tamanho divergente não pode ser aceite");
  });

  it("recusa URL de artefacto fora da allowlist sem pedir o domínio externo", async () => {
    const k = makeKeys();
    const evil = "https://evil.test/setup.exe";
    const body = signedFeed(k, {
      artifact,
      fileOverride: { url: evil, sha256: sha256Hex(artifact), sizeBytes: artifact.length },
    });
    const net = fakeNetwork({ [FEED]: { body } });
    const u = makeUpdater({ k, net });
    assert.equal((await u.check()).ok, true);
    const d = await u.download();
    assert.notEqual(d.ok, true);
    assert.equal(net.requested.includes(evil), false, "nenhum pedido ao domínio externo");
  });

  it("cancelamento antes do pedido não abre ligação", async () => {
    const k = makeKeys();
    const net = fakeNetwork({ [FEED]: { body: signedFeed(k, { artifact }) } });
    const u = makeUpdater({ k, net });
    await u.cancel();
    assert.equal(net.requested.length, 0);
  });
});
