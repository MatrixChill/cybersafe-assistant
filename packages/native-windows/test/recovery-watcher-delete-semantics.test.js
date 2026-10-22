import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NativeWindowsWatcher } from "../dist/index.js";

// D1 (RECOVERY-SECURITY 2026-10-14): o watcher rotulava `unlink` como
// `file.renamed` — transformava uma REMOÇÃO num RENAME inventado. Estes testes
// fixam que remover um ficheiro emite `file.deleted` e NUNCA `file.renamed`.
// Watcher REAL (processo filho), pasta temporária benigna; o snapshot de
// registry é substituído por um no-op para não tocar no registry nos testes.
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(fn, ms = 25000, step = 100) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      let v;
      try { v = fn(); } catch (e) { clearInterval(t); return reject(e); }
      if (v) { clearInterval(t); resolve(v); }
      else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error("timeout a espera do evento")); }
    }, step);
  });
}

describe("NativeWindowsWatcher deletion semantics (D1)", () => {
  let dir, watcher, events;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-recovery-delete-"));
    watcher = new NativeWindowsWatcher();
    // Seam mínimo: evita PowerShell/registry nos testes (não é o objeto do teste).
    watcher.captureRegistrySnapshot = async () => {};
    events = [];
    for (const ev of ["file.created", "file.modified", "file.deleted", "file.renamed"]) {
      watcher.on(ev, (e) => events.push({ ev, p: e.path }));
    }
    await watcher.start([dir]);
    // NativeWindowsWatcher.start() resolve no "started", não no "ready", e o
    // chokidar usa ignoreInitial:true — um ficheiro visto no scan inicial não
    // emite. Espera-se por um evento real de um ficheiro NOVO, re-tentando com
    // nomes novos até o watcher estar pronto (sem sleeps artificiais).
    let ready = false;
    for (let i = 0; i < 8 && !ready; i++) {
      const p = path.join(dir, `warmup-${i}.txt`);
      await fs.writeFile(p, "warmup");
      // awaitWriteFinish (3s estabilidade + 2s poll) pode atrasar o `add` até
      // ~5s; a janela é folgada para não confundir latência do watcher com
      // "ainda não pronto".
      ready = await waitFor(() => events.find((e) => e.ev === "file.created" && e.p === p), 7000)
        .then(() => true)
        .catch(() => false);
    }
    if (!ready) throw new Error("watcher não ficou pronto (ready) em tempo útil");
    events.length = 0;
  });

  after(async () => {
    try { await watcher.stop(); } catch { /* best-effort */ }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("remover um ficheiro emite file.deleted e nunca file.renamed", async () => {
    const f = path.join(dir, "gone.txt");
    await fs.writeFile(f, "x");
    await waitFor(() => events.find((e) => e.ev === "file.created" && e.p === f));

    await fs.rm(f);
    await waitFor(() => events.find((e) => e.ev === "file.deleted" && e.p === f));

    const renamedOfF = events.filter((e) => e.ev === "file.renamed" && e.p === f);
    assert.deepEqual(renamedOfF, [], "um ficheiro removido nunca deve ser reportado como renomeado");
  });

  test("a criação continua a emitir file.created (não se perde o add)", async () => {
    const g = path.join(dir, "kept.txt");
    await fs.writeFile(g, "y");
    const created = await waitFor(() => events.find((e) => e.ev === "file.created" && e.p === g));
    assert.equal(created.p, g);
  });

  test("getMonitoredPaths devolve só os caminhos realmente validados", async () => {
    const w2 = new NativeWindowsWatcher();
    w2.captureRegistrySnapshot = async () => {};
    const missing = path.join(os.tmpdir(), `cs-recovery-missing-${Date.now()}`);
    await w2.start([dir, missing]);
    try {
      const monitored = w2.getMonitoredPaths();
      assert.ok(
        monitored.some((p) => path.resolve(p) === path.resolve(dir)),
        `o caminho válido deve estar monitorizado: ${JSON.stringify(monitored)}`
      );
      assert.ok(
        !monitored.some((p) => p.includes("cs-recovery-missing-")),
        "um caminho inexistente não pode aparecer como monitorizado"
      );
    } finally {
      await w2.stop();
    }
  });
});
