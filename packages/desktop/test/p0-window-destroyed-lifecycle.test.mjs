import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { EventEmitter } from "node:events";

const source = fs.readFileSync(new URL("../src/window-foreground.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ hidden = false } = {}) {
  const timers = new Map();
  let serial = 0;
  const calls = [];
  const win = new EventEmitter();
  win.destroyed = false;
  win.visible = false;
  win.minimized = false;
  win.isDestroyed = () => win.destroyed;
  win.isVisible = () => win.visible;
  win.isMinimized = () => win.minimized;
  win.show = () => { assert.equal(win.destroyed, false); win.visible = true; calls.push("show"); };
  win.focus = () => calls.push("focus");
  win.restore = () => calls.push("restore");
  const wc = new EventEmitter();
  // Modela o Electron real: após destruição, o WebContents deixa de ser utilizável.
  const guard = (name, fn) => (...args) => {
    if (win.destroyed) throw new TypeError("Object has been destroyed");
    return fn(...args);
  };
  wc.once = guard("once", wc.once.bind(wc));
  wc.removeListener = guard("removeListener", wc.removeListener.bind(wc));
  win.webContents = wc;
  const ctx = { exports: {}, setTimeout: (fn) => { const id = ++serial; timers.set(id, fn); return { id, unref() {} }; },
    clearTimeout: (t) => timers.delete(t?.id) };
  vm.createContext(ctx);
  vm.runInContext(compiled, ctx);
  const api = ctx.exports;
  const presentation = api.installInitialWindowReveal(win, { hidden, isQuitting: () => false });
  const flush = () => { const p = [...timers.values()]; timers.clear(); p.forEach((fn) => fn()); };
  return { win, calls, presentation, flush };
}

test("PRE/POST: destroying the window then cancelling/disposing never touches the destroyed webContents", () => {
  const f = fixture();
  // Janela destruída pelo SO sem passar pelo close (ex.: encerramento forçado).
  f.win.destroyed = true;
  f.win.emit("closed");
  assert.doesNotThrow(() => f.presentation.dispose());
  assert.doesNotThrow(() => f.presentation.requestForeground());
  assert.doesNotThrow(() => f.presentation.dispose());
  f.flush();
  assert.deepEqual(f.calls, []);
});

test("PRE/POST: closed during pending reveal, then repeated cancel/dispose calls are idempotent", () => {
  const f = fixture();
  f.win.destroyed = true;
  f.win.emit("closed");
  assert.doesNotThrow(() => { f.presentation.requestForeground(); f.presentation.dispose(); f.presentation.dispose(); });
  f.flush();
  assert.deepEqual(f.calls, []);
});
