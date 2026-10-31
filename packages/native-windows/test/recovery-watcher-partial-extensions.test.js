import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IsolatedFileWatcher } from "../dist/watcher-process.js";

// D4 (RECOVERY-SECURITY 2026-10-14): transferências parciais geravam eventos
// enquanto ainda estavam a ser escritas. Estes testes fixam que as extensões de
// transferência parcial produzem ZERO eventos, com um ficheiro de controlo a
// provar que o pipeline real continua vivo. Watcher REAL, pasta temporária
// benigna, sem registry nem ficheiros pessoais.
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

describe("IsolatedFileWatcher partial-download extensions (D4)", () => {
  let dir, watcher, events;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-recovery-partial-"));
    watcher = new IsolatedFileWatcher();
    events = [];
    for (const ev of ["add", "change", "unlink"]) watcher.on(ev, (p) => events.push({ ev, p }));
    await watcher.start([dir]);
  });

  after(async () => {
    try { await watcher.stop(); } catch { /* best-effort */ }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("extensões de transferência parcial (.part/.crdownload/.partial/.tmp) são ignoradas; controlo é observado", async () => {
    const partials = ["dl.part", "dl.crdownload", "dl.partial", "dl.tmp"].map((n) => path.join(dir, n));
    const control = path.join(dir, "keep.bin");

    await Promise.all(partials.map((p) => fs.writeFile(p, "partial-bytes")));
    await fs.writeFile(control, "control-bytes");

    // O controlo prova que o watcher real está a entregar eventos.
    await waitFor(() => events.find((e) => e.ev === "add" && e.p === control));
    // Janela de observação: os parciais foram escritos no mesmo instante que o
    // controlo, por isso não podem aparecer "mais tarde" que ele.
    await delay(4500);

    const leaked = events.filter((e) => partials.includes(e.p));
    assert.deepEqual(leaked, [], `ficheiros parciais não devem emitir eventos: ${JSON.stringify(leaked)}`);
  });
});
