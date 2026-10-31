/**
 * Semente ClamAV: hashes oficiais fixados neste candidato.
 *
 * A cache oficial foi verificada em 2026-10-29 (RESOURCE-MANIFEST.json) e os
 * três ficheiros foram re-medidos agora. O pipeline NÃO descarrega a base; esta
 * lista é a âncora de confiança do build e é verificada byte a byte.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CLAMAV_SEED_SCHEMA = "cybersafe.clamav-seed/v1";
export const CLAMAV_SEED_MANIFEST_FILENAME = "SEED-MANIFEST.json";
export const CLAMAV_SEED_LICENSE_FILENAME = "COPYING.txt";
export const CLAMAV_SEED_VERSION = "1.5.4";

export const EXPECTED_CLAMAV_SEED = Object.freeze({
  "main.cvd": Object.freeze({
    bytes: 89_072_577,
    sha256: "0b2182d229f46981ec8f535382222f7c9dfdd656b250ad47988b910a8d302365",
  }),
  "daily.cld": Object.freeze({
    bytes: 86_543_360,
    sha256: "b93e7f501ac1cf9cc5858393609a8a7a683e770e02cf0d8e89dcdfa15bf88e00",
  }),
  "bytecode.cvd": Object.freeze({
    bytes: 281_702,
    sha256: "6d4aa01f219e988060fc419f495d07f27e0cdf1a2cccc065971da922c76f7ffb",
  }),
  "COPYING.txt": Object.freeze({
    bytes: 18_738,
    sha256: "0c4fd2fa9733fc9122503797648710851e4ee6d9e4969dd33fcbd8c63cd2f584",
  }),
});

const ALLOWED = new Set([CLAMAV_SEED_MANIFEST_FILENAME, ...Object.keys(EXPECTED_CLAMAV_SEED)]);

export function sha256FileSync(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex").toLowerCase();
}

function regularFile(file, problems) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    problems.push(`ausente: ${path.basename(file)}`);
    return null;
  }
  if (stat.isSymbolicLink()) {
    problems.push(`link recusado: ${path.basename(file)}`);
    return null;
  }
  if (!stat.isFile()) {
    problems.push(`não é ficheiro regular: ${path.basename(file)}`);
    return null;
  }
  return stat;
}

/**
 * Verifica o directório EXACTO que o extraResources copia. A allowlist é plana:
 * um ficheiro extra, um subdirectório, uma colisão de maiúsculas ou um link
 * fazem o bundle falhar. A existência de três nomes não prova o conteúdo.
 */
