/**
 * TESTES DOS METADADOS DE INSTALAÇÃO DO STAGING (TP-QA2-PACKAGING-ENGINES).
 *
 * A candidata QA1 resolveu o bloqueio de staging apagando dois lockfiles
 * (`package-lock.json` e `node_modules/.package-lock.json`) que traziam
 * `file:<tarball do staging>`. A remoção é legítima — não são ficheiros de
 * runtime — mas tem de ser CIRÚRGICA: só esses dois caminhos, só ficheiros
 * regulares, e sem perder nenhum manifesto instalado nem addon `.node`.
 *
 * O que fica provado:
 *   1. a verificação de staging recusa o marcador do staging num lockfile;
 *   2. depois do passo, a mesma verificação passa e os lockfiles desapareceram;
 *   3. manifestos, addons e metadados de TERCEIROS (por exemplo um
 *      `package-lock.json` dentro de uma dependência) não são tocados;
 *   4. a árvore sem lockfiles não é erro e nada é inventado;
 *   5. um alvo que não seja ficheiro regular falha fechado.
 *
 * Uso: node --test scripts/test/staging-install-metadata.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { verifyStagingSafety } from "../package-windows.mjs";
import {
  STAGING_INSTALL_METADATA,
  snapshotRuntimeResources,
  stripStagingInstallMetadata,
} from "../staging-install-metadata.mjs";

const STAGING_ROOT = path.join(os.tmpdir(), "cybersafe-package-qa2fixture");
const POSIX_STAGING_ROOT = STAGING_ROOT.replaceAll("\\", "/");
const STAGING_TARBALL = `${POSIX_STAGING_ROOT}/tarballs/cybersafe-core-0.1.1.tgz`;
// O pipeline passa as duas formas (nativa e POSIX), tal como em stageWorkspaces.
const FORBIDDEN = [STAGING_ROOT, POSIX_STAGING_ROOT];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

/** Árvore de staging mínima com os recursos que o runtime carrega. */
function makeAppTree() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-metadata-test-"));
  writeJson(path.join(appDir, "package.json"), {
    name: "cybersafe-fixture",
    version: "0.0.0",
    main: "dist/main.js",
    // Já normalizado pelo passo anterior do pipeline (a higiene de `file:` só
    // deixa a versão real nos manifestos); aqui só os lockfiles têm o staging.
    dependencies: { "@cybersafe/core": "0.1.1" },
  });
  writeText(path.join(appDir, "dist", "main.js"), "// fixture\n");
  writeJson(path.join(appDir, "package-lock.json"), {
    lockfileVersion: 3,
    packages: { "": { dependencies: { "@cybersafe/core": "file:" + STAGING_TARBALL } } },
  });
  writeJson(path.join(appDir, "node_modules", ".package-lock.json"), {
    lockfileVersion: 3,
    packages: { "node_modules/@cybersafe/core": { resolved: "file:" + STAGING_TARBALL } },
  });
  writeJson(path.join(appDir, "node_modules", "@cybersafe", "core", "package.json"), {
    name: "@cybersafe/core",
    version: "0.1.1",
    dependencies: { "@litko/yara-x": "0.5.0" },
  });
  writeJson(path.join(appDir, "node_modules", "better-sqlite3", "package.json"), {
    name: "better-sqlite3",
    version: "12.10.0",
  });
  writeText(path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "node-addon-fixture");
  writeJson(path.join(appDir, "node_modules", "@litko", "yara-x", "package.json"), {
    name: "@litko/yara-x",
    version: "0.5.0",
  });
  writeJson(path.join(appDir, "node_modules", "@litko", "yara-x", "node_modules", "@litko", "yara-x-win32-x64-msvc", "package.json"), {
    name: "@litko/yara-x-win32-x64-msvc",
    version: "0.5.0",
  });
  writeText(
    path.join(appDir, "node_modules", "@litko", "yara-x", "node_modules", "@litko", "yara-x-win32-x64-msvc", "yara-x.win32-x64-msvc.node"),
    "yara-addon-fixture",
  );
  // Metadado PRÓPRIO de uma dependência: não é nosso, não se toca.
  writeJson(path.join(appDir, "node_modules", "bindings", "package.json"), { name: "bindings", version: "1.5.0" });
  writeJson(path.join(appDir, "node_modules", "bindings", "package-lock.json"), { lockfileVersion: 3, packages: {} });
  return appDir;
}

function relativeSet(files, appDir) {
  return new Set(files.map((file) => path.relative(appDir, file).split(path.sep).join("/")));
}

describe("metadados de instalação do staging", () => {
  it("a verificação de staging recusa o caminho do staging no lockfile, e o passo resolve", () => {
    const appDir = makeAppTree();
    try {
      const before = verifyStagingSafety(appDir, { forbiddenContent: FORBIDDEN });
      assert.equal(before.ok, false);
      assert.ok(before.problems.some((problem) => problem.code === "forbidden-content" && problem.path === "node_modules/.package-lock.json"));
      const beforeResources = snapshotRuntimeResources(appDir);

      const report = stripStagingInstallMetadata({ appDir });
      assert.deepEqual(report.removed, [...STAGING_INSTALL_METADATA]);
      assert.equal(report.preserved.manifests, beforeResources.manifests.length);
      assert.equal(report.preserved.addons, beforeResources.addons.length);

      assert.equal(fs.existsSync(path.join(appDir, "package-lock.json")), false);
      assert.equal(fs.existsSync(path.join(appDir, "node_modules", ".package-lock.json")), false);

      const after = verifyStagingSafety(appDir, { forbiddenContent: FORBIDDEN });
      assert.deepEqual(after.problems, []);
      assert.equal(after.ok, true);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("preserva manifestos instalados, addons e metadados de terceiros", () => {
    const appDir = makeAppTree();
    try {
      const before = snapshotRuntimeResources(appDir);
      stripStagingInstallMetadata({ appDir });
      const after = snapshotRuntimeResources(appDir);
      assert.deepEqual(relativeSet([...after.manifests].sort(), appDir), relativeSet([...before.manifests].sort(), appDir));
      assert.deepEqual(relativeSet([...after.addons].sort(), appDir), relativeSet([...before.addons].sort(), appDir));

      // Recursos concretos que o runtime carrega continuam no sítio.
      assert.ok(fs.existsSync(path.join(appDir, "package.json")));
      assert.ok(fs.existsSync(path.join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")));
      assert.ok(
        fs.existsSync(
          path.join(appDir, "node_modules", "@litko", "yara-x", "node_modules", "@litko", "yara-x-win32-x64-msvc", "yara-x.win32-x64-msvc.node"),
        ),
      );
      // Lockfile de uma dependência é metadado PRÓPRIO dela: fica.
      assert.ok(fs.existsSync(path.join(appDir, "node_modules", "bindings", "package-lock.json")));
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("árvore sem lockfiles não é erro", () => {
    const appDir = makeAppTree();
    try {
      stripStagingInstallMetadata({ appDir });
      const report = stripStagingInstallMetadata({ appDir });
      assert.deepEqual(report.removed, []);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("recusa uma árvore que não é app", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-metadata-test-"));
    try {
      assert.throws(() => stripStagingInstallMetadata({ appDir: dir }), /não parece uma árvore de app/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa um alvo que não é ficheiro regular", () => {
    const appDir = makeAppTree();
    try {
      fs.rmSync(path.join(appDir, "package-lock.json"), { force: true });
      fs.mkdirSync(path.join(appDir, "package-lock.json"));
      assert.throws(() => stripStagingInstallMetadata({ appDir }), /não é um ficheiro regular/);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});
