import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { createUpdater } from "../src/updater/updater.ts";
import { LocalFixtureSource } from "../src/updater/sources.ts";
import { resolveUpdaterConfig } from "../src/updater/config.ts";
import { validateManifest, canonicalManifestBytes } from "../src/updater/manifest.ts";
import { createEd25519ManifestVerifier, fingerprintFromPublicKey, sha256Hex } from "../src/updater/crypto.ts";
import { validateInstallRequest, validateAutomaticInput } from "../src/updater/bridge.ts";

/**
 * TP-UPDATE-SAFETY — testes do RISCO CONCRETO identificado na revisão delimitada.
 *
 * Cobrem APENAS os riscos que se podem demonstrar SEM rede/disco real/instalador exe:
 *   R-B  scan `idle` pode mudar após o probe → fix mínimo: probe é o ÚLTIMO gate antes
 *        do `installer`; provamos a ORDEM e que `running`/`unknown`/probe-que-lança
 *        bloqueiam (0 calls) DEPOIS da revalidação de integridade/editor.
 *   R-A  identidade do ficheiro entre verificar e executar → provamos que o Updater
 *        RE-LÊ + RE-HASH no install e que o contexto entregue ao instalador leva o
 *        path + SHA (material de vínculo); o vínculo por HANDLE ao instalador real é
 *        fora de scope (adaptador bloqueado) e fica DOCUMENTADO como não-fechado.
 *   R-C  payload do IPC em RUNTIME → validadores do `bridge` com entradas adversariais.
 *
 * memoryFs (Map) só: NUNCA toca userData nem disco. Instalador é FAKE (registra ctx,
 * nunca executa exe). Nada é ligado em produção.
 */

const HOST = "updates.example.test";
const PUBLISHER = "CyberSafe, Lda.";

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, pubPem, fingerprint: fingerprintFromPublicKey(publicKey) };
}

function signedRelease(opts = {}) {
  const signer = opts.signer ?? makeKeys();
  const pins = opts.pins ?? signer;
  const bytes = opts.bytes ?? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const raw = {
    schema: "cybersafe-release/1",
    channel: "stable",
    version: opts.version ?? "0.2.0",
    publishedAt: "2026-10-17T00:00:00Z",
    notes: "Melhorias.",
    file: { url: `https://${HOST}/app/setup.exe`, sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    signature: { algorithm: "ed25519", value: "AAAA", signedByFingerprint: signer.fingerprint },
    publisher: { name: PUBLISHER },
    requiresElevation: false,
  };
  const canonical = canonicalManifestBytes(validateManifest(raw).manifest);
  raw.signature.value = Buffer.from(cryptoSign(null, Buffer.from(canonical, "utf8"), signer.privateKey)).toString("base64");
  return { raw, bytes, pins };
}

function memoryFs() {
  const files = new Map();
  return {
    files,
    ensureDir: async () => {},
    statFile: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readFile: async (p) => (files.has(p) ? files.get(p) : null),
    removePath: async (p) => { files.delete(p); },
    writeAtomic: async (destPath, tmpSuffix, data) => { files.set(destPath.replace(/\.tmp$/, tmpSuffix), data); },
  };
}

/** Harness INSTRUMENTADO: regista a ordem dos gates na fase de install. */
function instrumentedHarness({ scanState = "idle", scanThrows = false } = {}) {
  const release = signedRelease();
  const fs = memoryFs();
  const sequence = [];
  const installCalls = [];
  const config = resolveUpdaterConfig({
    channel: "stable",
    feedManifestUrl: `https://${HOST}/app/stable/latest.json`,
    originAllowlist: [HOST],
    pinnedKeyFingerprint: release.pins.fingerprint,
    expectedPublisherName: PUBLISHER,
    cacheDir: "/tmp/cybersafe-safety-unused",
    timeoutMs: 5000,
    maxDownloadBytes: 500 * 1024 * 1024,
    automaticCheckEnabled: false,
  });
  const updater = createUpdater({
    config,
    runtimeSupported: true,
    installed: { version: "0.1.0" },
    source: new LocalFixtureSource(() => ({ kind: "latest", manifest: release.raw })),
    downloader: {
      async download(url, destination, _signal, onProgress) {
        fs.files.set(destination, release.bytes);
        onProgress(release.bytes.length, undefined);
        return { path: destination, bytes: release.bytes.length };
      },
    },
    signatureVerifier: createEd25519ManifestVerifier({ publicKey: release.pins.pubPem, pinnedFingerprint: release.pins.fingerprint }),
    publisherVerifier: {
      async verify() { sequence.push("publisher"); return { ok: true, publisher: PUBLISHER }; },
    },
    installer: {
      async install(ctx) { sequence.push("install"); installCalls.push(ctx); return { ok: true }; },
    },
    cacheFs: {
      ...fs,
      readFile: async (p) => { sequence.push("readFile"); return fs.files.has(p) ? fs.files.get(p) : null; },
    },
    scanProbe: async () => {
      sequence.push("scanProbe");
      if (scanThrows) throw new Error("probe indisponível");
      return scanState;
    },
  });
  return { updater, fs, release, sequence, installCalls };
}

/** Corta o registo para capturar APENAS os gates do install(). */
function onlyInstall(sequence, upTo) {
  return sequence.slice(upTo);
}

describe("R-B — scan idle: probe é o último gate antes de executar (fix mínimo)", () => {
  it("ordem no install: readFile(SHA) -> publisher -> scanProbe -> install", async () => {
    const h = instrumentedHarness({ scanState: "idle" });
    await h.updater.check();
    await h.updater.download();
    const mark = h.sequence.length; // tudo após aqui é o install()
    const r = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(r.ok, true, r.snapshot.error?.message);

    const installSeq = onlyInstall(h.sequence, mark);
    // O probe de análise é IMEDIATAMENTE ANTES do instalador, e DEPOIS da relida e do editor.
    assert.equal(installSeq[installSeq.length - 1], "install");
    assert.equal(installSeq[installSeq.length - 2], "scanProbe", "scanProbe deve ser o último gate antes de install");
    const pubIdx = installSeq.indexOf("publisher");
    const readIdx = installSeq.indexOf("readFile");
    const scanIdx = installSeq.indexOf("scanProbe");
    assert.ok(readIdx >= 0 && pubIdx > readIdx && scanIdx > pubIdx, `esperado readFile<publisher<scanProbe, obtido ${installSeq.join(",")}`);
  });

  for (const bad of ["running", "unknown"]) {
    it(`scan ${bad} bloqueia (0 install) mesmo após relida+editor passarem`, async () => {
      const h = instrumentedHarness({ scanState: bad });
      await h.updater.check();
      await h.updater.download();
      const mark = h.sequence.length;
      const r = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
      assert.equal(r.ok, false);
      assert.equal(r.error, "installation");
      assert.equal(h.installCalls.length, 0, "instalador nunca chamado");
      const installSeq = onlyInstall(h.sequence, mark);
      assert.ok(installSeq.includes("readFile") && installSeq.includes("publisher"), "revalidação corre antes do gate de scan");
      assert.equal(installSeq[installSeq.length - 1], "scanProbe", "aborta no scan, antes de qualquer install");
    });
  }

  it("probe que LANÇA ⇒ falha fechado, 0 install", async () => {
    const h = instrumentedHarness({ scanThrows: true });
    await h.updater.check();
    await h.updater.download();
    const r = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "installation");
    assert.equal(h.installCalls.length, 0);
  });
});