export function verifyClamavSeedBundle(dir, { expected = EXPECTED_CLAMAV_SEED } = {}) {
  const problems = [];
  const manifestPath = path.join(dir, CLAMAV_SEED_MANIFEST_FILENAME);
  let entries;
  try {
    for (let parent = path.resolve(dir); ; parent = path.dirname(parent)) {
      const stat = fs.lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, dir, manifestPath, filesChecked: 0, bytesChecked: 0, version: CLAMAV_SEED_VERSION, problems: ["raiz/parent não regular"] };
      if (path.dirname(parent) === parent) break;
    }
    const root = fs.lstatSync(dir);
    if (root.isSymbolicLink() || !root.isDirectory()) {
      return { ok: false, dir, manifestPath, filesChecked: 0, bytesChecked: 0, version: CLAMAV_SEED_VERSION, problems: ["raiz não é um directório regular"] };
    }
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: false, dir, manifestPath, filesChecked: 0, bytesChecked: 0, version: CLAMAV_SEED_VERSION, problems: ["directório ausente ou ilegível"] };
  }
  const seen = new Set();
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      problems.push(`entrada não regular: ${entry.name}`);
      continue;
    }
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      problems.push(`colisão de maiúsculas/minúsculas: ${entry.name}`);
      continue;
    }
    seen.add(key);
    if (!ALLOWED.has(entry.name)) problems.push(`ficheiro extra não listado: ${entry.name}`);
  }
  if (problems.length) return { ok: false, dir, manifestPath, filesChecked: 0, bytesChecked: 0, version: CLAMAV_SEED_VERSION, problems };
  if (!regularFile(manifestPath, problems)) return { ok: false, dir, manifestPath, filesChecked: 0, bytesChecked: 0, version: CLAMAV_SEED_VERSION, problems };
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    problems.push("manifesto ausente ou não é JSON");
  }
  if (manifest) {
    if (manifest.schema !== CLAMAV_SEED_SCHEMA) problems.push(`schema inválido: ${String(manifest.schema)}`);
    if (manifest.engine !== "ClamAV") problems.push(`engine inválido: ${String(manifest.engine)}`);
    if (manifest.binaryVersion !== CLAMAV_SEED_VERSION) problems.push(`versão inválida: ${String(manifest.binaryVersion)}`);
    const declared = new Map();
    if (Array.isArray(manifest.files)) {
      for (const entry of manifest.files) {
        if (!entry || typeof entry.name !== "string" || declared.has(entry.name)) {
          problems.push("entrada de manifesto duplicada ou inválida");
          continue;
        }
        declared.set(entry.name, entry);
      }
    }
    const declaredNames = Object.keys(expected).filter((name) => name !== CLAMAV_SEED_LICENSE_FILENAME);
    for (const name of declaredNames) {
      const entry = declared.get(name);
      if (!entry) {
        problems.push(`manifesto não declara: ${name}`);
        continue;
      }
      if (entry.bytes !== expected[name].bytes || String(entry.sha256).toLowerCase() !== expected[name].sha256) {
        problems.push(`manifesto diverge do hash fixado: ${name}`);
      }
    }
    if (declared.size !== declaredNames.length) problems.push("manifesto declara ficheiros a mais");
    if (!manifest.license || manifest.license.file !== CLAMAV_SEED_LICENSE_FILENAME || String(manifest.license.sha256).toLowerCase() !== expected[CLAMAV_SEED_LICENSE_FILENAME].sha256) {
      problems.push("licença COPYING.txt ausente do manifesto ou com hash divergente");
    }
  }
  let filesChecked = 0;
  let bytesChecked = 0;
  for (const [name, expectedEntry] of Object.entries(expected)) {
    const filePath = path.join(dir, name);
    const file = regularFile(filePath, problems);
    if (!file) continue;
    filesChecked += 1;
    bytesChecked += file.size;
    if (file.size !== expectedEntry.bytes) problems.push(`tamanho divergente: ${name}`);
    if (sha256FileSync(filePath) !== expectedEntry.sha256) problems.push(`sha256 divergente: ${name}`);
  }
  return {
    ok: problems.length === 0,
    dir,
    manifestPath,
    filesChecked,
    bytesChecked,
    version: CLAMAV_SEED_VERSION,
    problems: [...new Set(problems)],
  };
}

/** Constrói um manifesto a partir dos ficheiros fixados; usado pelo preparador. */
export function buildSeedManifest({ source }) {
  return {
    schema: CLAMAV_SEED_SCHEMA,
    engine: "ClamAV",
    binaryVersion: CLAMAV_SEED_VERSION,
    generatedAt: new Date().toISOString(),
    provenance: source,
    authenticationLimit: "Os SHA-256 confirmam a identidade dos ficheiros; não são uma assinatura independente da base.",
    license: { name: "GPL-2.0-only", file: CLAMAV_SEED_LICENSE_FILENAME, sha256: EXPECTED_CLAMAV_SEED[CLAMAV_SEED_LICENSE_FILENAME].sha256 },
    files: Object.entries(EXPECTED_CLAMAV_SEED)
      .filter(([name]) => name !== CLAMAV_SEED_LICENSE_FILENAME)
      .map(([name, entry]) => ({ name, bytes: entry.bytes, sha256: entry.sha256 })),
  };
}
