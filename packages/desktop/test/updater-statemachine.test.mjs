import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { createUpdater } from "../src/updater/updater.ts";
import { LocalFixtureSource } from "../src/updater/sources.ts";
import { resolveUpdaterConfig } from "../src/updater/config.ts";
import { validateManifest, canonicalManifestBytes } from "../src/updater/manifest.ts";
import { createEd25519ManifestVerifier, fingerprintFromPublicKey, sha256Hex } from "../src/updater/crypto.ts";
import { SourceError } from "../src/updater/types.ts";

/**
 * TP-UPDATE-01 — máquina de estados com ADAPTADORES INJETADOS. Nenhum teste
 * corre rede, instalador ou fs reais. O verificador de assinatura é o REAL
 * (node:crypto) com chaves EFÉMERAS, para provar que o portão de autenticidade
 * funciona de facto; o resto são fakes determinísticos.
 */

const HOST = "updates.example.test";
const PUBLISHER = "CyberSafe, Lda.";

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, pubPem, fingerprint: fingerprintFromPublicKey(publicKey) };
}

/** Manifesto assinado por `signer`, mas PINADO como `pins` (permite forjar mismatch). */
function signedRelease(opts = {}) {
  const signer = opts.signer ?? makeKeys();
  const pins = opts.pins ?? signer;
  const bytes = opts.bytes ?? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const sha = sha256Hex(bytes);
  const raw = {
    schema: "cybersafe-release/1",
    channel: "stable",
    version: opts.version ?? "0.2.0",
    publishedAt: "2026-10-17T00:00:00Z",
    notes: "Melhorias.",
    file: { url: opts.url ?? `https://${HOST}/app/setup.exe`, sha256: sha, sizeBytes: bytes.length },
    signature: { algorithm: "ed25519", value: "AAAA", signedByFingerprint: signer.fingerprint },
    publisher: { name: opts.publisherName ?? PUBLISHER },
    requiresElevation: opts.requiresElevation ?? false,
  };
  const canonical = canonicalManifestBytes(validateManifest(raw).manifest);
  raw.signature.value = Buffer.from(cryptoSign(null, Buffer.from(canonical, "utf8"), signer.privateKey)).toString("base64");
  return { raw, bytes, sha, signer, pins };
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

function okDownloader(files, behavior = {}, calls) {
  return {
    async download(url, destination, signal, onProgress) {
      if (calls) calls.push(url);
      if (behavior.hang) {
        await new Promise((_res, rej) => {
          signal.addEventListener("abort", () => rej(new Error("abort")));
        });
      }
      const payload = behavior.tamperedBytes ? new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]) : behavior.bytes;
      files.set(destination, payload);
      onProgress(payload.length, undefined);
      return { path: destination, bytes: payload.length };
    },
  };
}

function baseConfig(over = {}) {
  return {
    channel: "stable",
    feedManifestUrl: `https://${HOST}/app/stable/latest.json`,
    originAllowlist: [HOST],
    pinnedKeyFingerprint: over.pinnedKeyFingerprint,
    expectedPublisherName: over.expectedPublisherName ?? PUBLISHER,
    cacheDir: "/tmp/cybersafe-updater-cache",
    timeoutMs: over.timeoutMs ?? 5000,
    maxDownloadBytes: 500 * 1024 * 1024,
    automaticCheckEnabled: over.automaticCheckEnabled ?? false,
  };
}

function dummyDeps(config) {
  const fs = memoryFs();
  const k = makeKeys();
  return {
    config,
    runtimeSupported: true,
    installed: { version: "0.1.0" },
    downloader: okDownloader(fs.files, { bytes: new Uint8Array([1]) }),
    signatureVerifier: createEd25519ManifestVerifier({ publicKey: k.pubPem, pinnedFingerprint: k.fingerprint }),
    publisherVerifier: { async verify() { return { ok: true }; } },
    installer: { async install() { return { ok: true }; } },
    cacheFs: fs,
    scanProbe: async () => "idle",
    source: { fetchLatest: async () => ({ kind: "none" }) },
  };
}

