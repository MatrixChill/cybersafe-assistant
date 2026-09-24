import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hasSeenOnboarding, markOnboardingSeen, resetOnboardingSeen } from "../src/lib/onboarding";

// localStorage mínimo em memória (sem depender de um browser/jsdom).
const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v); },
  removeItem: (k: string) => { storage.delete(k); },
  clear: () => storage.clear(),
};

beforeEach(() => storage.clear());
afterEach(() => storage.clear());

test("primeira utilização → onboarding ainda não visto", () => {
  assert.equal(hasSeenOnboarding(), false);
});

test("marcar como visto → passa a visto e persiste", () => {
  markOnboardingSeen();
  assert.equal(hasSeenOnboarding(), true);
});

test("o estado sobrevive a um \"novo arranque\" (nova leitura)", () => {
  markOnboardingSeen();
  assert.equal(hasSeenOnboarding(), true);
});

test("reset permite voltar a mostrar o onboarding", () => {
  markOnboardingSeen();
  resetOnboardingSeen();
  assert.equal(hasSeenOnboarding(), false);
});

test("chave usada é distinta e estável", () => {
  markOnboardingSeen();
  assert.equal(storage.get("cybersafe.onboarding.v1"), "1");
});

test("storage indisponível não rebenta a app", () => {
  (globalThis as any).localStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.equal(hasSeenOnboarding(), false);
  assert.doesNotThrow(() => markOnboardingSeen());
  assert.doesNotThrow(() => resetOnboardingSeen());
});