import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as packaging from "../package-windows.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-packaging-security-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(label, files) {
  const dir = path.join(root, label);
  fs.mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}
function audit(dir, options) {
  assert.equal(typeof packaging.verifyStagingSafety, "function", "staging must be measured, not just filtered by name");
  return packaging.verifyStagingSafety(dir, options);
}

test("packaging staging: clean compiled layout and key names without secret values are accepted", () => {
  const dir = fixture("clean", { "package.json": '{"main":"dist/main.js"}', "dist/main.js": 'const key = process.env.CYBERSAFE_AI_API_KEY; const algorithm = "HS256";', "node_modules/example/LICENSE": "Permission is hereby granted" });
  const result = audit(dir);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.filesChecked, 3);
});

test("packaging staging: private data paths are refused without opening their contents", () => {
  for (const [i, name] of ["runtime-data/fixture.txt", ".env", ".env-private", "secrets/api-jwt-secret", "profiles/Default/preferences.json", "history/private.json", "storage/cybersafe.db", "config/credentials.json", "config/tokens.json"].entries()) {
    const result = audit(fixture(`private-${i}`, { [name]: "FAKE-NOT-A-REAL-SECRET" }));
    assert.equal(result.ok, false, name);
    assert.ok(result.problems.some((p) => p.code === "private-runtime-path"), name);
  }
});

test("packaging staging: renamed fake canary is detected by content without leaking it in report", () => {
  const marker = "CYBERSAFE_FAKE_SECRET_CANARY_20261024_NOT_A_CREDENTIAL";
  const result = audit(fixture("renamed", { "dist/innocent.js": `const value = '${marker}';` }), { forbiddenContent: [marker] });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === "forbidden-content"));
  assert.equal(JSON.stringify(result).includes(marker), false);
});

test("packaging staging: literal credential assignment and private key are refused in renamed files", () => {
  const fake = "FAKE_CANARY_VALUE_NOT_A_VALID_PROVIDER_KEY_123456";
  const result = audit(fixture("literal", { "dist/config.json": JSON.stringify({ apiKey: fake }), "dist/key.txt": `-----BEGIN PRIVATE KEY-----\n${"RkFLRV9OT1RfQV9SRUFMX0tFWQ==".repeat(4)}\n-----END PRIVATE KEY-----` }));
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === "literal-credential"));
  assert.ok(result.problems.some((p) => p.code === "private-key-material"));
  assert.equal(JSON.stringify(result).includes(fake), false);
});

test("packaging staging: absolute developer path is detected inside a compiled file", () => {
  const marker = "C:/FAKE-DEVELOPER-ROOT-ONLY-FIXTURE";
  const result = audit(fixture("absolute", { "dist/main.js": `const path = '${marker}/packages/api/dist/index.js';` }), { forbiddenContent: [marker] });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === "forbidden-content"));
});

test("packaging staging: documented incomplete private-key example is not key material", () => {
  const result = audit(fixture("documented-placeholder", { "node_modules/example/README.md": 'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\nKh9NV...\\n...\\n-----END RSA PRIVATE KEY-----"' }));
  assert.equal(result.ok, true);
});

test("packaging staging: fake marker spanning read chunks is detected", () => {
  const marker = "FAKE_CANARY_ACROSS_CHUNKS_NOT_A_SECRET";
  const result = audit(fixture("chunk-boundary", { "dist/large.bin": "x".repeat(65520) + marker + "y".repeat(4096) }), { forbiddenContent: [marker] });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === "forbidden-content"));
});

test("packaging staging: audit is wired after normalization and before builder handoff", () => {
  const source = fs.readFileSync(new URL("../package-windows.mjs", import.meta.url), "utf8");
  const stage = source.slice(source.indexOf("function stageWorkspaces()"));
  assert.ok(stage.indexOf("verifyStagingSafety(appDir") > stage.indexOf("normalizeStagingRefsUnderApp({"));
  assert.ok(stage.indexOf("verifyStagingSafety(appDir") < stage.indexOf("return { appDir, stagingRoot }"));
  assert.match(stage, /if \(!safety\.ok\)/);
});

test("packaging staging: regular hardlink to fixture is refused", () => {
  const dir = fixture("linked", { "dist/source.txt": "FAKE_PUBLIC_FIXTURE" });
  fs.linkSync(path.join(dir, "dist/source.txt"), path.join(dir, "dist/copy.txt"));
  const result = audit(dir);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === "linked-staging-entry"));
});

test("packaging staging: linked root is refused before following its target", () => {
  const target = fixture("root-target", { "dist/public.js": "export const publicFixture = true;" });
  const linked = path.join(root, "linked-root");
  fs.symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
  const result = audit(linked);
  assert.equal(result.ok, false);
  assert.equal(result.filesChecked, 0, "must not inspect linked root contents");
  assert.ok(result.problems.some((p) => p.code === "linked-staging-entry" && p.path === "."));
});

test("packaging staging: missing root fails closed", () => {
  const result = audit(path.join(root, "missing"));
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === "staging-unreadable"));
});

// ── Caminhos de compilação no staging (achado R2 do Codex) ───────────────────
// O rebuild deixa no `build/` projetos MSBuild, objetos e PDB com o caminho
// absoluto da árvore de staging, e o `.node` levava a mesma informação dentro do
// binário. Estes testes medem a causa: o projeto gerado é reescrito e os
// subprodutos são apagados, sem tocar no addon que é carregado em runtime.
function nativeModule(label, project, extra = {}) {
  const dir = fixture(label, { "package.json": '{"name":"better-sqlite3"}', ...extra });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build", "better_sqlite3.vcxproj"), project);
  return dir;
}

const VCXPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" ToolsVersion="17.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <ClCompile>
      <AdditionalIncludeDirectories>C:\\FAKE-BUILD-ROOT\\headers\\include\\node</AdditionalIncludeDirectories>
      <DebugInformationFormat>OldStyle</DebugInformationFormat>
      <Optimization>Full</Optimization>
    </ClCompile>
    <Link>
      <GenerateDebugInformation>true</GenerateDebugInformation>
    </Link>
  </ItemDefinitionGroup>
</Project>
`;

test("packaging staging: generated MSBuild project is rewritten without debug information", () => {
  assert.equal(typeof packaging.stripGeneratedBuildDebugInfo, "function", "o hardening tem de existir, não ser um comentário");
  const dir = nativeModule("hardened", VCXPROJ);
  const result = packaging.stripGeneratedBuildDebugInfo(dir);
  assert.deepEqual(result.projects, ["better_sqlite3.vcxproj"]);
  assert.equal(result.tags, 2);
  const text = fs.readFileSync(path.join(dir, "build", "better_sqlite3.vcxproj"), "utf8");
  assert.match(text, /<DebugInformationFormat>None<\/DebugInformationFormat>/);
  assert.match(text, /<GenerateDebugInformation>false<\/GenerateDebugInformation>/);
  assert.doesNotMatch(text, /OldStyle/);
  assert.doesNotMatch(text, /<GenerateDebugInformation>true</);
  // O resto do projeto fica intacto: só a política de debug muda.
  assert.match(text, /<Optimization>Full<\/Optimization>/);
  assert.match(text, /FAKE-BUILD-ROOT/);
});

test("packaging staging: generated project without debug markers fails closed", () => {
  const dir = nativeModule("unrecognised", "<Project><ItemDefinitionGroup><ClCompile /></ItemDefinitionGroup></Project>\n");
  assert.throws(() => packaging.stripGeneratedBuildDebugInfo(dir), /política de build mudou/);
  const missing = fixture("no-build-dir", { "package.json": "{}" });
  assert.throws(() => packaging.stripGeneratedBuildDebugInfo(missing), /sem projeto MSBuild gerado/);
});

test("packaging staging: compiled byproducts are pruned and the shipped addon stays", () => {
  assert.equal(typeof packaging.pruneNativeBuildProducts, "function", "a limpeza tem de existir, não ser um comentário");
  const marker = "C:/FAKE-DEVELOPER-ROOT-ONLY-FIXTURE";
  const dir = nativeModule("pruned", VCXPROJ, {
    "build/Release/better_sqlite3.node": "FAKE-BINARY-FIXTURE",
    "build/Release/better_sqlite3.pdb": marker,
    "build/Release/better_sqlite3.lib": marker,
    "build/Release/obj/better_sqlite3/src/better_sqlite3.obj": marker,
    "build/Release/obj/better_sqlite3/better_sqlite3.tlog/Cl.items.tlog": marker,
    "build/deps/sqlite3.vcxproj": marker,
    "build/config.gypi": marker,
  });
  // Antes: o auditor recusa a árvore por causa dos subprodutos.
  assert.equal(audit(dir, { forbiddenContent: [marker] }).ok, false);
  const addon = path.join(dir, "build", "Release", "better_sqlite3.node");
  const removed = packaging.pruneNativeBuildProducts(dir, { keep: [addon] });
  assert.ok(removed.includes("build/better_sqlite3.vcxproj"));
  assert.ok(removed.includes("build/Release/better_sqlite3.pdb"));
  assert.ok(removed.includes("build/Release/obj/better_sqlite3/src/better_sqlite3.obj"));
  assert.ok(!removed.some((entry) => entry.endsWith(".node")), "um addon de runtime nunca é apagado");
  assert.equal(fs.existsSync(addon), true, "o .node empacotado tem de continuar lá");
  assert.equal(audit(dir, { forbiddenContent: [marker] }).ok, true, "depois da limpeza o staging não tem caminhos de build");
  // Idempotente: uma segunda passagem não encontra nada para remover.
  assert.deepEqual(packaging.pruneNativeBuildProducts(dir, { keep: [addon] }), []);
});

test("packaging staging: rebuild hardens the project between configure and build", () => {
  const source = fs.readFileSync(new URL("../package-windows.mjs", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export function prepareNativeAddons("), source.indexOf("export function electronAbi("));
  assert.ok(fn.indexOf('gyp(cwd, "configure")') > 0, "o rebuild passa a ser configure + build");
  assert.ok(fn.indexOf("withNeutralBuildDrive(") > 0, "a compilação não pode gravar o caminho do perfil no binário");
  assert.ok(fn.indexOf('gyp(cwd, "configure")') < fn.indexOf("stripGeneratedBuildDebugInfo(moduleDir)"), "o projeto é endurecido depois do configure");
  assert.ok(fn.indexOf("stripGeneratedBuildDebugInfo(moduleDir)") < fn.indexOf('gyp(cwd, "build")'), "o build corre depois do hardening");
  assert.ok(fn.indexOf("pruneNativeBuildProducts(") > fn.indexOf('gyp(cwd, "build")'), "a limpeza corre depois do build");
  assert.ok(fn.indexOf("pruneNativeBuildProducts(") < fn.indexOf("rebuilt.push("), "a limpeza corre antes de declarar o addon reconstruído");
});
