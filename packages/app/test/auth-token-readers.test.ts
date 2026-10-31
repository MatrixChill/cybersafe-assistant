import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { saveAuthSession, clearAuthSession, getAuthToken } from "../src/lib/authSession";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
} });
Object.defineProperty(globalThis, "window", { configurable: true, value: { electronAPI: { authSession: {
  write: async () => {}, read: async () => null, clear: async () => {},
} } } });

// Run the exact reader functions from the components, not a rewritten helper.
// UI/rendering is outside this test; the store has real Electron/DPAPI coverage.
function reader(file: string): () => Record<string, string> {
  const source = fs.readFileSync(new URL("../src/" + file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) &&
    ["authHeaders", "tokenDeSessao"].includes(node.name?.text ?? ""));
  assert.ok(functions.some(node => (node as ts.FunctionDeclaration).name?.text === "authHeaders"));
  const js = ts.transpileModule(functions.map(node => node.getText(ast)).join("\n"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(js + ";authHeaders", { getAuthToken, globalThis, TOKEN_KEY: "cybersafe_token" });
}

for (const file of ["components/AIAssistant.tsx", "pages/SettingsPage.tsx", "pages/SimulatorPage.tsx"]) {
  test(file + ": session-only, remembered, logout and account switch use the current bearer", async () => {
    const headers = reader(file);
    await clearAuthSession(); assert.equal(Object.keys(headers()).length, 0);
    await saveAuthSession("fixture.accountA.signature", false);
    assert.equal(headers().Authorization === "Bearer fixture.accountA.signature", true, "temporary session must work without a localStorage bearer");
    await clearAuthSession(); assert.equal(Object.keys(headers()).length, 0, "no replay after logout");
    await saveAuthSession("fixture.accountB.signature", true);
    assert.equal(headers().Authorization === "Bearer fixture.accountB.signature", true, "account B must not inherit A's bearer");
    assert.equal(values.has("cybersafe_token"), false);
    await clearAuthSession(); assert.equal(Object.keys(headers()).length, 0);
  });
}
