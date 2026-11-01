/**
 * GATE DO VENDOR YARA — bytes, não nomes.
 *
 * A VM016 falhou com STATUS_DLL_NOT_FOUND porque o `yarac64.exe` importa
 * VCRUNTIME140.dll e o runtime não viajava ao lado do executável. Este teste
 * mede o contrato que impede a repetição:
 *   • os quatro ficheiros obrigatórios estão no VENDOR.json e no disco;
 *   • bytes e sha256 de cada um coincidem com o manifesto;
 *   • o runtime app-local é obrigatório, não opcional;
 *   • um byte alterado ou um ficheiro ausente falham FECHADO.
 *
 * Uso: node --test scripts/test/7h-yara-vendor.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import { verifyYaraVendor } from "../package-windows.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const VENDOR = path.join(REPO_ROOT, "vendor", "yara");

function tempCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yara-vendor-"));
  fs.cpSync(VENDOR, dir, { recursive: true });
  // `os.tmpdir()` no runner do GitHub vem em forma 8.3 (`C:\Users\RUNNER~1\...`).
  // O portão de contenção do vendor recusa qualquer caminho cujo realpath não
  // coincida com o caminho pedido — comportamento correto e *fail-closed*, que a
  // fixture tem de respeitar: entrega-se o caminho canónico, não se afrouxa o
  // portão. Em Linux/macOS e nesta máquina o realpath é o próprio caminho.
  return fs.realpathSync.native(dir);
}

describe("vendor/yara — integridade medida", () => {
  it("aceita o vendor real, com os 4 ficheiros e o runtime app-local", () => {
    const report = verifyYaraVendor();
    assert.equal(report.ok, true, report.problems.join("; "));
    assert.equal(report.version, "4.6.0");
    assert.equal(report.filesChecked, 4);
    assert.equal(report.runtimeBundled, true);
    assert.ok(report.bytesChecked > 4_000_000);
  });

  it("recusa um único byte alterado num executável", () => {
    const dir = tempCopy();
    try {
      const file = path.join(dir, "yara64.exe");
      const fd = fs.openSync(file, "r+");
      const before = Buffer.alloc(1);
      fs.readSync(fd, before, 0, 1, 0);
      fs.writeSync(fd, Buffer.from([before[0] ^ 0xff]), 0, 1, 0);
      fs.closeSync(fd);
      const report = verifyYaraVendor({ dir });
      assert.equal(report.ok, false);
      assert.ok(report.problems.some((problem) => problem.includes("yara64.exe") && problem.includes("sha256")), report.problems.join("; "));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa a ausência do runtime VCRUNTIME140 (causa VM016)", () => {
    const dir = tempCopy();
    try {
      fs.rmSync(path.join(dir, "vcruntime140.dll"));
      const report = verifyYaraVendor({ dir });
      assert.equal(report.ok, false);
      assert.equal(report.runtimeBundled, false);
      assert.ok(report.problems.some((problem) => problem.includes("vcruntime140.dll")), report.problems.join("; "));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa um manifesto que não descreva os ficheiros obrigatórios", () => {
    const dir = tempCopy();
    try {
      const manifestPath = path.join(dir, "VENDOR.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.files = manifest.files.filter((entry) => entry.path !== "COPYING.txt");
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const report = verifyYaraVendor({ dir, manifestPath });
      assert.equal(report.ok, false);
      assert.ok(report.problems.some((problem) => problem.includes("COPYING.txt")), report.problems.join("; "));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa um ficheiro EXTRA (o extraResources copia o directório inteiro)", () => {
    const dir = tempCopy();
    try {
      fs.writeFileSync(path.join(dir, "extra.dll"), "nao listado");
      const report = verifyYaraVendor({ dir });
      assert.equal(report.ok, false);
      assert.ok(
        report.problems.some((problem) => problem.includes("extra.dll") && problem.includes("extra")),
        report.problems.join("; "),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa duplicado/colisão de maiúsculas no manifesto", () => {
    const dir = tempCopy();
    try {
      const manifestPath = path.join(dir, "VENDOR.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const yara = manifest.files.find((entry) => entry.path === "yara64.exe");
      manifest.files.push({ ...yara, path: "YARA64.EXE" });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const report = verifyYaraVendor({ dir, manifestPath });
      assert.equal(report.ok, false);
      assert.ok(
        report.problems.some((problem) => problem.includes("duplicada") || problem.includes("colisão")),
        report.problems.join("; "),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa junction dentro do vendor (não segue para fora)", () => {
    const dir = tempCopy();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yara-outside-"));
    const link = path.join(dir, "link");
    try {
      fs.writeFileSync(path.join(outside, "fora.txt"), "fora do vendor");
      fs.symlinkSync(outside, link, "junction");
      const report = verifyYaraVendor({ dir });
      assert.equal(report.ok, false);
      assert.ok(
        report.problems.some((problem) => problem.includes("link") || problem.includes("junction")),
        report.problems.join("; "),
      );
    } finally {
      try {
        fs.rmdirSync(link);
      } catch {}
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa um subdirectório VAZIO (não tem ficheiros para comparar)", () => {
    const dir = tempCopy();
    try {
      fs.mkdirSync(path.join(dir, "empty-dir"));
      const report = verifyYaraVendor({ dir });
      assert.equal(report.ok, false);
      assert.ok(
        report.problems.some((problem) => problem.includes("empty-dir") && problem.includes("subdirectório")),
        report.problems.join("; "),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
