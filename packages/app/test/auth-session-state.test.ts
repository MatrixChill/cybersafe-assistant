import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreAuthSession, saveAuthSession, clearAuthSession, getAuthToken } from "../src/lib/authSession";
const values = new Map<string, string>();
let clears = 0;
let read: () => Promise<string | null> = async () => null;
let write: () => Promise<void> = async () => {};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
} });
Object.defineProperty(globalThis, "window", { configurable: true, value: { electronAPI: { authSession: {
  read: () => read(), write: () => write(), clear: async () => { clears++; },
} } } });
test("a delayed restore cannot reintroduce the bearer after logout", async () => {
  values.clear(); let finish!: (value: string) => void;
  read = () => new Promise(resolve => { finish = resolve; });
  const restoring = restoreAuthSession(); await clearAuthSession(); finish("fixture.old.signature");
  await restoring; assert.equal(getAuthToken() === null, true);
});
test("a delayed save response cannot undo logout", async () => {
  let finish!: () => void; write = () => new Promise(resolve => { finish = resolve; });
  const saving = saveAuthSession("fixture.old.signature", true);
  await clearAuthSession(); finish(); await saving;
  assert.equal(getAuthToken() === null, true); write = async () => {};
});
test("logout clears secure storage even if browser storage throws", async () => {
  const local = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem: () => { throw new Error("public storage fixture failure"); },
  } });
  const before = clears;
  try { await assert.rejects(clearAuthSession()); assert.equal(clears, before + 1); assert.equal(getAuthToken(), null); }
  finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local }); }
});
test("a legacy bearer is removed, never silently opted into new persistence", async () => {
  values.clear(); values.set("cybersafe_token", "fixture.legacy.signature"); read = async () => null;
  assert.equal((await restoreAuthSession()) === "fixture.legacy.signature", true);
  assert.equal(values.has("cybersafe_token"), false); await clearAuthSession();
});