function buildHarness({
  release,
  manualDownloadOnly = false,
  installedVersion = "0.1.0",
  runtimeSupported = true,
  scanState = "idle",
  publisherOk = true,
  downloadBehavior = {},
  automaticCheckEnabled = false,
  timeoutMs,
} = {}) {
  const fs = memoryFs();
  const downloadCalls = [];
  const config = resolveUpdaterConfig(
    baseConfig({
      pinnedKeyFingerprint: release ? release.pins.fingerprint : "ABCD",
      automaticCheckEnabled,
      timeoutMs,
    }),
  );
  const signatureVerifier = createEd25519ManifestVerifier(
    release
      ? { publicKey: release.pins.pubPem, pinnedFingerprint: release.pins.fingerprint }
      : { publicKey: makeKeys().pubPem, pinnedFingerprint: "ABCD" },
  );
  const installCalls = [];
  const updater = createUpdater({
    config,
    runtimeSupported,
    manualDownloadOnly,
    installed: { version: installedVersion },
    source: release ? new LocalFixtureSource(() => ({ kind: "latest", manifest: release.raw })) : new LocalFixtureSource(() => ({ kind: "none" })),
    downloader: okDownloader(fs.files, { bytes: release ? release.bytes : new Uint8Array([1]), ...downloadBehavior }, downloadCalls),
    signatureVerifier,
    publisherVerifier: { async verify() { return publisherOk ? { ok: true, publisher: PUBLISHER } : { ok: false, reason: "publisher-mismatch" }; } },
    installer: { async install(ctx) { installCalls.push(ctx); return { ok: true }; } },
    cacheFs: fs,
    scanProbe: async () => scanState,
  });
  return { updater, fs, installCalls, downloadCalls };
}

describe("updater — fail-closed de arranque", () => {
  it("unconfigured quando falta a chave pinada (nada avança)", async () => {
    const badConfig = resolveUpdaterConfig(baseConfig({ pinnedKeyFingerprint: "" }));
    assert.equal(badConfig.ok, false);
    const updater = createUpdater({ ...dummyDeps(badConfig), runtimeSupported: true, installed: { version: "0.1.0" } });
    assert.equal(updater.snapshotCopy().phase, "unconfigured");
    const r = await updater.check();
    assert.equal(r.ok, false);
    assert.equal(r.error, "unconfigured");
  });

  it("unsupported em runtime portable/dev", async () => {
    const release = signedRelease();
    const h = buildHarness({ release, runtimeSupported: false });
    assert.equal(h.updater.snapshotCopy().phase, "unsupported");
    const r = await h.updater.check();
    assert.equal(r.ok, false);
    assert.equal(r.error, "unsupported");
  });
});

describe("updater — happy path com consentimento real", () => {
  it("check→available→download→verify ok→canInstall; install exige scan active", async () => {
    const release = signedRelease();
    const h = buildHarness({ release });

    const c = await h.updater.check();
    assert.equal(c.ok, true);
    assert.equal(c.snapshot.phase, "available");
    assert.equal(c.snapshot.canInstall, false);

    const d = await h.updater.download();
    assert.equal(d.ok, true, d.snapshot.error?.message);
    assert.equal(d.snapshot.phase, "downloaded");
    assert.equal(d.snapshot.canInstall, true);
    assert.equal(d.snapshot.progress.downloadedBytes, release.bytes.length);
    assert.equal(d.snapshot.progress.totalBytes, release.bytes.length);

    const i = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(i.ok, true);
    assert.equal(i.snapshot.phase, "installing");
    assert.equal(h.installCalls.length, 1);
    assert.equal(h.installCalls[0].confirmed, true);
  });

  it("sem update (none) fica upToDate; versão igual NÃO é update", async () => {
    const none = buildHarness({ release: null });
    const rn = await none.updater.check();
    assert.equal(rn.snapshot.phase, "upToDate");

    const same = buildHarness({ release: signedRelease({ version: "0.1.0" }), installedVersion: "0.1.0" });
    const rs = await same.updater.check();
    assert.equal(rs.ok, true);
    assert.equal(rs.snapshot.phase, "upToDate");
  });

  it("rejeita downgrade", async () => {
    const release = signedRelease({ version: "0.0.5" });
    const h = buildHarness({ release, installedVersion: "0.1.0" });
    const r = await h.updater.check();
    assert.equal(r.ok, false);
    assert.equal(r.error, "downgrade");
  });
});

