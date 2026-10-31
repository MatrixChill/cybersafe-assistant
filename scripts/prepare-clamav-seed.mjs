#!/usr/bin/env node
/**
 * Prepara a semente ClamAV a partir da cache oficial JÁ VERIFICADA.
 *
 * Uso:
 *   node scripts/prepare-clamav-seed.mjs --source <cache> --out <pasta> [--license vendor/clamav/COPYING.txt]
 *   node scripts/prepare-clamav-seed.mjs --check --out <pasta>
 *
 * Não descarrega nada. Só copia os três ficheiros e a licença cujos SHA-256
 * estão fixados em `scripts/clamav-seed-bundle.mjs`; qualquer divergência
 * aborta antes de produzir um bundle que pudesse entrar no setup.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAMAV_SEED_LICENSE_FILENAME,
  CLAMAV_SEED_MANIFEST_FILENAME,
  EXPECTED_CLAMAV_SEED,
  buildSeedManifest,
  sha256FileSync,
  verifyClamavSeedBundle,
} from "./clamav-seed-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return "Uso: node scripts/prepare-clamav-seed.mjs --source <cache> --out <pasta> [--license vendor/clamav/COPYING.txt] | --check --out <pasta>";
}
function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(usage());
  process.exit(0);
}
const out = value("--out");
if (!out || !path.isAbsolute(out)) {
  console.error("--out absoluto é obrigatório");
  console.error(usage());
  process.exit(2);
}
if (process.argv.includes("--check")) {
  const result = verifyClamavSeedBundle(out);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
const source = value("--source");
if (!source || !path.isAbsolute(source)) {
  console.error("--source absoluto é obrigatório (cache oficial verificada)");
  console.error(usage());
  process.exit(2);
}
const license = path.resolve(value("--license") ?? path.join(ROOT, "vendor", "clamav", "COPYING.txt"));

for (const [name, expected] of Object.entries(EXPECTED_CLAMAV_SEED)) {
  const file = name === CLAMAV_SEED_LICENSE_FILENAME ? license : path.join(source, name);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    console.error(`FALTA ${name}: ${file}`);
    process.exit(1);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    console.error(`RECUSADO ${name}: não é ficheiro regular`);
    process.exit(1);
  }
  if (stat.size !== expected.bytes || sha256FileSync(file) !== expected.sha256) {
    console.error(`DIVERGENTE ${name}: tamanho/hash não correspondem ao cache verificado`);
    process.exit(1);
  }
}

fs.mkdirSync(out, { recursive: true });
for (const name of Object.keys(EXPECTED_CLAMAV_SEED)) {
  const from = name === CLAMAV_SEED_LICENSE_FILENAME ? license : path.join(source, name);
  fs.copyFileSync(from, path.join(out, name));
}
const manifest = buildSeedManifest({ source: "cache oficial freshclam verificada; hashes fixados no scripts/clamav-seed-bundle.mjs" });
fs.writeFileSync(path.join(out, CLAMAV_SEED_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
const result = verifyClamavSeedBundle(out);
console.log(JSON.stringify({ ok: result.ok, out, filesChecked: result.filesChecked, bytesChecked: result.bytesChecked, version: result.version, problems: result.problems }, null, 2));
process.exit(result.ok ? 0 : 1);
