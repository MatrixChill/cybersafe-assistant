import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
 *   3. nenhum ficheiro em src (incluindo o artefacto gerado yara.js, removido)
 *      referencia @litko;
 *   4. os binários classic vendorizados correspondem ao VENDOR.json publicado;
 *   5. o COPYING.txt é comparado pelo blob canónico (LF) e pelo conteúdo
 *      normalizado, para o resultado não depender do checkout CRLF do Windows.
 *
 * Não é um teste de deteção: o scan real está em yara-classic-engine.test.js.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(here, "..");
const repoRoot = path.resolve(coreDir, "..", "..");
const vendorDir = path.join(repoRoot, "vendor", "yara");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
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

  test("nenhum ficheiro em src referencia @litko (o artefacto gerado saiu)", () => {
    assert.equal(fs.existsSync(path.join(coreDir, "src", "yara.js")), false, "src/yara.js gerado não pode voltar");
    const offenders = walk(path.join(coreDir, "src"))
      .filter((file) => /\.(ts|tsx|js|mjs|cjs|d\.ts)$/.test(file))
      .filter((file) => fs.readFileSync(file, "utf8").includes("@litko"));
    assert.deepEqual(offenders, [], `src ainda referencia @litko: ${offenders.join(", ")}`);
  });

  test("os binários vendorizados correspondem ao VENDOR.json (4.6.0)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, "VENDOR.json"), "utf8"));
    assert.equal(manifest.engine, "yara-classic");
    assert.equal(manifest.version, "4.6.0");
    assert.equal(manifest.license, "BSD-3-Clause");
    for (const entry of manifest.files) {
      if (entry.path === "COPYING.txt") continue; // texto: coberto pelo teste do blob
      const file = path.join(vendorDir, entry.path);
      assert.equal(fs.statSync(file).size, entry.bytes, `${entry.path}: bytes diferentes do manifesto`);
      assert.equal(sha256(fs.readFileSync(file)), entry.sha256, `${entry.path}: sha256 diferente do manifesto`);
    }
  });

  test("o COPYING.txt é canónico no blob e sobrevive a checkout CRLF", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, "VENDOR.json"), "utf8"));
    const entry = manifest.files.find((item) => item.path === "COPYING.txt");
    assert.ok(entry, "COPYING.txt não está no VENDOR.json");

    let blob;
    try {
      blob = execFileSync("git", ["cat-file", "blob", ":vendor/yara/COPYING.txt"], { cwd: repoRoot });
    } catch {
      // Fonte sem .git: usa o ficheiro e normaliza; a prova do índice é
      // preferida, mas a ausência de git não pode transformar isto em skip.
      blob = fs.readFileSync(path.join(vendorDir, "COPYING.txt"));
    }
    const canonical = blob.toString("utf8").replace(/\r\n/g, "\n");
    assert.equal(Buffer.byteLength(canonical, "utf8"), entry.bytes, "bytes canónicos != declarados");
    assert.equal(sha256(Buffer.from(canonical, "utf8")), entry.sha256, "sha256 canónico != declarado");

    const working = fs.readFileSync(path.join(vendorDir, "COPYING.txt"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(sha256(Buffer.from(working, "utf8")), entry.sha256, "working tree difere do blob além do CRLF");
    assert.match(working, /Copyright \(c\) 2007-2016\. The YARA Authors\./);
  });
});
