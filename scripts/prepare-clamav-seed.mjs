#!/usr/bin/env node
/** Diagnostic only: no automatic publication until a reviewed native boundary exists. */
import path from "node:path";
import { verifyClamavSeedBundle } from "./clamav-seed-bundle.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Uso: node scripts/prepare-clamav-seed.mjs --check --out <pasta absoluta> (apenas inspeção; escrita bloqueada)");
  process.exit(0);
}
if (!args.includes("--check")) {
  console.error("CLAMAV_SEED_NATIVE_BOUNDARY_REQUIRED: preparação/publicação por caminhos bloqueada; nenhuma leitura ou escrita efetuada.");
  process.exit(1);
}
const index = args.indexOf("--out");
const out = index >= 0 ? args[index + 1] : undefined;
if (!out || !path.isAbsolute(out)) {
  console.error("--out absoluto é obrigatório");
  process.exit(2);
}
const result = verifyClamavSeedBundle(out);
console.log(JSON.stringify({ ...result, scope: "static cache integrity only; not a concurrent-path or publication guarantee", publicationEnabled: false }, null, 2));
process.exit(result.ok ? 0 : 1);
