// RECOVERY-SECURITY 2026-10-14 — OpenCode
// Prova REAL, isolada, do watcher (processo filho chokidar via IsolatedFileWatcher),
// num diretorio temporario benigno. SEM registry, SEM caminhos pessoais, SEM mocks
// do watcher. Seams: apenas um helper de espera de evento (nao simula o watcher).
//
// Objetivo desta suite: criar/modificar/remover com o watcher REAL e reportar
// exatamente que eventos saem; e provar que as regras de `ignored` do filho
// (watcher-child.ts:25) silenciam dotfiles, *.log e node_modules.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { IsolatedFileWatcher } from "../dist/watcher-process.js";

// Espera um evento real com timeout (nao e um sleep artificial: e o teste a
// aguardar o comportamento em tempo real do watcher).
function wait(emitter, event, ms) {
  return once(emitter, event, { signal: AbortSignal.timeout(ms) });
}

// Janela de observacao: os ficheiros ignorados sao criados ANTES do ficheiro de
// controlo, portanto a chegada do `add` do controlo prova que o pipeline esta vivo
// e que o filho ja teve tempo de ver o que tinha de ver.
const OBSERVE_MS = 4000;

async function fixture(t) {
  // Directory proprio sob o temp do sistema (evita Downloads/Documents pessoais).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-recovery-"));
  const watcher = new IsolatedFileWatcher();
  t.after(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, watcher };
}

test("recovery: watcher real cria/modifica/remove com paths exatos", { timeout: 30000 }, async (t) => {
  const { dir, watcher } = await fixture(t);
  const events = [];
  watcher.on("add", (p) => events.push(["add", p]));
  watcher.on("change", (p) => events.push(["change", p]));
  watcher.on("unlink", (p) => events.push(["unlink", p]));

  const ready = wait(watcher, "ready", 12000);
  await watcher.start([dir]);
  assert.ok(watcher.pid > 0, "watcher deve correr num processo filho");
  assert.notEqual(watcher.pid, process.pid);
  await ready;

  const target = path.join(dir, "obs.txt");

  const added = wait(watcher, "add", 15000);
  await fs.writeFile(target, "primeiro");
  assert.equal((await added)[0], target, "add deve trazer o caminho exato");

  const changed = wait(watcher, "change", 15000);
  await fs.writeFile(target, "segundo");
  assert.equal((await changed)[0], target, "change deve trazer o caminho exato");

  const removed = wait(watcher, "unlink", 15000);
  await fs.unlink(target);
  assert.equal((await removed)[0], target, "unlink deve trazer o caminho exato");

  assert.deepEqual(
    events.map((e) => e[0]),
    ["add", "change", "unlink"],
    "sequencia real de eventos observada",
  );
});

test("recovery: ignored silencia dotfile, *.log e node_modules (controlo passa)", { timeout: 30000 }, async (t) => {
  const { dir, watcher } = await fixture(t);
  const seen = [];
  watcher.on("add", (p) => seen.push(["add", p]));
  watcher.on("change", (p) => seen.push(["change", p]));
  watcher.on("unlink", (p) => seen.push(["unlink", p]));

  const ready = wait(watcher, "ready", 12000);
  await watcher.start([dir]);
  await ready;

  // Alvos que o filho DEVE ignorar (watcher-child.ts:25).
  await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(dir, "node_modules", "dep.txt"), "x");
  await fs.writeFile(path.join(dir, ".hidden"), "x");
  await fs.writeFile(path.join(dir, "noise.log"), "x");

  // Controlo: um ficheiro normal TEM de passar (prova que o pipeline esta vivo).
  const control = path.join(dir, "control.txt");
  const controlAdd = wait(watcher, "add", 15000);
  await fs.writeFile(control, "x");
  const [controlPath] = await controlAdd;
  assert.equal(controlPath, control, "o ficheiro de controlo tem de gerar add");

  // Os ignorados foram criados antes do controlo; dar margem apos o controlo.
  await new Promise((r) => setTimeout(r, OBSERVE_MS));

  const paths = seen.map((e) => e[1].toLowerCase());
  assert.ok(!paths.some((p) => p.includes(".hidden")), "dotfile NAO pode gerar evento");
  assert.ok(!paths.some((p) => p.endsWith("noise.log")), "*.log NAO pode gerar evento");
  assert.ok(!paths.some((p) => p.includes("node_modules")), "node_modules NAO pode gerar evento");
  assert.ok(paths.includes(control.toLowerCase()), "o controlo continua presente na evidencia");
});
