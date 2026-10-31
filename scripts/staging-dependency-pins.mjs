/**
 * Versões EXACTAS que a árvore de staging tem de instalar (TP-QA2-PACKAGING-ENGINES).
 *
 * CAUSA MEDIDA (candidata QA1, 2026-10-25): o staging corre
 * `npm install --omit=dev` numa árvore criada fora do repositório e SEM o
 * `package-lock.json` do projecto. Os manifestos dos workspaces declaravam
 * intervalos (`better-sqlite3: ^12.10.0`, `@litko/yara-x: ^0.5.0`), por isso o
 * npm resolveu fora do lock e o pacote saiu com versões que o lock e os textos
 * de licença documentados não cobrem:
 *
 *   better-sqlite3       lock/U 12.10.0  →  payload QA1 12.11.1
 *   @litko/yara-x        lock/U  0.5.0   →  payload QA1  0.5.2
 *   @litko/yara-x-win32-x64-msvc  lock 0.5.0 → payload QA1 0.5.1
 *
 * Correção: os manifestos dos workspaces passam a declarar a versão exacta do
 * lock (`assertPinnedManifestSpecs`) e o pipeline MEDE a árvore instalada
 * depois do `npm install` (`verifyStagedVersions`), falhando fechado em deriva.
 * Não se reescreve o lock, não se inventa versão documental e não se declara
 * cobertura de licença para uma versão diferente da comprovada.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Dependências sob pin. `candidates` são os caminhos onde o npm pode instalar o
 * manifesto (o binário de plataforma pode ficar içado ou aninhado no wrapper);
 * `platforms` restringe as entradas específicas de plataforma.
 */
export const STAGING_VERSION_PINS = [
  {
    name: "better-sqlite3",
    ownerManifest: "packages/api/package.json",
    reason: "QA1 instalou 12.11.1 a partir de `^12.10.0` sem lock no staging; o lock e a verificação de ABI usam 12.10.0",
    candidates: ["node_modules/better-sqlite3/package.json"],
  },
  {
    name: "@litko/yara-x",
    ownerManifest: "packages/core/package.json",
    reason: "QA1 instalou 0.5.2 a partir de `^0.5.0`; o lock e os avisos (PROVENANCE/THIRD-PARTY-NOTICES) documentam 0.5.0",
    candidates: ["node_modules/@litko/yara-x/package.json"],
  },
  {
    name: "@litko/yara-x-win32-x64-msvc",
    reason: "binário nativo do wrapper; QA1 instalou 0.5.1 e os avisos documentam 0.5.0",
    candidates: [
      "node_modules/@litko/yara-x-win32-x64-msvc/package.json",
      "node_modules/@litko/yara-x/node_modules/@litko/yara-x-win32-x64-msvc/package.json",
    ],
    platforms: [{ os: "win32", cpu: "x64" }],
  },
];

/** Pins aplicáveis à plataforma pedida (por omissão, a do processo actual). */
export function applicableStagingPins({ platform = process.platform, arch = process.arch } = {}) {
  return STAGING_VERSION_PINS.filter((pin) => {
    if (!pin.platforms) return true;
    return pin.platforms.some((entry) => entry.os === platform && entry.cpu === arch);
  });
}

/**
 * Versão exacta de cada pin tal como está resolvida no lock do repositório.
 * O lock é a única fonte: um pin sem entrada no lock FALHA (não se adivinha).
 */
export function readLockedVersions({ lockFile, pins = STAGING_VERSION_PINS } = {}) {
  if (!lockFile) throw new Error("readLockedVersions: lockFile obrigatório");
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const packages = lock.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error(`lock sem a chave "packages": ${lockFile}`);
  }
  const versions = {};
  for (const pin of pins) {
    const entry = packages[`node_modules/${pin.name}`];
    if (!entry || typeof entry.version !== "string" || entry.version.trim() === "") {
      throw new Error(`sem versão no lock para ${pin.name}: o pin não pode ser verificado`);
    }
    versions[pin.name] = entry.version;
  }
  return versions;
}

/**
 * Estrutura de trabalho do pipeline: pins aplicáveis + versão esperada.
 * Devolve `[{ name, version, candidates, reason }]`.
 */
export function expectedStagingVersions({
  lockFile,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const pins = applicableStagingPins({ platform, arch });
  const versions = readLockedVersions({ lockFile, pins });
  return pins.map((pin) => ({
    name: pin.name,
    version: versions[pin.name],
    candidates: pin.candidates,
    reason: pin.reason ?? null,
  }));
}

/**
 * Os manifestos dos workspaces têm de declarar a versão EXACTA do lock (sem
 * `^`/`~`). Sem isto, cada `npm install` do staging volta a resolver fora do
 * lock e a deriva só apareceria no payload final.
 */
export function assertPinnedManifestSpecs({ root, lockFile } = {}) {
  if (!root) throw new Error("assertPinnedManifestSpecs: root obrigatório");
  const pins = STAGING_VERSION_PINS.filter((pin) => pin.ownerManifest);
  const versions = readLockedVersions({ lockFile: lockFile ?? path.join(root, "package-lock.json"), pins });
  const checks = [];
  const problems = [];
  for (const pin of pins) {
    const file = path.join(root, pin.ownerManifest);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      problems.push({ name: pin.name, file, spec: null, expected: versions[pin.name], detail: `manifesto ilegível: ${error.message}` });
      continue;
    }
    const spec = manifest.dependencies?.[pin.name] ?? null;
    const expected = versions[pin.name];
    const ok = spec === expected;
    checks.push({ name: pin.name, file, spec, expected, ok });
    if (!ok) {
      problems.push({
        name: pin.name,
        file,
        spec,
        expected,
        detail: spec === null
          ? `${pin.name} não está declarado em dependencies`
          : `spec "${spec}" não é a versão exacta do lock "${expected}"`,
      });
    }
  }
  return { ok: problems.length === 0, checks, problems };
}

/**
 * Mede a árvore instalada do staging. FALHA FECHADO em qualquer deriva,
 * ausência ou manifesto ilegível: uma versão diferente da fixada invalida a
 * correspondência documental e a ABI medida.
 */
export function verifyStagedVersions(appDir, expected) {
  if (!appDir) throw new Error("verifyStagedVersions: appDir obrigatório");
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error("verifyStagedVersions: lista de versões esperadas vazia");
  }
  const checked = [];
  const drift = [];
  for (const pin of expected) {
    const found = (pin.candidates ?? []).map((relative) => path.join(appDir, ...relative.split("/"))).find((file) => fs.existsSync(file));
    if (!found) {
      drift.push({ name: pin.name, expected: pin.version, actual: null, file: null, detail: "não instalado no staging" });
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(found, "utf8"));
    } catch (error) {
      drift.push({ name: pin.name, expected: pin.version, actual: null, file: found, detail: `manifesto ilegível: ${error.message}` });
      continue;
    }
    const actual = typeof manifest.version === "string" ? manifest.version : null;
    checked.push({ name: pin.name, expected: pin.version, actual, file: found });
    if (actual !== pin.version) {
      drift.push({ name: pin.name, expected: pin.version, actual, file: found, detail: "versão instalada diferente da fixada" });
    }
  }
  return { ok: drift.length === 0, checked, drift };
}

/** Mensagem única e legível para o log/erro do pipeline. */
export function describeStagingDrift(verification) {
  return verification.drift
    .map((entry) => `${entry.name}: esperado ${entry.expected}, instalado ${entry.actual ?? "ausente"}${entry.file ? ` (${entry.file})` : ""}`)
    .join("; ");
}