describe("R-A — identidade do ficheiro entre verificar e executar", () => {
  it("troca na cache entre download e install é apanhada pela relida (0 install)", async () => {
    const h = instrumentedHarness();
    await h.updater.check();
    await h.updater.download();
    // corrompe o .exe já publicado, antes do install
    for (const [k, v] of h.fs.files) {
      if (k.endsWith(".exe")) h.fs.files.set(k, new Uint8Array(v.map((b) => b ^ 0xff)));
    }
    const r = await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "installation");
    assert.equal(h.installCalls.length, 0, "SHA revalidado no install recusa o byte trocado");
  });

  it("contexto do instalador leva path + manifest (com sha) — material p/ o instalador real vincular BYTES que executa", async () => {
    const h = instrumentedHarness();
    await h.updater.check();
    await h.updater.download();
    await h.updater.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(h.installCalls.length, 1);
    const ctx = h.installCalls[0];
    assert.equal(typeof ctx.artifactPath, "string", "path do artefacto validado");
    assert.ok(ctx.artifactPath.endsWith(".exe"), "executa o final publicado, não o .tmp");
    assert.equal(ctx.manifest.file.sha256, sha256Hex(h.release.bytes).toLowerCase(), "sha esperado entregue ao instalador");
    assert.equal(ctx.expectedVersion, "0.2.0");
    assert.equal(ctx.confirmed, true);
    assert.equal(ctx.scanState, "idle", "o idle CONFIRMADO no último gate segue para o instalador");
    // RESIDUAL documentado: o Updater entrega PATH + SHA, mas NÃO um handle/bytes ao
    // instalador. O vínculo real (abrir com no-follow + hash dos BYTES executados) é do
    // PublisherVerifier/Installer reais, que aqui estão BLOQUEADOS — corrida NÃO fechada.
  });
});

describe("R-C — validação EM RUNTIME do payload do IPC (não confiar no tipo TS)", () => {
  const badInstall = [
    null, undefined, 0, 1, "", "x", true, false, [], [{ confirmed: true }],
    {}, { confirmed: "true" }, { confirmed: 1 }, { confirmed: true },
    { confirmed: true, expectedVersion: "" }, { confirmed: true, expectedVersion: 42 },
    { confirmed: true, expectedVersion: {} }, { confirmed: true, expectedVersion: null },
    { confirmed: undefined, expectedVersion: "1.0.0" },
  ];
  for (const [i, raw] of badInstall.entries()) {
    it(`install request inválido #${i} é recusado`, () => {
      const v = validateInstallRequest(raw);
      assert.equal(v.ok, false);
      assert.equal(v.error, "installation");
    });
  }

  it("aceita APENAS { confirmed: true (boolean), expectedVersion: string não-vazio }", () => {
    const v = validateInstallRequest({ confirmed: true, expectedVersion: "1.2.3" });
    assert.equal(v.ok, true);
    assert.equal(v.value.confirmed, true);
    assert.equal(v.value.expectedVersion, "1.2.3");
  });

  it("getter malicioso em confirmed que NÃO devolve boolean true é recusado", () => {
    const weird = {};
    Object.defineProperty(weird, "confirmed", { get: () => "yes", enumerable: true });
    Object.defineProperty(weird, "expectedVersion", { get: () => "1.0.0", enumerable: true });
    assert.equal(validateInstallRequest(weird).ok, false);
  });

  const badAuto = [null, undefined, 0, 1, "", "true", "false", [], {}, () => {}];
  for (const [i, raw] of badAuto.entries()) {
    it(`flag automática inválida #${i} é recusada`, () => {
      const v = validateAutomaticInput(raw);
      assert.equal(v.ok, false);
      assert.equal(v.error, "internal");
    });
  }

  it("flag automática aceita booleans verdadeiros", () => {
    assert.deepEqual(validateAutomaticInput(true), { ok: true, value: true });
    assert.deepEqual(validateAutomaticInput(false), { ok: true, value: false });
  });
});