describe("updater — portões de segurança e ataques", () => {
  it("assinatura inválida no check: 0 downloads e notes NÃO promovidas", async () => {
    const attacker = makeKeys();
    const legit = makeKeys();
    const rel = signedRelease({ signer: attacker, pins: legit }); // config pinará legit; assinou o attacker
    const h = buildHarness({ release: rel });
    const c = await h.updater.check();
    assert.equal(c.ok, false);
    assert.equal(c.error, "untrusted-metadata");
    assert.equal(c.snapshot.phase, "error");
    assert.equal(c.snapshot.latest, undefined, "notas de upstream não autenticadas não são mostradas");
    assert.equal(h.downloadCalls.length, 0, "manifesto não autenticado ⇒ nada é descarregado");
    const d = await h.updater.download();
    assert.equal(d.ok, false);
    assert.equal(h.downloadCalls.length, 0);
  });

  it("SHA-256 do ficheiro não bate → integrity e canInstall=false", async () => {
    const release = signedRelease();
    const h = buildHarness({ release, downloadBehavior: { tamperedBytes: true } });
    await h.updater.check();
    const d = await h.updater.download();
    assert.equal(d.ok, false);
    assert.equal(d.error, "integrity");
    assert.equal(d.snapshot.canInstall, false);
  });

  it("editor (publisher) não verificado bloqueia antes de canInstall", async () => {
    const release = signedRelease();
    const h = buildHarness({ release, publisherOk: false });
    await h.updater.check();
    const d = await h.updater.download();
    assert.equal(d.ok, false);
    assert.equal(d.error, "publisher");
  });

  for (const scanState of ["running", "unknown"]) {
    it(`análise ${scanState} bloqueia instalação (instalador nunca chamado)`, async () => {
      const release = signedRelease();
      const h = buildHarness({ release, scanState });
      await h.updater.check();
      await h.updater.download();
      const i = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
      assert.equal(i.ok, false);
      assert.equal(i.error, "installation");
      assert.equal(h.installCalls.length, 0);
    });
  }

  it("expectedVersion trocada bloqueia", async () => {
    const release = signedRelease();
    const h = buildHarness({ release });
    await h.updater.check();
    await h.updater.download();
    const i = await h.updater.install({ confirmed: true, expectedVersion: "9.9.9" });
    assert.equal(i.ok, false);
    assert.equal(h.installCalls.length, 0);
  });

  it("URL do artefacto fora da allowlist é rejeitado no download", async () => {
    const release = signedRelease({ url: "https://evil.test/x.exe" });
    const h = buildHarness({ release });
    await h.updater.check();
    const d = await h.updater.download();
    assert.equal(d.ok, false);
    assert.equal(d.error, "untrusted-metadata");
  });

  it("cache adulterada DEPOIS do download → install revalida SHA e bloqueia (0 calls)", async () => {
    const release = signedRelease();
    const h = buildHarness({ release });
    await h.updater.check();
    const d = await h.updater.download();
    assert.equal(d.ok, true, d.snapshot.error?.message);
    // corrompe o .exe já em cache, entre o download e o instalar
    for (const [k, v] of h.fs.files) {
      if (k.endsWith(".exe")) h.fs.files.set(k, new Uint8Array(v.map((b) => b ^ 0xff)));
    }
    const i = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(i.ok, false);
    assert.equal(i.error, "installation");
    assert.equal(h.installCalls.length, 0);
  });

  it("publisher é RE-verificado imediatamente antes do install (falha aqui ⇒ 0 calls)", async () => {
    const release = signedRelease();
    const fs = memoryFs();
    let pubCalls = 0;
    const updater = createUpdater({
      ...dummyDeps(resolveUpdaterConfig(baseConfig({ pinnedKeyFingerprint: release.pins.fingerprint }))),
      source: new LocalFixtureSource(() => ({ kind: "latest", manifest: release.raw })),
      downloader: okDownloader(fs.files, { bytes: release.bytes }),
      signatureVerifier: createEd25519ManifestVerifier({ publicKey: release.pins.pubPem, pinnedFingerprint: release.pins.fingerprint }),
      publisherVerifier: {
        async verify() { pubCalls += 1; return pubCalls === 1 ? { ok: true } : { ok: false, reason: "cert revogado" }; },
      },
      cacheFs: fs,
    });
    await updater.check();
    await updater.download(); // 1ª verificação (no download) passou
    const i = await updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(i.ok, false);
    assert.equal(i.error, "publisher");
    assert.ok(pubCalls >= 2, "o editor tem de ser re-verificado no install, não só no download");
  });

  it("offline e timeout do feed têm códigos distintos", async () => {
    const offline = createUpdater({
      ...dummyDeps(resolveUpdaterConfig(baseConfig({ pinnedKeyFingerprint: "ABCD" }))),
      source: { fetchLatest: async () => { throw new SourceError("offline", "sem rede"); } },
    });
    const ro = await offline.check();
    assert.equal(ro.ok, false);
    assert.equal(ro.error, "offline");

    const slow = createUpdater({
      ...dummyDeps(resolveUpdaterConfig(baseConfig({ pinnedKeyFingerprint: "ABCD", timeoutMs: 5 }))),
      source: { fetchLatest: (signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("abort")))) },
    });
    const rt = await slow.check();
    assert.equal(rt.ok, false);
    assert.equal(rt.error, "timeout");
  });

  it("cancelar a meio do download → cancelled", async () => {
    const release = signedRelease();
    const fs = memoryFs();
    const updater = createUpdater({
      ...dummyDeps(resolveUpdaterConfig(baseConfig({ pinnedKeyFingerprint: release.pins.fingerprint }))),
      source: new LocalFixtureSource(() => ({ kind: "latest", manifest: release.raw })),
      downloader: { download(_u, _d, signal) { return new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("abort")))); } },
      signatureVerifier: createEd25519ManifestVerifier({ publicKey: release.pins.pubPem, pinnedFingerprint: release.pins.fingerprint }),
      cacheFs: fs,
    });
    await updater.check();
    const dl = updater.download();
    // deixa o download chegar ao estado "em voo" (AbortController criado) antes de cancelar
    await new Promise((r) => setTimeout(r, 5));
    await updater.cancel();
    const r = await dl;
    assert.equal(r.ok, false);
    assert.equal(r.error, "cancelled");
  });

  it("defer aceita e deixa instalável a zero", async () => {
    const release = signedRelease();
    const h = buildHarness({ release });
    await h.updater.check();
    const d = await h.updater.defer();
    assert.equal(d.ok, true);
    assert.equal(d.snapshot.phase, "deferred");
    assert.equal(d.snapshot.canInstall, false);
  });

  it("double-install é rejeitado (busy)", async () => {
    const release = signedRelease();
    const fs = memoryFs();
    let releaseInstaller;
    const updater = createUpdater({
      ...dummyDeps(resolveUpdaterConfig(baseConfig({ pinnedKeyFingerprint: release.pins.fingerprint }))),
      source: new LocalFixtureSource(() => ({ kind: "latest", manifest: release.raw })),
      downloader: okDownloader(fs.files, { bytes: release.bytes }),
      signatureVerifier: createEd25519ManifestVerifier({ publicKey: release.pins.pubPem, pinnedFingerprint: release.pins.fingerprint }),
      installer: { install: () => new Promise((res) => { releaseInstaller = res; }) },
      cacheFs: fs,
    });
    await updater.check();
    await updater.download();
    const first = updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    // deixa a 1ª instalação chegar ao instalador (pendurado) antes de tentar a 2ª
    await new Promise((r) => setTimeout(r, 5));
    const second = await updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(second.ok, false);
    assert.equal(second.error, "busy");
    await releaseInstaller ? releaseInstaller({ ok: true }) : null;
    await first;
  });

  it("check concorrente durante download devolve busy", async () => {
    const release = signedRelease();
    const fs = memoryFs();
    const updater = createUpdater({
      ...dummyDeps(resolveUpdaterConfig(baseConfig({ pinnedKeyFingerprint: release.pins.fingerprint, timeoutMs: 40 }))),
      source: new LocalFixtureSource(() => ({ kind: "latest", manifest: release.raw })),
      downloader: { download(_u, _d, signal) { return new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("abort")))); } },
      signatureVerifier: createEd25519ManifestVerifier({ publicKey: release.pins.pubPem, pinnedFingerprint: release.pins.fingerprint }),
      cacheFs: fs,
    });
    await updater.check();
    const dl = updater.download();
    const concurrent = await updater.check();
    assert.equal(concurrent.ok, false);
    assert.equal(concurrent.error, "busy");
    // P0(4): o "busy" NÃO pode degradar a fase da operação legítima em curso.
    assert.notEqual(concurrent.snapshot.phase, "error", "busy não deve mutar a fase da op em curso");
    await updater.cancel();
    await dl;
  });
});

