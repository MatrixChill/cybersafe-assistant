// Lote ClamAV do tempo real: um clamscan para o ficheiro atual e os que estão
// à espera; reutilização só para a MESMA versão admitida, recente e sem erro.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtectionEngineService } from "../dist/engine.js";
import { RealtimeFileQueue } from "../dist/realtime-file-queue.js";

test("peekPending devolve a ordem de execução sem alterar a fila", () => {
  const q = new RealtimeFileQueue(64);
  let release;
  q.enqueue("a", "1", () => new Promise((r) => { release = r; }));        // a corre já
  q.enqueue("b", "1", async () => {});
  q.enqueue("c", "1", async () => {}, "high");
  assert.deepEqual(q.peekPending(10), ["c", "b"]);
  assert.deepEqual(q.peekPending(1), ["c"]);
  assert.equal(q.size, 2);
  release();
});

async function withEngine(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cs-rt-batch-"));
  const engine = new ProtectionEngineService(dir);
  try { await fn(engine); } finally { await engine.dispose?.().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
}

test("um job com outros à espera faz UM scanFiles para todos, com prioridade realtime", async () => {
  await withEngine(async (engine) => {
    const calls = [];
    engine.clamav.scanFiles = async (files, opts) => {
      calls.push({ files, opts });
      return { files: files.map((file) => ({ file, verdict: file.endsWith("bad") ? "infected" : "clean", signature: file.endsWith("bad") ? "Eicar" : undefined })), status: { status: "active" } };
    };
    let release;
    engine.realtimeQueue.enqueue("/x/blocker", "f0", () => new Promise((r) => { release = r; }));
    for (const [k, fp] of [["/x/b", "fb"], ["/x/bad", "fbad"]]) {
      engine.realtimeQueue.enqueue(k, fp, async () => {});
      engine.realtimeTargets.set(k, { path: k, fingerprint: fp });
    }
    const signal = new AbortController().signal;
    const own = await engine.realtimeClamavBatch("/x/a", "/x/a", "fa", signal);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].files, ["/x/a", "/x/b", "/x/bad"]);
    assert.equal(calls[0].opts.priority, "realtime");
    assert.equal(own.verdict, "clean");
    // Os pares reutilizam o veredicto só com a mesma impressão digital.
    assert.equal(engine.takeRealtimeClamav("/x/bad", "fbad").verdict, "infected");
    assert.equal(engine.takeRealtimeClamav("/x/bad", "fbad"), undefined, "consumido uma vez");
    assert.equal(engine.takeRealtimeClamav("/x/b", "OUTRA-VERSAO"), undefined, "versão diferente não reutiliza");
    release();
  });
});

test("sem outros à espera não há lote; erro do lote e resultado antigo não são reutilizados", async () => {
  await withEngine(async (engine) => {
    let calls = 0;
    engine.clamav.scanFiles = async (files) => { calls++; return { files: files.map((file) => ({ file, verdict: "error", reason: "x" })), status: { status: "degraded" } }; };
    const signal = new AbortController().signal;
    assert.equal(await engine.realtimeClamavBatch("/x/a", "/x/a", "fa", signal), undefined);
    assert.equal(calls, 0, "ficheiro único usa o caminho individual de sempre");
    let release;
    engine.realtimeQueue.enqueue("/x/blocker", "f0", () => new Promise((r) => { release = r; }));
    engine.realtimeQueue.enqueue("/x/b", "fb", async () => {});
    engine.realtimeTargets.set("/x/b", { path: "/x/b", fingerprint: "fb" });
    assert.equal(await engine.realtimeClamavBatch("/x/a", "/x/a", "fa", signal), undefined, "erro → caminho individual");
    assert.equal(engine.takeRealtimeClamav("/x/b", "fb"), undefined, "erro do lote não é veredicto");
    engine.realtimeClamavCache.set("/x/c", { fingerprint: "fc", outcome: { file: "/x/c", verdict: "clean" }, at: Date.now() - 10 * 60_000 });
    assert.equal(engine.takeRealtimeClamav("/x/c", "fc"), undefined, "resultado antigo expira");
    release();
  });
});
