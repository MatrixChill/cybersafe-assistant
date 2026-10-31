/**
 * TESTES DOS PINS DE VERSÃO DO STAGING (TP-QA2-PACKAGING-ENGINES).
 *
 * CAUSA QUE ISTO FIXA: o staging corre `npm install` numa árvore fora do repo,
 * sem o `package-lock.json` do projecto. Com `^` nos manifestos, a candidata QA1
 * (2026-10-25) instalou better-sqlite3 12.11.1 e @litko/yara-x 0.5.2/0.5.1,
 * enquanto o lock e os avisos documentados dizem 12.10.0 e 0.5.0.
 *
 * O que fica provado:
 *   1. a versão esperada vem SÓ do lock, e um pin sem entrada no lock falha;
 *   2. os manifestos dos workspaces declaram a versão exacta do lock (um `^`
 *      reintroduzido falha este teste, não o payload);
 *   3. a verificação da árvore instalada deteta deriva, ausência e manifesto
 *      ilegível — não "passa" por omissão;
 *   4. as entradas de plataforma só se aplicam à plataforma certa;
 *   5. os avisos/proveniência não afirmam uma versão de YARA-X diferente da
 *      fixada (não se dá cobertura documental a 0.5.1/0.5.2 sem prova).
 *
 * Uso: node --test scripts/test/staging-dependency-pins.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import {
  applicableStagingPins,
  assertPinnedManifestSpecs,
  describeStagingDrift,
  expectedStagingVersions,
  readLockedVersions,
  verifyStagedVersions,
} from "../staging-dependency-pins.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const LOCK = path.join(REPO_ROOT, "package-lock.json");
const LICENSES = path.join(REPO_ROOT, "assets", "licenses");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-pins-test-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function installPackage(appDir, name, version, extra = {}) {
  const dir = path.join(appDir, "node_modules", ...name.split("/"));
  writeJson(path.join(dir, "package.json"), { name, version, ...extra });
  return dir;
}

describe("pins de staging — fonte única é o lock", () => {
  it("lê as versões exactas do lock do repositório", () => {
    const versions = readLockedVersions({ lockFile: LOCK });
    assert.equal(versions["better-sqlite3"], "12.10.0");
    assert.equal(versions["@litko/yara-x"], "0.5.0");
    assert.equal(versions["@litko/yara-x-win32-x64-msvc"], "0.5.0");
  });

  it("falha fechado quando o lock não tem o pacote fixado", () => {
    const dir = tempDir();
    try {
      const lock = path.join(dir, "package-lock.json");
      writeJson(lock, { lockfileVersion: 3, packages: { "": { name: "x" } } });
      assert.throws(() => readLockedVersions({ lockFile: lock }), /sem versão no lock/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("constrói a expectativa só com os pins da plataforma pedida", () => {
    const win = expectedStagingVersions({ lockFile: LOCK, platform: "win32", arch: "x64" });
    assert.ok(win.some((entry) => entry.name === "@litko/yara-x-win32-x64-msvc"));
    const linux = expectedStagingVersions({ lockFile: LOCK, platform: "linux", arch: "x64" });
    assert.ok(!linux.some((entry) => entry.name === "@litko/yara-x-win32-x64-msvc"));
    assert.ok(applicableStagingPins({ platform: "win32", arch: "x64" }).length > applicableStagingPins({ platform: "linux", arch: "x64" }).length);
  });
});

describe("manifestos dos workspaces — versão exacta, sem intervalo", () => {
  it("packages/api e packages/core fixam a versão do lock", () => {
    const report = assertPinnedManifestSpecs({ root: REPO_ROOT, lockFile: LOCK });
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    assert.equal(byName["better-sqlite3"].spec, "12.10.0");
    assert.equal(byName["@litko/yara-x"].spec, "0.5.0");
    for (const check of report.checks) {
      assert.ok(!/^[\^~]/.test(check.spec), `${check.name}: spec "${check.spec}" não é exacta`);
    }
  });

  it("deteta um intervalo `^` reintroduzido", () => {
    const dir = tempDir();
    try {
      writeJson(path.join(dir, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "node_modules/better-sqlite3": { version: "12.10.0" },
          "node_modules/@litko/yara-x": { version: "0.5.0" },
        },
      });
      writeJson(path.join(dir, "packages", "api", "package.json"), { dependencies: { "better-sqlite3": "^12.10.0" } });
      writeJson(path.join(dir, "packages", "core", "package.json"), { dependencies: { "@litko/yara-x": "0.5.0" } });
      const report = assertPinnedManifestSpecs({ root: dir, lockFile: path.join(dir, "package-lock.json") });
      assert.equal(report.ok, false);
      assert.match(report.problems[0].detail, /não é a versão exacta do lock/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verificação da árvore instalada", () => {
  it("aceita a árvore que corresponde ao lock", () => {
    const expected = expectedStagingVersions({ lockFile: LOCK, platform: "win32", arch: "x64" });
    const appDir = tempDir();
    try {
      installPackage(appDir, "better-sqlite3", "12.10.0");
      installPackage(appDir, "@litko/yara-x", "0.5.0");
      installPackage(appDir, "@litko/yara-x-win32-x64-msvc", "0.5.0");
      const report = verifyStagedVersions(appDir, expected);
      assert.deepEqual(report.drift, []);
      assert.equal(report.ok, true);
      assert.equal(report.checked.length, expected.length);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("deteta a deriva que a QA1 produziu (12.11.1 / 0.5.2 / 0.5.1)", () => {
    const expected = expectedStagingVersions({ lockFile: LOCK, platform: "win32", arch: "x64" });
    const appDir = tempDir();
    try {
      installPackage(appDir, "better-sqlite3", "12.11.1");
      installPackage(appDir, "@litko/yara-x", "0.5.2");
      installPackage(appDir, "@litko/yara-x-win32-x64-msvc", "0.5.1");
      const report = verifyStagedVersions(appDir, expected);
      assert.equal(report.ok, false);
      assert.equal(report.drift.length, 3);
      const names = report.drift.map((entry) => entry.name).sort();
      assert.deepEqual(names, ["@litko/yara-x", "@litko/yara-x-win32-x64-msvc", "better-sqlite3"]);
      assert.match(describeStagingDrift(report), /better-sqlite3: esperado 12\.10\.0, instalado 12\.11\.1/);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("trata o pacote ausente como falha, não como omissão", () => {
    const expected = expectedStagingVersions({ lockFile: LOCK, platform: "win32", arch: "x64" });
    const appDir = tempDir();
    try {
      installPackage(appDir, "better-sqlite3", "12.10.0");
      const report = verifyStagedVersions(appDir, expected);
      assert.equal(report.ok, false);
      assert.ok(report.drift.some((entry) => entry.name === "@litko/yara-x" && entry.actual === null));
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("aceita o binário aninhado no wrapper (layout observado no payload)", () => {
    const expected = expectedStagingVersions({ lockFile: LOCK, platform: "win32", arch: "x64" });
    const appDir = tempDir();
    try {
      installPackage(appDir, "better-sqlite3", "12.10.0");
      installPackage(appDir, "@litko/yara-x", "0.5.0");
      installPackage(appDir, "@litko/yara-x/node_modules/@litko/yara-x-win32-x64-msvc", "0.5.0");
      const report = verifyStagedVersions(appDir, expected);
      assert.equal(report.ok, true);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

describe("coerência com os avisos documentados", () => {
  it("PROVENANCE e NOTICES não afirmam 0.5.1/0.5.2", () => {
    const provenance = fs.readFileSync(path.join(LICENSES, "PROVENANCE.json"), "utf8");
    const notices = fs.readFileSync(path.join(LICENSES, "THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const text of [provenance, notices]) {
      assert.ok(!/\b0\.5\.1\b/.test(text), "documento cita 0.5.1 sem prova de cobertura");
      assert.ok(!/\b0\.5\.2\b/.test(text), "documento cita 0.5.2 sem prova de cobertura");
    }
    assert.match(notices, /@litko\/yara-x 0\.5\.0/);
  });

  it("a versão fixada do YARA-X é a mesma dos textos e do lock", () => {
    const versions = readLockedVersions({ lockFile: LOCK });
    const notices = fs.readFileSync(path.join(LICENSES, "THIRD-PARTY-NOTICES.txt"), "utf8");
    assert.ok(notices.includes(`@litko/yara-x ${versions["@litko/yara-x"]}`));
    assert.ok(notices.includes(`yara-x-win32-x64-msvc ${versions["@litko/yara-x-win32-x64-msvc"]}`));
  });
});