describe("updater — preferência não auto-dispara; listeners", () => {
  it("automaticCheck arranca OFF e setAutomaticCheck(true) NÃO faz check", async () => {
    const release = signedRelease();
    const h = buildHarness({ release });
    assert.equal(h.updater.snapshotCopy().automaticCheckEnabled, false);
    const r = await h.updater.setAutomaticCheck(true);
    assert.equal(r.ok, true);
    assert.equal(r.snapshot.automaticCheckEnabled, true);
    assert.equal(r.snapshot.phase, "idle", "não dispara check sozinho");
    assert.equal(r.snapshot.latest, undefined);
  });

  it("onState emite e unsubscribe para de emitir", () => {
    const release = signedRelease();
    const h = buildHarness({ release });
    let seen = 0;
    const off = h.updater.onState(() => { seen += 1; });
    h.updater.setAutomaticCheck(true);
    const afterFirst = seen;
    off();
    h.updater.setAutomaticCheck(false);
    assert.ok(afterFirst >= 1, "emitiu ao menos uma vez");
    assert.equal(seen, afterFirst, "listener removido não volta a receber");
  });
});

it('authenticates metadata even when the offered version equals the installed version', async () => {
  const release = signedRelease({ version: '0.1.0', pins: makeKeys() });
  const { updater } = buildHarness({ release });
  const result = await updater.check();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'untrusted-metadata');
});

it('manual policy verifies bytes, reveals only a folder and never executes', async () => {
  const release = signedRelease();
  const h = buildHarness({ release, manualDownloadOnly: true, publisherOk: false });
  assert.equal((await h.updater.check()).ok, true);
  assert.equal((await h.updater.download()).ok, true);
  assert.equal(h.updater.snapshotCopy().canInstall, false);
  const paths=[];
  assert.equal((await h.updater.revealVerifiedDownload(p=>paths.push(p))).ok,true);
  assert.equal(paths.length,1);
  assert.equal((await h.updater.install({confirmed:true, expectedVersion:release.raw.version})).ok,false);
  assert.equal(h.installCalls.length,0);
});
