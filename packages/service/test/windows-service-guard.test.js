import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  WINDOWS_SERVICE_NAME,
  decideInstall,
  decideUninstall,
  isInsideRoot,
  resolvePackagedServiceScript,
} from "../dist/windows-service-guard.js";

const root = path.resolve(os.tmpdir(), "CyberSafe Assistant");
const script = path.join(root, "dist", "index.js");
const exists = (file) => path.resolve(file) === path.resolve(script);
const missing = () => false;

test("R7: raiz de desenvolvimento não regista serviço", () => {
  const dev = path.resolve(os.tmpdir(), "cybersafe-assistant", "packages", "service", "src");
  const plan = resolvePackagedServiceScript(dev, () => true);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /desenvolvimento/);
});

test("R7: entry point empacotado .js é resolvido dentro da raiz", () => {
  const plan = resolvePackagedServiceScript(root, () => true);
  assert.equal(plan.ok, true);
  assert.match(plan.scriptPath, /dist[\\/]index\.js$/);
});

test("R7: entry point .ts é recusado na instalação", () => {
  const decision = decideInstall({
    platform: "win32",
    installRoot: root,
    scriptPath: path.join(root, "dist", "index.ts"),
    exists: () => true,
    existing: null,
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /TypeScript/);
});

test("R7: entry point inexistente é recusado", () => {
  const plan = resolvePackagedServiceScript(root, missing);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /inexistente/);
});

test("R7: instalação válida com caminho existente é permitida", () => {
  const decision = decideInstall({
    platform: "win32",
    installRoot: root,
    scriptPath: script,
    exists,
    existing: null,
  });
  assert.equal(decision.ok, true);
});

test("R7: serviço com o mesmo nome a apontar para Downloads é conflito", () => {
  const foreign = path.resolve(os.tmpdir(), "Downloads", "cybersafe-assistant", "packages", "service", "src", "daemon", "cybersafeengine.exe");
  const decision = decideInstall({
    platform: "win32",
    installRoot: root,
    scriptPath: script,
    exists,
    existing: { name: WINDOWS_SERVICE_NAME, imagePath: foreign },
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /outro caminho/);
});

test("R7: reinstalação com ImagePath já dentro da raiz é permitida", () => {
  const decision = decideInstall({
    platform: "win32",
    installRoot: root,
    scriptPath: script,
    exists,
    existing: { name: WINDOWS_SERVICE_NAME, imagePath: script },
  });
  assert.equal(decision.ok, true);
});

test("R7: desinstalar serviço alheio é recusado", () => {
  const foreign = path.resolve(os.tmpdir(), "other", "engine.exe");
  const decision = decideUninstall({
    platform: "win32",
    installRoot: root,
    existing: { name: WINDOWS_SERVICE_NAME, imagePath: foreign },
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /não pertence/);
});

test("R7: desinstalar serviço com ImagePath ausente é recusado", () => {
  const decision = decideUninstall({
    platform: "win32",
    installRoot: root,
    existing: { name: WINDOWS_SERVICE_NAME, imagePath: null },
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /posse não provada/);
});

test("R7: desinstalar o próprio serviço é permitido; ausente é no-op", () => {
  const own = decideUninstall({
    platform: "win32",
    installRoot: root,
    existing: { name: WINDOWS_SERVICE_NAME, imagePath: script },
  });
  assert.equal(own.ok, true);
  const absent = decideUninstall({ platform: "win32", installRoot: root, existing: null });
  assert.equal(absent.ok, true);
  assert.equal(absent.alreadyAbsent, true);
});

test("R7: contenção de caminho não aceita prefixos parecidos", () => {
  assert.equal(isInsideRoot(path.join(root, "dist"), path.join(root, "dist", "index.js")), true);
  assert.equal(isInsideRoot(path.join(root, "dist"), path.join(root, "dist-other", "index.js")), false);
});
