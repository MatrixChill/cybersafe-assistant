import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import {
  TransportError,
  createHttpsFeedFetcher,
  createHttpsArtifactDownloader,
  nodeFileSink,
} from "../src/updater/node-transport.ts";

/**
 * TP-UPDATE-ADAPTERS (item 1) — transporte HTTPS REAL, testado SEM REDE.
 *
 * O `HttpStreamOpener` é uma costura: aqui é um FAKE que devolve status/headers/streams
 * CONTROLADOS. Nada toca a rede. Provar por seam: single-hop (redirects recusados),
 * scheme/credenciais, allowlist por salto, cap de metadata, cap de bytes DURANTE o
 * stream, Content-Length/truncamento, aborto via signal, progresso de bytes reais, e
 * que qualquer falha NÃO deixa commit nem progresso falso (sink descartado).
 */

/** Config mínimo para os adaptadores (só usam originAllowlist + maxDownloadBytes). */
function cfg(overrides = {}) {
  return {
    channel: "stable",
    feedManifestUrl: "https://feed.example.test/manifest.json",
    originAllowlist: ["feed.example.test", "cdn.example.test"],
    pinnedKeyFingerprint: "fp",
    expectedPublisherName: "CyberSafe",
    cacheDir: path.join(os.tmpdir(), "cs-adapter-unused"),
    timeoutMs: 5000,
    maxDownloadBytes: 4096,
    automaticCheckEnabled: false,
    ...overrides,
  };
}

/** Abre um AsyncIterable de Uint8Array a partir de chunks. */
async function* asStream(chunks) {
  for (const c of chunks) yield c;
}

/** Opener fake: devolve a resposta dada; regista abortos; propaga `signal` ao corpo. */
function fakeOpener(res) {
  const state = { aborted: false, openCount: 0 };
  const opener = {
    async open(url, signal) {
      state.openCount += 1;
      state.lastUrl = url;
      const body = res.bodyFactory ? res.bodyFactory(signal) : asStream(res.chunks ?? []);
      return {
        status: res.status ?? 200,
        headers: res.headers ?? {},
        body,
        abort() {
          state.aborted = true;
        },
      };
    },
  };
  return { opener, state };
}

function isTransport(err, kind) {
  return err instanceof TransportError && err.kind === kind;
}

describe("createHttpsFeedFetcher (single-hop, caps, guards)", () => {
  it("devolve 200 + corpo lido (sem rede)", async () => {
    const body = Buffer.from(JSON.stringify({ ok: 1 }));
    const { opener } = fakeOpener({ status: 200, chunks: [body] });
    const fetcher = createHttpsFeedFetcher(cfg(), opener);
    const res = await fetcher.fetch("https://feed.example.test/manifest.json", new AbortController().signal);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.bodyText), { ok: 1 });
  });

  it("REJEITA redirect 3xx (não segue Location)", async () => {
    const { opener, state } = fakeOpener({ status: 302, headers: { location: "http://evil.test/x" }, chunks: [Buffer.from("nope")] });
    const fetcher = createHttpsFeedFetcher(cfg(), opener);
    await assert.rejects(
      () => fetcher.fetch("https://feed.example.test/m.json", new AbortController().signal),
      (e) => isTransport(e, "redirect"),
    );
    assert.equal(state.aborted, true, "corpo do redirect deve ser destruído");
  });

  it("REJEITA http (só HTTPS) antes de abrir", async () => {
    const { opener, state } = fakeOpener({ status: 200, chunks: [] });
    const fetcher = createHttpsFeedFetcher(cfg(), opener);
    await assert.rejects(
      () => fetcher.fetch("http://feed.example.test/m.json", new AbortController().signal),
      (e) => isTransport(e, "scheme"),
    );
    assert.equal(state.openCount, 0, "nem deve abrir pedido");
  });

  it("REJEITA URL com credenciais", async () => {
    const { opener, state } = fakeOpener({ status: 200, chunks: [] });
    const fetcher = createHttpsFeedFetcher(cfg(), opener);
    await assert.rejects(
      () => fetcher.fetch("https://u:p@feed.example.test/m.json", new AbortController().signal),
      (e) => isTransport(e, "credentials"),
    );
    assert.equal(state.openCount, 0);
  });

  it("REJEITA origem fora da allowlist no momento do pedido", async () => {
    const { opener, state } = fakeOpener({ status: 200, chunks: [] });
    const fetcher = createHttpsFeedFetcher(cfg(), opener);
    await assert.rejects(
      () => fetcher.fetch("https://evil.example.test/m.json", new AbortController().signal),
      (e) => isTransport(e, "scheme"),
    );
    assert.equal(state.openCount, 0);
  });

  it("CORPO DE METADATA acima do limite ⇒ falha (sem parse parcial)", async () => {
    const big = Buffer.alloc(1024, 0x61); // 1 KiB
    const { opener } = fakeOpener({ status: 200, chunks: [big, big, big, big] }); // 4 KiB
    const fetcher = createHttpsFeedFetcher(cfg(), opener, { maxMetadataBytes: 2048 });
    await assert.rejects(
      () => fetcher.fetch("https://feed.example.test/m.json", new AbortController().signal),
      (e) => isTransport(e, "limit"),
    );
  });

  it("aborto ANTES de abrir ⇒ TransportError aborted", async () => {
    const { opener } = fakeOpener({ status: 200, chunks: [Buffer.from("{}")] });
    const fetcher = createHttpsFeedFetcher(cfg(), opener);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => fetcher.fetch("https://feed.example.test/m.json", ac.signal),
      (e) => isTransport(e, "aborted"),
    );
  });
});

