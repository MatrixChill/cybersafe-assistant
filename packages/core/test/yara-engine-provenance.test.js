import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PROVENIÊNCIA DO MOTOR YARA — a regressão que o bloqueador ascii_tree expôs.
 *
 * O código executável foi migrado para o YARA clássico oficial (processo
 * externo). O binding Node-API @litko/yara-x arrastava a cadeia Rust
 * yara-x-parser → ascii_tree 0.1.1, cujo aviso de copyright nunca foi publicado.
 *
 * Este teste fecha a porta a uma reintrodução silenciosa:
 *   1. o manifesto do core não declara @litko/yara-x;
 *   2. o dist compilado importa yara-classic e não referencia @litko;
 *   3. os binários classic vendorizados correspondem ao VENDOR.json publicado
 *      (versão, bytes e sha256), incluindo o COPYING.txt.
 *
 * Não é um teste de deteção: o scan real está em yara-classic-engine.test.js.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(here, "..");
const vendorDir = path.resolve(coreDir, "..", "..", "vendor", "yara");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("proveniência do motor YARA — clássico, sem binding Node-API", () => {
  test("o manifesto do core não declara @litko/yara-x", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(coreDir, "package.json"), "utf8"));
    assert.equal(pkg.dependencies?.["@litko/yara-x"], undefined);
    assert.equal(pkg.optionalDependencies?.["@litko/yara-x"], undefined);
  });

  test("o dist compilado usa yara-classic e não importa @litko", () => {
    const yara = fs.readFileSync(path.join(coreDir, "dist", "yara.js"), "utf8");
    const classic = fs.readFileSync(path.join(coreDir, "dist", "yara-classic.js"), "utf8");
    assert.match(yara, /yara-classic/);
    assert.ok(!yara.includes("@litko"), "dist/yara.js ainda referencia o binding removido");
    assert.ok(!classic.includes("@litko"), "dist/yara-classic.js ainda referencia o binding removido");
    assert.match(classic, /yara64\.exe/);
    assert.match(classic, /yarac64\.exe/);
  });

  test("os binários vendorizados correspondem ao VENDOR.json (4.6.0)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, "VENDOR.json"), "utf8"));
    assert.equal(manifest.engine, "yara-classic");
    assert.equal(manifest.version, "4.6.0");
    assert.equal(manifest.license, "BSD-3-Clause");
    for (const entry of manifest.files) {
      const file = path.join(vendorDir, entry.path);
      assert.equal(fs.statSync(file).size, entry.bytes, `${entry.path}: bytes diferentes do manifesto`);
      assert.equal(sha256(file), entry.sha256, `${entry.path}: sha256 diferente do manifesto`);
    }
  });

  test("o COPYING.txt vendorizado é o aviso BSD-3-Clause publicado", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, "VENDOR.json"), "utf8"));
    const copying = fs.readFileSync(path.join(vendorDir, "COPYING.txt"), "utf8");
    assert.equal(sha256(path.join(vendorDir, "COPYING.txt")), manifest.licenseText.sha256);
    assert.match(copying, /BSD 3-Clause|Redistribution and use/i);
    assert.match(copying, /Copyright/i);
  });
});
