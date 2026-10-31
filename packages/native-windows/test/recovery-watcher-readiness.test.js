import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IsolatedFileWatcher } from "../dist/watcher-process.js";

/**
 * P0 readiness: `start()` tem de confirmar só quando o chokidar está PRONTO
 * ("ready"), não quando o processo apenas arrancou ("started"). Com
 * `ignoreInitial: true`, um ficheiro criado no intervalo entre "started" e
 * "ready" é visto pelo scan inicial e nunca emite `add` — perdia-se em
 * silêncio. Estes testes provam a prontidão real, a corrida com `stop()` e a
 * falha de arranque (filho morto antes de ready).
 */

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-recovery-ready-"));
  const watcher = new IsolatedFileWatcher();
  t.after(async () => {
    await watcher.stop().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, watcher };
}

test("start() só confirma depois de ready: write imediato recebe add (sem retry/sleep)", { timeout: 30000 }, async (t) => {
  const { dir, watcher } = await fixture(t);
  // Alarga de forma determinística a janela entre "started" e "ready": com uma
  // pasta com muitos ficheiros, o scan inicial do chokidar demora o suficiente
  // para que um write imediato (pós `await start()`) caia DENTRO do scan e seja
  // engolido pelo `ignoreInitial: true`. É assim que o defeito se manifesta.
  await Promise.all(
    Array.from({ length: 2000 }, (_, i) =>
      fs.writeFile(path.join(dir, `pre-${i}.dat`), "seed").catch(() => undefined),
    ),
  );

  await watcher.start([dir]);

  // Sem qualquer espera nem retry: escrever imediatamente a seguir ao await start().
  const target = path.join(dir, "imediato.txt");
  const added = once(watcher, "add", { signal: AbortSignal.timeout(20000) });
  await fs.writeFile(target, "x");
  assert.equal((await added)[0], target, "o ficheiro escrito após await start() tem de emitir add");
});

test("stop race: start() seguido de stop() assenta sem pendurar e liberta o processo", { timeout: 20000 }, async (t) => {
  const { dir, watcher } = await fixture(t);
  const starting = watcher.start([dir]);
  const stopping = watcher.stop();
  const settled = await Promise.allSettled([starting, stopping]);
  assert.equal(watcher.pid, undefined, "sem filho vivo depois da corrida start/stop");
  assert.equal(settled.every((r) => r.status === "fulfilled" || r.reason instanceof Error), true);
});

test("startup fail: exit do filho antes de ready rejeita start()", { timeout: 20000 }, async (t) => {
  const { dir, watcher } = await fixture(t);
  const starting = watcher.start([dir]);
  // Matar o filho o mais cedo possível (poll por setImmediate, sem sleep).
  const killer = (async () => {
    for (let i = 0; i < 2000 && watcher.pid === undefined; i++) {
      await new Promise((r) => setImmediate(r));
    }
    if (watcher.pid) {
      try { process.kill(watcher.pid); } catch { /* já saiu */ }
    }
  })();
  const outcome = await starting.then(() => "resolved", (error) => error);
  await killer;
  assert.notEqual(outcome, "resolved", "start() não pode resolver se o filho morreu antes de ready");
  assert.match(String(outcome), /exited|Watcher process|timed out/i);
});
