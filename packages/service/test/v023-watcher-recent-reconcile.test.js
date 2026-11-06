import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reconcileRecentWatcherRoot } from "../dist/watcher-reconciliation.js";

// v0.2.3 — a reconciliação completa falhava em pastas reais (teto de 32
// ficheiros) e a lacuna ficava para sempre. O modo recente analisa só o que
// mudou desde o sinal e só confirma com o conjunto estável.
async function pastaComAntigos(n) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-v023-recon-"));
  for (let i = 0; i < n; i++) await fs.writeFile(path.join(root, `antigo-${i}.txt`), "antigo");
  await new Promise((r) => setTimeout(r, 60));
  const desde = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  return { root, desde };
}
const sinal = () => new AbortController().signal;

test("pasta grande: analisa só os ficheiros recentes e confirma", async () => {
  const { root, desde } = await pastaComAntigos(400);
  try {
    await fs.writeFile(path.join(root, "novo-1.txt"), "novo");
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "novo-2.txt"), "novo");
    const analisados = [];
    const ok = await reconcileRecentWatcherRoot(root, desde, async (f) => { analisados.push(path.basename(f)); return true; }, sinal());
    assert.equal(ok, true);
    assert.deepEqual(analisados.sort(), ["novo-1.txt", "novo-2.txt"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("análise sem veredicto não confirma", async () => {
  const { root, desde } = await pastaComAntigos(3);
  try {
    await fs.writeFile(path.join(root, "novo.txt"), "novo");
    assert.equal(await reconcileRecentWatcherRoot(root, desde, async () => false, sinal()), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ficheiro recente novo durante a revisão não confirma", async () => {
  const { root, desde } = await pastaComAntigos(3);
  try {
    await fs.writeFile(path.join(root, "novo.txt"), "novo");
    const ok = await reconcileRecentWatcherRoot(root, desde, async () => { await fs.writeFile(path.join(root, "outro.txt"), "x"); return true; }, sinal());
    assert.equal(ok, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("acima do teto de entradas não é dado como revisto", async () => {
  const { root, desde } = await pastaComAntigos(30);
  try {
    assert.equal(await reconcileRecentWatcherRoot(root, desde, async () => true, sinal(), { maxEntries: 10 }), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("pasta sem alterações recentes confirma sem analisar nada", async () => {
  const { root, desde } = await pastaComAntigos(5);
  try {
    let n = 0;
    assert.equal(await reconcileRecentWatcherRoot(root, desde, async () => { n++; return true; }, sinal()), true);
    assert.equal(n, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("pasta inexistente não é dada como revista", async () => {
  assert.equal(await reconcileRecentWatcherRoot(path.join(os.tmpdir(), "nao-existe-cs-v023"), 0, async () => true, sinal()), false);
});
