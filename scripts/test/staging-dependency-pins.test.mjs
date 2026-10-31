/**
 * TESTES DOS PINS DE VERSÃO DO STAGING (TP-QA2-PACKAGING-ENGINES).
 *
 * CAUSA QUE ISTO FIXA: o staging corre `npm install` numa árvore fora do repo,
 * sem o `package-lock.json` do projecto. Com `^` nos manifestos, a candidata QA1
 * (2026-10-25) instalou better-sqlite3 12.11.1, enquanto o lock diz 12.10.0.
 *
 * O pin de @litko/yara-x foi retirado em 2026-10-31, quando o motor passou a
 * YARA clássico por processo (vendor/yara). O teste confirma que o grafo npm
 * deixou de o arrastar — se alguém reintroduzir o binding, o pin passa a faltar
 * e o staging deixa de ter uma versão fixada; esta é a regressão que importa.
 *
 * O que fica provado:
 *   1. a versão esperada vem SÓ do lock, e um pin sem entrada no lock falha;
 *   2. os manifestos dos workspaces declaram a versão exacta do lock (um `^`
 *      reintroduzido falha este teste, não o payload);
 *   3. a verificação da árvore instalada deteta deriva, ausência e manifesto
 *      ilegível — não "passa" por omissão;
 *   4. o lock já não contém @litko/yara-x nem os binários de plataforma;
 *   5. os avisos/proveniência não apresentam o YARA-X como distribuído.
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

function installPackage(appDir, name, version, extra = {}) {
  const dir = path.join(appDir, "node_modules", ...name.split("/"));
  writeJson(path.join(dir, "package.json"), { name, version, ...extra });
  return dir;
}

describe("pins de staging — fonte única é o lock", () => {
  it("lê as versões exactas do lock do repositório", () => {
    const versions = readLockedVersions({ lockFile: LOCK });
    assert.equal(versions["better-sqlite3"], "12.10.0");
  });

  it("o lock já não declara o binding YARA-X removido", () => {
    const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    for (const name of [
      "@litko/yara-x",
      "@litko/yara-x-win32-x64-msvc",
      "@litko/yara-x-darwin-arm64",
      "@litko/yara-x-darwin-x64",
      "@litko/yara-x-linux-arm64-gnu",
      "@litko/yara-x-linux-x64-gnu",
      "@litko/yara-x-win32-arm64-msvc",
    ]) {
      assert.equal(lock.packages?.[`node_modules/${name}`], undefined, `${name} ainda está no lock`);
    }
    assert.ok(!fs.readFileSync(LOCK, "utf8").includes("@litko/yara-x"));
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

  it("a expectativa só contém pins existentes em qualquer plataforma", () => {
    const win = expectedStagingVersions({ lockFile: LOCK, platform: "win32", arch: "x64" });
    const linux = expectedStagingVersions({ lockFile: LOCK, platform: "linux", arch: "x64" });
    assert.deepEqual(win.map((entry) => entry.name), ["better-sqlite3"]);
    assert.deepEqual(linux.map((entry) => entry.name), ["better-sqlite3"]);
    assert.ok(!win.some((entry) => entry.name.includes("@litko")));
    assert.equal(applicableStagingPins({ platform: "win32", arch: "x64" }).length, 1);
  });
});

describe("manifestos dos workspaces — versão exacta, sem intervalo", () => {
  it("packages/api fixa a versão do lock", () => {
    const report = assertPinnedManifestSpecs({ root: REPO_ROOT, lockFile: LOCK });
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    assert.equal(byName["better-sqlite3"].spec, "12.10.0");
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
        },
      });
      writeJson(path.join(dir, "packages", "api", "package.json"), { dependencies: { "better-sqlite3": "^12.10.0" } });
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
      const report = verifyStagedVersions(appDir, expected);
      assert.deepEqual(report.drift, []);
      assert.equal(report.ok, true);
      assert.equal(report.checked.length, expected.length);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("deteta a deriva que a QA1 produziu (12.11.1)", () => {
    const expected = expectedStagingVersions({ lockFile: LOCK, platform: "win32", arch: "x64" });
    const appDir = tempDir();
    try {
      installPackage(appDir, "better-sqlite3", "12.11.1");
      const report = verifyStagedVersions(appDir, expected);
      assert.equal(report.ok, false);
      assert.equal(report.drift.length, 1);
      assert.equal(report.drift[0].name, "better-sqlite3");
      assert.match(describeStagingDrift(report), /better-sqlite3: esperado 12\.10\.0, instalado 12\.11\.1/);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("trata o pacote ausente como falha, não como omissão", () => {
    const expected = expectedStagingVersions({ lockFile: LOCK, platform: "win32", arch: "x64" });
    const appDir = tempDir();
    try {
      const report = verifyStagedVersions(appDir, expected);
      assert.equal(report.ok, false);
      assert.ok(report.drift.some((entry) => entry.name === "better-sqlite3" && entry.actual === null));
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
  });

  it("NOTICES apresenta o YARA clássico como motor distribuído e o YARA-X como histórico", () => {
    const notices = fs.readFileSync(path.join(LICENSES, "THIRD-PARTY-NOTICES.txt"), "utf8");
    assert.match(notices, /YARA clássico 4\.6\.0/);
    assert.match(notices, /HISTÓRICO/i);
    assert.match(notices, /NÃO (são|é) distribu/i);
    assert.match(notices, /ascii_tree/);
  });
});