/** Sink de memória para asserts de escrita/descarte sem disco. */
function memorySink() {
  const s = { chunks: [], closed: false, discarded: false };
  s.factory = async () => ({
    async write(c) {
      if (s.discarded) throw new Error("write após discard");
      s.chunks.push(Buffer.from(c));
    },
    async close() {
      s.closed = true;
    },
    async discard() {
      s.discarded = true;
    },
  });
  return s;
}

describe("createHttpsArtifactDownloader (stream, caps, truncamento, aborto)", () => {
  it("feliz: escreve todos os bytes, progresso cumulativo, retorna bytes", async () => {
    const a = Buffer.from("AAAA");
    const b = Buffer.from("BBBBB");
    const cl = String(a.length + b.length);
    const { opener } = fakeOpener({ status: 200, headers: { "content-length": cl }, chunks: [a, b] });
    const mem = memorySink();
    const dl = createHttpsArtifactDownloader(cfg({ maxDownloadBytes: 100 }), opener, { sinkFactory: mem.factory });
    const progress = [];
    const out = await dl.download("https://cdn.example.test/x.exe", "/dest.tmp", new AbortController().signal, (bytes, total) => progress.push([bytes, total]));
    assert.equal(out.path, "/dest.tmp");
    assert.equal(out.bytes, 9);
    assert.equal(Buffer.concat(mem.chunks).toString(), "AAAABBBBB");
    assert.equal(mem.closed, true);
    assert.deepEqual(progress, [
      [4, 9],
      [9, 9],
    ]);
  });

  it("Content-Length acima do limite ⇒ recusa ANTES de abrir sink", async () => {
    const { opener } = fakeOpener({ status: 200, headers: { "content-length": "999999" }, chunks: [] });
    const mem = memorySink();
    const dl = createHttpsArtifactDownloader(cfg({ maxDownloadBytes: 4096 }), opener, { sinkFactory: mem.factory });
    await assert.rejects(
      () => dl.download("https://cdn.example.test/x.exe", "/d.tmp", new AbortController().signal, () => {}),
      (e) => isTransport(e, "limit"),
    );
    assert.equal(mem.chunks.length, 0, "nada escrito");
  });

  it("excesso DURANTE o stream (sem Content-Length) ⇒ cap a meio, sink descartado, sem commit", async () => {
    // 3 chunks de 2 KiB = 6 KiB > cap 4 KiB, sem content-length (chega ao fim sem saber).
    const chunk = Buffer.alloc(2048, 0x61);
    const { opener } = fakeOpener({ status: 200, chunks: [chunk, chunk, chunk] });
    const mem = memorySink();
    const dl = createHttpsArtifactDownloader(cfg({ maxDownloadBytes: 4096 }), opener, { sinkFactory: mem.factory });
    await assert.rejects(
      () => dl.download("https://cdn.example.test/x.exe", "/d.tmp", new AbortController().signal, () => {}),
      (e) => isTransport(e, "limit"),
    );
    assert.equal(mem.discarded, true, "parcial descartado (sem progresso/commit falso)");
    assert.equal(mem.closed, false);
  });

  it("TRUNCAMENTO: stream acaba cedo face ao Content-Length ⇒ falha e descarta", async () => {
    const { opener } = fakeOpener({ status: 200, headers: { "content-length": "10" }, chunks: [Buffer.from("abc")] });
    const mem = memorySink();
    const dl = createHttpsArtifactDownloader(cfg(), opener, { sinkFactory: mem.factory });
    await assert.rejects(
      () => dl.download("https://cdn.example.test/x.exe", "/d.tmp", new AbortController().signal, () => {}),
      (e) => isTransport(e, "truncated"),
    );
    assert.equal(mem.discarded, true);
    assert.equal(mem.closed, false);
  });

  it("aborto DURANTE o stream ⇒ falha e descarta parcial", async () => {
    const ac = new AbortController();
    const { opener } = fakeOpener({
      status: 200,
      bodyFactory: async function* (_signal) {
        yield Buffer.from("1234");
        ac.abort(); // utilizador cancela a meio
        // O próximo ciclo vê signal.aborted e lança.
        yield Buffer.from("5678");
      },
    });
    const mem = memorySink();
    const dl = createHttpsArtifactDownloader(cfg(), opener, { sinkFactory: mem.factory });
    await assert.rejects(
      () => dl.download("https://cdn.example.test/x.exe", "/d.tmp", ac.signal, () => {}),
      (e) => isTransport(e, "aborted"),
    );
    assert.equal(mem.discarded, true);
  });

  it("estado não-2xx (500) ⇒ falha de status", async () => {
    const { opener } = fakeOpener({ status: 500, chunks: [Buffer.from("err")] });
    const dl = createHttpsArtifactDownloader(cfg(), opener, { sinkFactory: memorySink().factory });
    await assert.rejects(
      () => dl.download("https://cdn.example.test/x.exe", "/d.tmp", new AbortController().signal, () => {}),
      (e) => isTransport(e, "status"),
    );
  });

  it("artefacto VAZIO (0 bytes) ⇒ falha truncado (não se publica ficheiro vazio)", async () => {
    const { opener } = fakeOpener({ status: 200, chunks: [] });
    const dl = createHttpsArtifactDownloader(cfg(), opener, { sinkFactory: memorySink().factory });
    await assert.rejects(
      () => dl.download("https://cdn.example.test/x.exe", "/d.tmp", new AbortController().signal, () => {}),
      (e) => isTransport(e, "truncated"),
    );
  });

  it("URL fora da allowlist ⇒ recusa ANTES de abrir", async () => {
    const { opener, state } = fakeOpener({ status: 200, chunks: [] });
    const dl = createHttpsArtifactDownloader(cfg(), opener, { sinkFactory: memorySink().factory });
    await assert.rejects(
      () => dl.download("https://evil.example.test/x.exe", "/d.tmp", new AbortController().signal, () => {}),
      (e) => isTransport(e, "scheme"),
    );
    assert.equal(state.openCount, 0);
  });

  it("SINK REAL (nodeFileSink): escreve fsync+rename e remove parcial em truncamento", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-dl-"));
    try {
      const dest = path.join(dir, "artifact.tmp");
      const { opener } = fakeOpener({ status: 200, headers: { "content-length": "8" }, chunks: [Buffer.from("1234")] });
      const dl = createHttpsArtifactDownloader(cfg(), opener, { sinkFactory: nodeFileSink });
      await assert.rejects(
        () => dl.download("https://cdn.example.test/x.exe", dest, new AbortController().signal, () => {}),
        (e) => isTransport(e, "truncated"),
      );
      assert.equal(fs.existsSync(dest), false, "parcial NÃO fica no disco (sem commit falso)");

      // Sucesso real: bytes no destino.
      const ok = fakeOpener({ status: 200, headers: { "content-length": "4" }, chunks: [Buffer.from("abcd")] });
      const dl2 = createHttpsArtifactDownloader(cfg(), ok.opener, { sinkFactory: nodeFileSink });
      const out = await dl2.download("https://cdn.example.test/x.exe", dest, new AbortController().signal, () => {});
      assert.equal(out.bytes, 4);
      assert.equal(fs.readFileSync(dest).toString(), "abcd");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
