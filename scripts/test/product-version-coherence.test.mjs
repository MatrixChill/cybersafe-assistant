import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION_FILE, isValidVersion, readProductVersion } from "../app-version.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

test("product-version.json é a identidade canónica e é semver válido", () => {
  const { version, channel } = readProductVersion({ root: RAIZ });
  assert.ok(isValidVersion(version), `versão inválida: ${version}`);
  assert.match(version, /^0\.2\.0/, "a Release em preparação é 0.2.0");
  assert.ok(typeof channel === "string" && channel.length > 0, "canal em falta");
  assert.ok(fs.existsSync(path.join(RAIZ, PRODUCT_VERSION_FILE)));
});

test("os pipelines de packaging derivam a versão do ficheiro canónico", () => {
  for (const rel of ["scripts/package-windows.mjs", "scripts/linux-lite/package-linux.mjs"]) {
    const fonte = ler(rel);
    assert.match(fonte, /readProductVersion/, `${rel} tem de ler a versão canónica`);
  }
  assert.match(ler("packages/app/vite.config.ts"), /CYBERSAFE_BUILD_VERSION/,
    "o renderer recebe a identidade pelo build, não do package.json");
});

test("a versão do produto não é tomada de packages/desktop/package.json", () => {
  assert.doesNotMatch(ler("scripts/package-windows.mjs"),
    /version:\s*desktopManifest\.version/, "o manifesto não pode usar a versão interna do pacote");
});
