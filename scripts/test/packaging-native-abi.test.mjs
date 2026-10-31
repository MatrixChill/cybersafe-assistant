import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as packaging from "../package-windows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeTool(dir, version) {
  const cli = path.join(dir, "node_modules/node-gyp/bin/node-gyp.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "// fixture");
  fs.writeFileSync(path.join(dir, "node_modules/node-gyp/package.json"), JSON.stringify({ name: "node-gyp", version }));
  return cli;
}
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-native-abi-"));
  const moduleDir = path.join(dir, "node_modules/better-sqlite3");
  fs.mkdirSync(path.join(moduleDir, "build/Release"), { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.10.0" }));
  return { dir, moduleDir };
}

function fakeAddon(moduleDir, abi) {
  const file = path.join(moduleDir, "build/Release/better_sqlite3.node");
  fs.writeFileSync(file, Buffer.concat([Buffer.from("MZ"), Buffer.from(`node_register_module_v${abi}`)]));
  return file;
}

test("native ABI: node-gyp 9.4.1 is rejected with the Visual Studio 18 reason", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-old-gyp-"));
  const tool = packaging.resolveNativeRebuildTool({ cli: fakeTool(dir, "9.4.1") });
  assert.equal(tool.ok, false);
  assert.equal(tool.version, "9.4.1");
  assert.match(tool.reason, /Visual Studio 18/);
});

test("native ABI: node-gyp 12.1.0 is accepted, and a missing CLI fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-new-gyp-"));
  const tool = packaging.resolveNativeRebuildTool({ cli: fakeTool(dir, "12.1.0") });
  assert.equal(tool.ok, true);
  assert.equal(tool.version, "12.1.0");
  const missing = packaging.resolveNativeRebuildTool({ cli: path.join(dir, "absent/bin/node-gyp.js") });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /ausente/);
});

test("native ABI: known Electron version resolves ABI 130", () => {
  assert.equal(packaging.electronAbi("33.4.11"), 130);
  assert.throws(() => packaging.electronAbi("0.0.0-unknown"), /ABI desconhecida/);
});

test("native ABI: classification distinguishes Node-ABI, N-API and unknown", () => {
  const { moduleDir } = makeFixture();
  assert.deepEqual(
    (({ kind, abi }) => ({ kind, abi }))(packaging.classifyNativeAddon(fakeAddon(moduleDir, 137))),
    { kind: "node-abi", abi: 137 },
  );
  const napi = path.join(moduleDir, "build/Release/napi.node");
  fs.writeFileSync(napi, Buffer.from("napi_register_module_v1"));
  assert.equal(packaging.classifyNativeAddon(napi).kind, "napi");
  const other = path.join(moduleDir, "build/Release/plugin.node");
  fs.writeFileSync(other, Buffer.from("sqlite extension without node entry point"));
  assert.equal(packaging.classifyNativeAddon(other).kind, "unknown");
});

test("native ABI: verification fails closed on ABI137 and accepts ABI130", () => {
  const { dir, moduleDir } = makeFixture();
  fakeAddon(moduleDir, 137);
  const wrong = packaging.verifyNativeAddons(dir, { targetAbi: 130 });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.problems.some((problem) => problem.includes("ABI 137")));
  fakeAddon(moduleDir, 130);
  assert.equal(packaging.verifyNativeAddons(dir, { targetAbi: 130 }).ok, true);
});

test("native ABI: unknown addon type is a problem, never silently accepted", () => {
  const { dir, moduleDir } = makeFixture();
  fakeAddon(moduleDir, 130);
  fs.writeFileSync(path.join(moduleDir, "build/Release/plugin.node"), Buffer.from("opaque"));
  const result = packaging.verifyNativeAddons(dir, { targetAbi: 130 });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("tipo desconhecido")));
});

test("native ABI: generated manifest disables the builder rebuild and keeps unpack patterns", () => {
  const manifest = packaging.buildAppManifest({
    desktopManifest: { name: "@cybersafe/desktop", version: "0.1.1", type: "module", main: "dist/main.js", build: { productName: "CyberSafe Assistant" } },
    tarballs: { "@cybersafe/core": "c.tgz", "@cybersafe/shared-types": "s.tgz", "@cybersafe/service": "v.tgz", api: "a.tgz" },
    electronVersion: "33.4.11", scanEngine: "scan-engine.exe", outDir: "out", desktopDir: "desktop",
    productVersion: "0.1.10-internal.pap-r6.20261031",
  });
  assert.equal(manifest.build.npmRebuild, false);
  assert.deepEqual(manifest.build.asarUnpack, ["**/*.node", "**/node_modules/better-sqlite3/**"]);
  assert.ok(!manifest.build.asarUnpack.some((pattern) => pattern.includes("@litko")));
});

test("native ABI: stage rebuilds and verifies before the builder handoff", () => {
  const source = fs.readFileSync(path.join(here, "../package-windows.mjs"), "utf8");
  const stage = source.slice(source.indexOf("function stageWorkspaces()"));
  const prepare = stage.indexOf("prepareNativeAddons({");
  assert.ok(prepare > stage.indexOf("normalizeStagingRefsUnderApp({"));
  assert.ok(prepare < stage.indexOf("return { appDir, stagingRoot }"));
  assert.ok(stage.indexOf("verifyStagingSafety(appDir") > prepare, "secret audit runs after the ABI gate");
});
