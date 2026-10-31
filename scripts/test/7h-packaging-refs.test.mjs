/**
 * TESTES DA NORMALIZAÇÃO DAS REFERÊNCIAS DE STAGING (`file:` → versão real).
 *
 * CONTEXTO MEDIDO (13/10/2026, no `app.asar` entregue a 11/10): o pacote levava
 * caminhos do build MESMO dentro do ficheiro que o utilizador recebe, em cinco
 * sítios — não só no manifesto raiz:
 *
 *   package.json                                4 refs
 *   node_modules/@cybersafe/service/package.json 3 refs
 *   node_modules/@cybersafe/core/package.json    1 ref
 *   node_modules/@cybersafe/native-windows/package.json 1 ref
 *   node_modules/api/package.json                1 ref
 *   (total 10 refs `file:C:/Users/<user>/AppData/Local/Temp/cybersafe-package-XXX/tarballs/YYY.tgz`)
 *
 * Estes testes medem a correção em duas camadas:
 *   A. `normalizeStagingRefs` — função PURA: um manifesto entra, sai normalizado.
 *      Prova que só mexe em dependências internas apontadas aos tarballs desta
 *      execução e que NÃO inventa versões.
 *   B. `normalizeStagingRefsUnderApp` — aplica a árvore instalada inteira: prova
 *      que a higiene não fica só no root e que uma referência que não pode ser
 *      reescrita (num manifesto externo) faz FALHAR em vez de viajar calada.
 *
 * Nada aqui corre npm, electron-builder ou toca o `dist`.
 *
 * Uso: node --test scripts/test/7h-packaging-refs.test.mjs
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  normalizeStagingRefs,
  normalizeStagingRefsUnderApp,
  readInstalledVersions,
} from "../package-windows.mjs";

const INTERNAL = ["@cybersafe/core", "@cybersafe/shared-types", "@cybersafe/service", "api"];

const TARBALL_DIR = path.join(os.tmpdir(), "cybersafe-package-FIXTURE", "tarballs");
const ref = (file) => `file:${path.join(TARBALL_DIR, file)}`;
const refPosix = (file) => `file:${path.posix.join(TARBALL_DIR.replace(/\\/g, "/"), file)}`;

function manifest(overrides = {}) {
  return {
    name: "@cybersafe/desktop",
    version: "0.1.1",
    dependencies: {
      "@cybersafe/core": "0.1.1",
      "@cybersafe/shared-types": "0.1.1",
      "@cybersafe/service": "0.1.1",
      api: "0.1.1",
      ...(overrides.dependencies ?? {}),
    },
    ...overrides,
  };
}

const versions = {
  "@cybersafe/core": "0.1.1",
  "@cybersafe/shared-types": "0.1.1",
  "@cybersafe/service": "0.1.1",
  api: "0.1.1",
};

const opts = { tarballDir: TARBALL_DIR, internalNames: INTERNAL, versions };

describe("normalizeStagingRefs (função pura)", () => {
  it("substitui cada referência interna de tarball pela versão verificada do pacote", () => {
    const input = manifest({
      dependencies: {
        "@cybersafe/core": ref("cybersafe-core-0.1.1.tgz"),
        "@cybersafe/shared-types": refPosix("cybersafe-shared-types-0.1.1.tgz"),
        "@cybersafe/service": ref("cybersafe-service-0.1.1.tgz"),
        api: ref("api-0.1.1.tgz"),
      },
    });
    const { manifest: out, changes } = normalizeStagingRefs(input, opts);
    assert.deepEqual(out.dependencies, {
      "@cybersafe/core": "0.1.1",
      "@cybersafe/shared-types": "0.1.1",
      "@cybersafe/service": "0.1.1",
      api: "0.1.1",
    });
    assert.equal(changes.length, 4, "todas as quatro referências internas foram normalizadas");
    for (const change of changes) {
      assert.ok(INTERNAL.includes(change.name));
      assert.match(change.from, /cybersafe-package-FIXTURE/);
      assert.equal(change.to, "0.1.1");
    }
  });

  it("não toca em dependências externas nem em versões já normais", () => {
    const input = manifest({
      dependencies: {
        "@cybersafe/core": "0.1.1",
        express: "^4.19.2",
        "better-sqlite3": "^11.3.0",
      },
      devDependencies: { typescript: "^5.9.3" },
    });
    const { manifest: out, changes } = normalizeStagingRefs(input, opts);
    assert.deepEqual(out.dependencies, {
      "@cybersafe/core": "0.1.1",
      express: "^4.19.2",
      "better-sqlite3": "^11.3.0",
    });
    assert.deepEqual(out.devDependencies, { typescript: "^5.9.3" });
    assert.deepEqual(changes, []);
  });

  it("ignora tarballs que NÃO são do staging desta execução", () => {
    const input = manifest({
      dependencies: {
        "@cybersafe/core": "file:C:/outro/sitio/cybersafe-core-0.1.1.tgz",
        "@cybersafe/service": "file:../tarballs/cybersafe-service-0.1.1.tgz",
        api: `file:${path.join(TARBALL_DIR, "api-0.1.1.tgz")}.bak`,
      },
    });
    const { manifest: out, changes } = normalizeStagingRefs(input, opts);
    assert.deepEqual(out.dependencies, input.dependencies, "só o staging desta execução é tocado");
    assert.deepEqual(changes, []);
  });

  it("não inventa versões: sem versão verificada, falha em vez de adivinhar", () => {
    const input = manifest({ dependencies: { "@cybersafe/core": ref("cybersafe-core-0.1.1.tgz") } });
    assert.throws(
      () => normalizeStagingRefs(input, { ...opts, versions: {} }),
      /sem versão verificada para @cybersafe\/core/,
    );
    assert.throws(
      () => normalizeStagingRefs(input, { ...opts, versions: { "@cybersafe/core": "" } }),
      /sem versão verificada/,
    );
    assert.throws(
      () => normalizeStagingRefs(input, { ...opts, versions: { "@cybersafe/core": ref("x.tgz") } }),
      /sem versão verificada/,
      "uma versão que é ela própria um caminho não serve",
    );
  });

  it("é puro: o manifesto de entrada não é alterado", () => {
    const input = manifest({ dependencies: { "@cybersafe/core": ref("cybersafe-core-0.1.1.tgz") } });
    const snapshot = JSON.stringify(input);
    normalizeStagingRefs(input, opts);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it("reconhece barras e maiúsculas (Windows), nos três blocos de dependências", () => {
    const upper = ref("cybersafe-core-0.1.1.tgz").toUpperCase().replace(/^FILE:/, "file:");
    const input = {
      dependencies: { "@cybersafe/core": upper },
      devDependencies: { "@cybersafe/service": ref("cybersafe-service-0.1.1.tgz") },
      optionalDependencies: { api: ref("api-0.1.1.tgz") },
    };
    const { manifest: out, changes } = normalizeStagingRefs(input, opts);
    assert.equal(out.dependencies["@cybersafe/core"], "0.1.1");
    assert.equal(out.devDependencies["@cybersafe/service"], "0.1.1");
    assert.equal(out.optionalDependencies.api, "0.1.1");
    assert.equal(changes.length, 3);
  });
});

// ── B. Árvore instalada real (num %TEMP% nosso, nunca no repo) ───────────────
let root;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeTree({ externalWithRef = false, missingInternal = null } = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-7h-refs-"));
  writeJson(path.join(appDir, "package.json"), manifest({
    dependencies: {
      "@cybersafe/core": ref("cybersafe-core-0.1.1.tgz"),
      "@cybersafe/shared-types": ref("cybersafe-shared-types-0.1.1.tgz"),
      "@cybersafe/service": ref("cybersafe-service-0.1.1.tgz"),
      api: ref("api-0.1.1.tgz"),
      express: "^4.19.2",
    },
  }));
  const internals = {
    "@cybersafe/core": { dependencies: { "@cybersafe/shared-types": ref("cybersafe-shared-types-0.1.1.tgz") } },
    "@cybersafe/shared-types": { dependencies: {} },
    "@cybersafe/native-windows": { dependencies: { "@cybersafe/shared-types": ref("cybersafe-shared-types-0.1.1.tgz") } },
    "@cybersafe/service": {
      dependencies: {
        "@cybersafe/core": ref("cybersafe-core-0.1.1.tgz"),
        "@cybersafe/native-windows": ref("cybersafe-native-windows-0.1.1.tgz"),
        "@cybersafe/shared-types": ref("cybersafe-shared-types-0.1.1.tgz"),
      },
    },
    api: { dependencies: { "@cybersafe/shared-types": ref("cybersafe-shared-types-0.1.1.tgz") } },
  };
  for (const [name, extra] of Object.entries(internals)) {
    if (name === missingInternal) continue;
    writeJson(path.join(appDir, "node_modules", name, "package.json"), {
      name,
      version: "0.1.1",
      ...extra,
    });
  }
  writeJson(path.join(appDir, "node_modules", "express", "package.json"), {
    name: "express",
    version: "4.19.2",
    dependencies: { ...(externalWithRef ? { "@cybersafe/core": ref("cybersafe-core-0.1.1.tgz") } : {}) },
  });
  return appDir;
}

after(() => {
  if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

describe("normalizeStagingRefsUnderApp (árvore instalada)", () => {
  before(() => {
    root = makeTree();
  });

  it("lê a versão REAL de cada pacote instalado (não confia no nome do tarball)", () => {
    const found = readInstalledVersions(root, INTERNAL);
    assert.deepEqual(found, {
      "@cybersafe/core": "0.1.1",
      "@cybersafe/shared-types": "0.1.1",
      "@cybersafe/service": "0.1.1",
      api: "0.1.1",
    });
  });

  it("FALHA se um pacote interno não estiver instalado (inclusão de dependências é pré-requisito)", () => {
    const broken = makeTree({ missingInternal: "@cybersafe/service" });
    try {
      assert.throws(() => readInstalledVersions(broken, INTERNAL), /@cybersafe\/service não está instalado/);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });

  it("normaliza o manifesto raiz E os manifestos internos instalados", () => {
    const result = normalizeStagingRefsUnderApp({
      appDir: root,
      tarballDir: TARBALL_DIR,
      internalNames: [...INTERNAL, "@cybersafe/native-windows"],
    });
    assert.ok(result.changedFiles.length >= 5, `esperava root + internos, veio ${result.changedFiles.join(", ")}`);
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

    const appManifest = read(path.join(root, "package.json"));
    assert.equal(appManifest.dependencies["@cybersafe/core"], "0.1.1");
    assert.equal(appManifest.dependencies["@cybersafe/shared-types"], "0.1.1");
    assert.equal(appManifest.dependencies.api, "0.1.1");
    assert.equal(appManifest.dependencies.express, "^4.19.2", "dependência externa intocada");

    const service = read(path.join(root, "node_modules", "@cybersafe", "service", "package.json"));
    assert.deepEqual(service.dependencies, {
      "@cybersafe/core": "0.1.1",
      "@cybersafe/native-windows": "0.1.1",
      "@cybersafe/shared-types": "0.1.1",
    });
    assert.equal(service.version, "0.1.1", "a identidade do pacote instalado não é mexida");

    for (const leftover of ["package.json", "node_modules/@cybersafe/service/package.json"]) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, leftover), "utf8"), /cybersafe-package-/, leftover);
    }
  });

  it("é idempotente: a segunda passagem não muda nada", () => {
    const again = normalizeStagingRefsUnderApp({
      appDir: root,
      tarballDir: TARBALL_DIR,
      internalNames: [...INTERNAL, "@cybersafe/native-windows"],
    });
    assert.deepEqual(again.changedFiles, []);
  });

  it("BITE: uma referência de staging num manifesto EXTERNO faz falhar, em vez de viajar calada", () => {
    const withExternal = makeTree({ externalWithRef: true });
    const all = [...INTERNAL, "@cybersafe/native-windows"];
    try {
      assert.throws(
        () => normalizeStagingRefsUnderApp({
          appDir: withExternal,
          tarballDir: TARBALL_DIR,
          internalNames: all,
        }),
        (error) => {
          assert.match(error.message, /node_modules[\\/]express[\\/]package\.json/, "o erro tem de nomear o ficheiro");
          assert.match(error.message, /cybersafe-package-/, "e mostrar a referência que sobrou");
          return true;
        },
      );
      const express = JSON.parse(
        fs.readFileSync(path.join(withExternal, "node_modules", "express", "package.json"), "utf8"),
      );
      assert.match(express.dependencies["@cybersafe/core"], /cybersafe-package-/, "não se reescreve o manifesto de terceiros");
    } finally {
      fs.rmSync(withExternal, { recursive: true, force: true });
    }
  });
});
