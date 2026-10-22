// RECOVERY-SECURITY 2026-10-14 — OpenCode
// Prova REAL (watcher filho chokidar) de dois comportamentos que a revisao tem de
// conhecer:
//   1. awaitWriteFinish (stabilityThreshold 3000 / pollInterval 2000) segura os
//      eventos enquanto o ficheiro esta a ser escrito (ex.: download em curso);
//   2. um RENAME no filesystem NAO gera um evento de rename: gera add(novo) +
//      unlink(antigo). O "file.renamed" so existe um nivel acima, onde
//      NativeWindowsWatcher mapeia `unlink` -> `file.renamed` (index.ts:202).
// Temp benigno; sem registry; sem paths pessoais.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { IsolatedFileWatcher } from "../dist/watcher-process.js";

function wait(emitter, event, ms) {
  return once(emitter, event, { signal: AbortSignal.timeout(ms) });
}

// Aguarda uma condicao sem fazer polling de fonte de verdade: apenas observa o
// array de eventos ja recebidos. Devolve quando a condicao for verdadeira.
async function waitUntil(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-recovery-"));
  const watcher = new IsolatedFileWatcher();
  t.after(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, watcher };
}

test("recovery: awaitWriteFinish segura o evento enquanto o ficheiro e escrito", { timeout: 40000 }, async (t) => {
  const { dir, watcher } = await fixture(t);
  const file = path.join(dir, "download.bin");
  let added = false;
  watcher.on("add", (p) => { if (p === file) added = true; });

  const ready = wait(watcher, "ready", 12000);
  await watcher.start([dir]);
  await ready;

  // Simula um download: escreve de ~900ms em ~900ms (abaixo do threshold de 3000ms).
  for (let i = 0; i < 4; i++) {
    await fs.appendFile(file, `chunk-${i}`);
    await new Promise((r) => setTimeout(r, 900));
  }

  assert.equal(added, false, "nenhum add enquanto o ficheiro continua a mudar (nao estavel)");

  const ok = await waitUntil(() => added, 15000);
  assert.equal(ok, true, "add tem de chegar depois de o ficheiro estabilizar");
});

test("recovery: rename no filesystem = add(novo) + unlink(antigo), nunca evento de rename", { timeout: 40000 }, async (t) => {
  const { dir, watcher } = await fixture(t);
  const events = [];
  watcher.on("add", (p) => events.push(["add", p]));
  watcher.on("change", (p) => events.push(["change", p]));
  watcher.on("unlink", (p) => events.push(["unlink", p]));
  // O watcher filho so emite estes tres; qualquer "renamed" seria fuga de contrato.
  watcher.on("renamed", (p) => events.push(["renamed", p]));

  const ready = wait(watcher, "ready", 12000);
  await watcher.start([dir]);
  await ready;

  const from = path.join(dir, "a.txt");
  const to = path.join(dir, "b.txt");

  const addedA = wait(watcher, "add", 15000);
  await fs.writeFile(from, "conteudo");
  assert.equal((await addedA)[0], from);

  await fs.rename(from, to);

  const sawBoth = await waitUntil(
    () => events.some((e) => e[0] === "add" && e[1] === to) &&
          events.some((e) => e[0] === "unlink" && e[1] === from),
    15000,
  );
  assert.equal(sawBoth, true, "rename real deve produzir add(novo) + unlink(antigo)");
  assert.ok(!events.some((e) => e[0] === "renamed"), "o watcher cru NAO emite rename");
});
