#!/usr/bin/env node
/**
 * Empacotamento Windows do CyberSafe (P0 — instalador, 2026-10-10).
 *
 * PORQUE É QUE ISTO EXISTE (e não basta `electron-builder` a apontar para
 * packages/desktop):
 *
 * 1. As dependências de runtime são pacotes do monorepo (`@cybersafe/core`,
 *    `@cybersafe/shared-types`, `@cybersafe/service`, `api`) ligados por
 *    symlink em `node_modules`. O electron-builder segue os symlinks, recolhe os
 *    ficheiros pelo caminho REAL (fora da app dir) e rebenta ao empacotar:
 *      "…\packages\core\definitions\yara\default.yar must be under …\packages\desktop\".
 *    Também arrastaria `packages/service/logs` (249 MB de logs de runtime).
 * 2. O rebuild nativo (`@electron/rebuild`) corre IN PLACE no `node_modules` do
 *    projeto: depois de um `dist`, o `better-sqlite3` fica no ABI do Electron e o
 *    `npm run dev`/as suites deixam de arrancar (NODE_MODULE_VERSION 137 → 130).
 *    Isto foi medido a 10/10/2026 e obrigou a restaurar o binário à mão.
 *
 * Solução: construir uma ÁRVORE PRÓPRIA fora do repositório (em %TEMP%), com
 * cópias REAIS dos pacotes do workspace (via `npm pack`), e correr o
 * electron-builder contra essa árvore. O `node_modules` de DEV nunca é tocado.
 *
 * Uso:
 *   node scripts/package-windows.mjs            → instalador NSIS
 *   node scripts/package-windows.mjs --dir      → pasta win-unpacked (sem NSIS)
 *   node scripts/package-windows.mjs --keep     → mantém o staging em %TEMP% (diagnóstico)
 *   node scripts/package-windows.mjs --check    → SÓ pré-verificação (inputs + integridade
 *                                                 real do bundle ClamAV), não compila nada
 *                                                 e não descarrega nada (sem rede)
 *   node scripts/package-windows.mjs --check --json → pré-verificação legível por máquina
 *   node scripts/package-windows.mjs --help     → esta ajuda
 *
 * Semântica do staging (2026-10-13): é CRIADO em %TEMP% em cada execução real,
 * REMOVIDO no fim quando termina com sucesso, e MANTIDO quando falha (para
 * diagnóstico) ou quando é pedido `--keep`. Antes desta data o cabeçalho
 * prometia essa remoção mas o código nunca apagava nada: %TEMP% acumulava uma
 * árvore por build. O `--check` não cria staging nenhum.
 *
 * Testabilidade: `buildAppManifest()` e `preflightChecks()` são exportados para
 * que `scripts/test/7h-packaging-*.test.mjs` possa medir o contrato do manifesto
 * sem correr um build (o `--check` só mede os inputs do disco, não a forma do
 * manifesto). O pipeline em si corre apenas quando este ficheiro é o programa
 * principal.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifySourceFreeze } from "./source-freeze.mjs";
import { PRODUCT_VERSION_FILE, readProductVersion, verifyBuiltRenderer } from "./app-version.mjs";
import {
  assertPinnedManifestSpecs,
  describeStagingDrift,
  expectedStagingVersions,
  verifyStagedVersions,
} from "./staging-dependency-pins.mjs";
import { stripStagingInstallMetadata } from "./staging-install-metadata.mjs";
import { verifyClamavSeedBundle } from "./clamav-seed-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "packages", "desktop");
let outDir = path.join(desktopDir, "release");
let candidateId;

/**
 * Bundle ClamAV a publicar em `resources/clamav` (DIST-CLAMAV13OUT).
 *
 * O que vai para o pacote é o `vendor/clamav/` TAL COMO o `vendor-clamav.mjs`
 * o publicou: binários verificados + licenças + a FONTE CORRESPONDENTE
 * completa. O `--check` não confia no nome dos ficheiros — lê o `VENDOR.json`
 * e re-mede byte a byte (ver `verifyClamavBundle`).
 */
const vendorClamavDir = path.join(root, "vendor", "clamav");
const vendorManifestPath = path.join(vendorClamavDir, "VENDOR.json");
const yaraVendorDir = path.join(root, "vendor", "yara");
const VENDOR_FIX = "node scripts/vendor-clamav.mjs";
/** Metadados que o `vendor-clamav.mjs` gera e que TÊM de estar no bundle. */
const VENDOR_OFFER_NAME = "SOURCE-OFFER.txt";
// Textos e manifesto revistos: publicação explícita fora do asar.
const licensesDir = path.join(root, "assets", "licenses");
/** Seed input is diagnostic only until a reviewed native publisher exists. */
const clamavSeedDir = process.env.CYBERSAFE_CLAMAV_SEED_DIR?.trim()
  ? path.resolve(process.env.CYBERSAFE_CLAMAV_SEED_DIR)
  : null;

/**
 * npm via `node npm-cli.js`: evita o `shell` do Windows (o caminho do projeto tem
 * espaços — "garoto de programa" — e um shell a juntar argumentos parte-o).
 */
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

/** Verdadeiro só quando este módulo é corrido como programa (não quando importado). */
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// ── Configuração do pacote (exportada para os testes) ───────────────────────
// Estes são os ficheiros/diretórios que o pipeline ASSUME e o que empacota.
const WORKSPACE_PACKAGES = [
  { name: "@cybersafe/shared-types", dir: "shared-types", include: ["dist", "package.json"] },
  { name: "@cybersafe/core", dir: "core", include: ["dist", "package.json", "definitions"] },
  { name: "@cybersafe/native-windows", dir: "native-windows", include: ["dist", "package.json"] },
  { name: "@cybersafe/service", dir: "service", include: ["dist", "package.json", "definitions"] },
  { name: "api", dir: "api", include: ["dist", "package.json"] },
];

// Ordem: cada pacote depois das suas dependências de workspace.
const BUILD_WORKSPACES = [
  "@cybersafe/shared-types",
  "@cybersafe/native-windows",
  "@cybersafe/core",
  "@cybersafe/service",
  "api",
];

const PREFLIGHT = [
  { id: "manifesto:@cybersafe/desktop", path: path.join(desktopDir, "package.json"), fix: "repor packages/desktop/package.json" },
  { id: "npm-cli.js", path: npmCli, fix: "instalar Node/npm (o npm-cli.js vem com o Node)" },
  { id: "electron instalado", path: path.join(root, "node_modules", "electron", "package.json"), fix: "npm install (na raiz do repo)" },
  { id: "electron-builder instalado", path: path.join(root, "node_modules", "electron-builder", "cli.js"), fix: "npm install (na raiz do repo)" },
  { id: "renderer:@cybersafe/desktop/dist", path: path.join(desktopDir, "dist"), fix: "node scripts/stage-renderer.mjs" },
  { id: "icone:icon.ico", path: path.join(desktopDir, "src", "assets", "icon.ico"), fix: "repor packages/desktop/src/assets/icon.ico" },
  {
    id: "binario:scan-engine.exe",
    path: path.join(root, "packages", "native-engine", "build", "Release", "scan-engine.exe"),
    fix: "npm run build:native",
  },
  // Bundle ClamAV: existe ⇒ o pacote leva motor. Sem ele, `resources/clamav`
  // não é publicado e o pin do desktop fica sem efeito (falha FECHADA: o
  // serviço cai no PATH, como antes).
  // Motor YARA clássico: sem estes binários o serviço fica sem análise por
  // regras. O payload 0.1.9 provou que `resources/yara` é o caminho procurado
  // por `resolveYaraClassicBinaries()`; o pipeline tem de o publicar.
  { id: "binario:yara64.exe", path: path.join(root, "vendor", "yara", "yara64.exe"), fix: "repor vendor/yara (YARA 4.6.0 oficial + VENDOR.json)" },
  { id: "binario:yarac64.exe", path: path.join(root, "vendor", "yara", "yarac64.exe"), fix: "repor vendor/yara (YARA 4.6.0 oficial + VENDOR.json)" },
  { id: "licenca:yara/COPYING.txt", path: path.join(root, "vendor", "yara", "COPYING.txt"), fix: "repor vendor/yara/COPYING.txt (BSD-3-Clause do upstream)" },
  { id: "binario:yara/vcruntime140.dll", path: path.join(root, "vendor", "yara", "vcruntime140.dll"), fix: "repor vendor/yara/vcruntime140.dll (MSVC 2015-2022 x64, assinado)" },
  { id: "bundle-clamav:VENDOR.json", path: vendorManifestPath, fix: VENDOR_FIX },
  { id: "bundle-clamav:clamscan.exe", path: path.join(vendorClamavDir, "clamscan.exe"), fix: VENDOR_FIX },
  { id: "licencas:THIRD-PARTY-NOTICES.txt", path: path.join(licensesDir, "THIRD-PARTY-NOTICES.txt"), fix: "repor os assets de licenças revistos e o respectivo manifesto" },
  { id: "licencas:PROVENANCE.json", path: path.join(licensesDir, "PROVENANCE.json"), fix: "repor o manifesto documental revisto; não encerrar obrigações sem prova" },
];

/** Junta os inputs fixos com os `include` de cada pacote do workspace. */
export function preflightChecks({ clamavSeedDir: seedDir = null } = {}) {
  const checks = [...PREFLIGHT];
  for (const pkg of WORKSPACE_PACKAGES) {
    for (const entry of pkg.include) {
      checks.push({
        id: `workspace:${pkg.name}/${entry}`,
        path: path.join(root, "packages", pkg.dir, entry),
        fix: `npm run build -w ${pkg.name}`,
      });
    }
  }
  if (seedDir) {
    for (const name of ["SEED-MANIFEST.json", "COPYING.txt", "main.cvd", "daily.cld", "bytecode.cvd"]) {
      checks.push({
        id: `seed-clamav:${name}`,
        path: path.join(seedDir, name),
        fix: "node scripts/prepare-clamav-seed.mjs --source <cache oficial verificada> --out <pasta>",
      });
    }
  }
  // Fonte correspondente (GPLv2 §3): o nome EXACTO do ficheiro vive no
  // manifesto do bundle (é ele que fixa a versão), por isso o check é derivado
  // do manifesto em vez de repetir "1.5.4" aqui. Sem manifesto, o check falha
  // no `VENDOR.json` acima e este aponta para o directório da fonte.
  const bundledSource = readJsonIfPresent(vendorManifestPath)?.correspondingSource?.bundledPath;
  checks.push({
    id: "bundle-clamav:fonte-correspondente",
    path:
      typeof bundledSource === "string" && bundledSource.trim() !== ""
        ? path.join(vendorClamavDir, bundledSource)
        : path.join(vendorClamavDir, "source"),
    fix: VENDOR_FIX,
  });
  return checks.map((check) => ({ ...check, exists: fs.existsSync(check.path) }));
}

/** sha256 de um ficheiro, em streaming (a fonte tem ~61 MiB). */
function sha256OfFile(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/**
 * VERIFICAÇÃO REAL do bundle ClamAV — o que o `--check` e o pipeline usam.
 *
 * Não olha para nomes nem para tamanhos de directório: lê o `VENDOR.json` que
 * o `vendor-clamav.mjs` escreveu e re-mede CADA ficheiro do bundle (bytes +
 * sha256). Verifica também:
 *   • a fonte correspondente COMPLETA (GPLv2 §3) e a sua assinatura, com os
 *     digests registados — sem fonte, o bundle NÃO passa;
 *   • que o assinante registado é a chave esperada (consistência do manifesto);
 *   • que NÃO há base de assinaturas (`*.cvd`/`*.cld`/`*.cud`/`*.cuv`) em lado
 *     nenhum do bundle nem dados de utilizador;
 *   • que as licenças (`COPYING.txt` + `COPYING/`) estão presentes.
 *
 * Devolve `{ ok, problems, ... }` — FALHA FECHADO: qualquer dúvida é `ok:false`.
 * NUNCA descarrega nada (sem rede): só lê o disco.
 */
export function verifyClamavBundle(options = {}) {
  const bundleDir = options.bundleDir ?? vendorClamavDir;
  const manifestPath = options.manifestPath ?? path.join(bundleDir, "VENDOR.json");
  const problems = [];
  const result = { ok: false, problems, manifestPath, version: null, filesChecked: 0, bytesChecked: 0, sourceBundled: false, licenses: 0 };

  const bundleRoot = path.resolve(bundleDir);
  const relPosix = (abs) => path.relative(bundleRoot, abs).split(path.sep).join("/");
  const keyOf = (rel) => (process.platform === "win32" ? rel.toLowerCase() : rel);
  const lstatOrNull = (file) => {
    try {
      return fs.lstatSync(file);
    } catch {
      return null;
    }
  };

  // ── PASSO 0 — o bundle e a ÁRVORE inteira, ANTES de qualquer leitura ───────
  // A ordem é o contrato: (1) `lstat` no PRÓPRIO bundle — se ele for um
  // link/reparse, tudo o que se lesse a seguir viria de fora dele; (2) travessia
  // com `lstat` a RECUSAR cada link sem o seguir, pelo que nada que sobreviva
  // tem componente linkada nem sai do bundle. Só depois disto é que se lê o
  // manifesto e se calcula sha256. (Antes desta correcção, o `statSync` +
  // `sha256OfFile` de cada ficheiro LISTADO corriam primeiro: um caminho listado
  // que fosse um link era LIDO e hasheado antes de ser recusado — o comentário
  // prometia o contrário do que o código fazia.)
  const rootStat = lstatOrNull(bundleRoot);
  if (!rootStat) {
    problems.push(`${bundleDir}: bundle ausente ou ilegível (corre \`${VENDOR_FIX}\`)`);
    return result;
  }
  if (rootStat.isSymbolicLink()) {
    problems.push(`${bundleDir}: o bundle é um symlink/reparse — recusado ANTES de ser lido`);
    return result;
  }
  if (!rootStat.isDirectory()) {
    problems.push(`${bundleDir}: o bundle não é um directório`);
    return result;
  }

  /** Links/não-regulares recusados: chave → { rel, reason }. Nunca lidos. */
  const refused = new Map();
  /** Ficheiros REGULARES encontrados — sem links em nenhum componente. */
  const onDisk = [];
  const walkRefuseLinks = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      problems.push(`${relPosix(dir)}: directório ilegível (recusado)`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = lstatOrNull(full);
      if (!stat) {
        problems.push(`${relPosix(full)}: não foi possível inspeccionar (recusado)`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        refused.set(keyOf(relPosix(full)), {
          rel: relPosix(full),
          reason: "symlink/reparse dentro do bundle — recusado sem ser lido (não se segue para fora)",
        });
        continue;
      }
      if (stat.isDirectory()) {
        walkRefuseLinks(full);
        continue;
      }
      if (!stat.isFile()) {
        refused.set(keyOf(relPosix(full)), {
          rel: relPosix(full),
          reason: "não é um ficheiro regular — recusado sem ser lido",
        });
        continue;
      }
      onDisk.push(relPosix(full));
    }
  };
  walkRefuseLinks(bundleRoot);
  const onDiskKeys = new Set(onDisk.map(keyOf));
  const refusalOf = (rel) => refused.get(keyOf(rel));
  const reportRefusals = () => {
    for (const { rel, reason } of refused.values()) {
      if (!problems.some((problem) => problem.startsWith(`${rel}: `))) problems.push(`${rel}: ${reason}`);
    }
  };

  // O manifesto tem de estar DENTRO do bundle e ter sobrevivido ao passo 0.
  const manifestRel = relPosix(manifestPath);
  if (!path.resolve(manifestPath).startsWith(bundleRoot + path.sep)) {
    problems.push(`manifesto fora do bundle: ${manifestPath}`);
    return result;
  }
  const manifestRefusal = refusalOf(manifestRel);
  if (manifestRefusal) {
    problems.push(`${manifestRefusal.rel}: ${manifestRefusal.reason}`);
    return result;
  }
  // O próprio manifesto não pode ser lido através de um link. A chave sozinha
  // não chega: se um DIRECTORIO ANCESTRAL for um link, a travessia recusou o
  // ancestral (não desceu), pelo que o manifesto não está na árvore aprovada —
  // lê-lo aqui seria exactamente a leitura através do link que o passo 0 proíbe.
  if (!onDiskKeys.has(keyOf(manifestRel))) {
    problems.push(`${manifestRel}: manifesto ausente do bundle ou sob um link/reparse — recusado sem ser lido`);
    return result;
  }
  const manifest = readJsonIfPresent(manifestPath);
  if (!manifest) {
    problems.push(`manifesto do bundle ausente ou ilegível: ${manifestPath} (corre \`${VENDOR_FIX}\`)`);
    return result;
  }
  result.version = manifest.package?.version ?? null;
  if (typeof result.version !== "string" || result.version.trim() === "") {
    problems.push("manifesto sem `package.version`: não é um bundle verificável");
  }

  // ── PASSO 1 — cada ficheiro listado, re-medido (bytes + sha256) ────────────
  // Só chega aqui o que o passo 0 já aprovou: ficheiro regular, sem links.
  const files = manifest.extracted?.files;
  if (!Array.isArray(files) || files.length === 0) {
    problems.push("manifesto sem `extracted.files`: nada a verificar (bundle incompleto)");
  } else {
    for (const entry of files) {
      if (typeof entry?.path !== "string" || typeof entry?.bytes !== "number" || typeof entry?.sha256 !== "string") {
        problems.push(`entrada de manifesto inválida: ${JSON.stringify(entry)}`);
        continue;
      }
      const rel = entry.path.replace(/\\/g, "/");
      const refusal = refusalOf(rel);
      if (refusal) {
        problems.push(`${rel}: ${refusal.reason}`);
        continue;
      }
      if (!onDiskKeys.has(keyOf(rel))) {
        problems.push(`${rel}: ausente do bundle`);
        continue;
      }
      const target = path.resolve(bundleRoot, ...rel.split("/"));
      if (!target.startsWith(bundleRoot + path.sep)) {
        problems.push(`${rel}: fora do bundle (manifesto não pode apontar para fora)`);
        continue;
      }
      const stat = fs.statSync(target);
      if (stat.size !== entry.bytes) {
        problems.push(`${rel}: ${stat.size} B no disco != ${entry.bytes} B no manifesto`);
        continue;
      }
      const digest = sha256OfFile(target);
      if (digest.toLowerCase() !== entry.sha256.toLowerCase()) {
        problems.push(`${rel}: sha256 ${digest} != ${entry.sha256} (ficheiro alterado ou corrompido)`);
        continue;
      }
      if (/^\.(cvd|cld|cud|cuv)$/i.test(path.extname(rel))) {
        problems.push(`${rel}: base de assinaturas dentro do bundle — nunca deve ser publicada`);
        continue;
      }
      if (/^copying(\.txt|\/)/i.test(rel)) result.licenses += 1;
      result.filesChecked += 1;
      result.bytesChecked += stat.size;
    }
  }

  if (result.licenses === 0) {
    problems.push("bundle sem licenças (COPYING.txt / COPYING/): redistribuição de GPLv2 sem licença");
  }

  // ── PASSO 2 — a fonte correspondente COMPLETA e a sua assinatura ───────────
  const source = manifest.correspondingSource;
  if (source?.bundled !== true || typeof source?.bundledPath !== "string") {
    problems.push("manifesto sem fonte correspondente incluída (`correspondingSource.bundled`): GPLv2 §3 não cumprida");
  } else {
    const srcRel = source.bundledPath.replace(/\\/g, "/");
    const verifyBundleFile = (rel, expected, label) => {
      const refusal = refusalOf(rel);
      if (refusal) {
        problems.push(`${rel}: ${refusal.reason}`);
        return false;
      }
      if (!onDiskKeys.has(keyOf(rel))) {
        problems.push(`${label} ausente do bundle: ${rel}`);
        return false;
      }
      if (typeof expected?.bytes !== "number" || typeof expected?.sha256 !== "string") {
        problems.push(`${label} sem digest registado no manifesto: ${rel}`);
        return false;
      }
      const target = path.resolve(bundleRoot, ...rel.split("/"));
      if (!target.startsWith(bundleRoot + path.sep)) {
        problems.push(`${label} fora do bundle: ${rel}`);
        return false;
      }
      const stat = fs.statSync(target);
      const digest = sha256OfFile(target);
      if (stat.size !== expected.bytes || digest.toLowerCase() !== expected.sha256.toLowerCase()) {
        problems.push(`${label} não confere (${stat.size} B, sha256 ${digest})`);
        return false;
      }
      result.filesChecked += 1;
      result.bytesChecked += stat.size;
      return true;
    };

    result.sourceBundled = verifyBundleFile(srcRel, source, "fonte correspondente");
    const sigName =
      typeof source.sig?.name === "string" && source.sig.name !== ""
        ? source.sig.name
        : typeof source.signature?.name === "string"
          ? source.signature.name
          : null;
    if (sigName) {
      verifyBundleFile(path.posix.join(path.posix.dirname(srcRel), sigName), source.sig ?? source.signature, "assinatura da fonte");
    }
    if (source.signature?.verified === true && typeof source.signature?.signedByFingerprint === "string") {
      if (
        String(source.signature.signedByFingerprint).toUpperCase() !==
        String(source.signature.keyFingerprint ?? manifest.signature?.keyFingerprint ?? "").toUpperCase()
      ) {
        problems.push("assinatura da fonte registada por um fingerprint diferente da chave esperada");
      }
    } else {
      problems.push("fonte correspondente sem assinatura registada como verificada");
    }
  }

  if (manifest.signature?.verified !== true) {
    problems.push("manifesto sem assinatura do binário verificada (`signature.verified`)");
  } else if (
    String(manifest.signature.signedByFingerprint ?? "").toUpperCase() !==
    String(manifest.signature.keyFingerprint ?? "").toUpperCase()
  ) {
    problems.push("binário assinado por um fingerprint diferente da chave esperada");
  }

  // ── PASSO 3 — allow-list FECHADA do disco ─────────────────────────────────
  // Um ficheiro EXTRA que ninguém listou passava e o `extraResources` publicava-o
  // (MEDIDO em %TEMP% a 2026-10-13: `unexpected.exe` + `personal.txt` ⇒ `ok:true`).
  const allowed = new Map();
  for (const entry of Array.isArray(files) ? files : []) {
    if (typeof entry?.path === "string") allowed.set(keyOf(entry.path.replace(/\\/g, "/")), "extraído do arquivo verificado");
  }
  allowed.set(keyOf("VENDOR.json"), "manifesto gerado pelo vendor-clamav.mjs");
  allowed.set(keyOf(VENDOR_OFFER_NAME), "oferta de fonte gerada pelo vendor-clamav.mjs");
  if (typeof source?.bundledPath === "string") {
    const bundledRel = source.bundledPath.replace(/\\/g, "/");
    allowed.set(keyOf(bundledRel), "fonte correspondente");
    const sigName =
      typeof source.sig?.name === "string" && source.sig.name !== ""
        ? source.sig.name
        : typeof source.signature?.name === "string"
          ? source.signature.name
          : null;
    if (sigName) allowed.set(keyOf(path.posix.join(path.posix.dirname(bundledRel), sigName)), "assinatura da fonte");
  }

  if (!onDiskKeys.has(keyOf(VENDOR_OFFER_NAME))) {
    problems.push(`metadado gerado em falta: ${VENDOR_OFFER_NAME} (sem ele a fonte incluída não fica declarada)`);
  }

  for (const rel of onDisk) {
    if (/\.(cvd|cld|cud|cuv)$/i.test(path.extname(rel))) {
      problems.push(`${rel}: base de assinaturas no bundle`);
      continue;
    }
    if (!allowed.has(keyOf(rel))) {
      problems.push(`${rel}: ficheiro NÃO listado no manifesto — o extraResources publicá-lo-ia; recusado`);
    }
  }
  reportRefusals();

  result.ok = problems.length === 0;
  return result;
}/**
 * Manifesto da aplicação empacotada — a forma EXATA do que vai dentro do pacote.
 *
 * `productName` é obrigatório aqui (não só no config do builder): é o campo que
 * o Electron lê em `app.getName()`, e é dele que sai o `userData`. Sem ele, o
 * pacote instalado gravava segredos/base de dados em `%APPDATA%\@cybersafe\desktop`
 * (o `name` do pacote) em vez de `%APPDATA%\CyberSafe Assistant`. Isto foi
 * medido a 13/10/2026 no `app.asar` entregue a 11/10.
 */
/**
 * Recursos do NSIS consumidos pelo electron-builder (não os `!include` internos
 * do script, que o próprio NSIS resolve a partir do includer).
 */
const NSIS_RESOURCE_KEYS = [
  "include",
  "script",
  "license",
  "installerIcon",
  "uninstallerIcon",
  "installerHeader",
  "installerHeaderIcon",
  "installerSidebar",
  "uninstallerSidebar",
];

/**
 * Torna absolutos os caminhos do bloco `nsis`, resolvidos contra
 * `buildResources`, e FALHA FECHADO se um deles apontar para um ficheiro que
 * não existe.
 *
 * Motivo medido: a candidata 0.1.10 saiu com o texto «0.1.8» no instalador
 * porque o config usado nesse empacotamento não declarava `include` e o
 * electron-builder apanhou um `installer.nsh` de 5 linhas deixado em
 * `buildResources`, enquanto o instalador desenhado (que usa `${VERSION}`)
 * ficou por usar. Um caminho relativo que não resolve é exactamente esse
 * acidente — por isso aqui é erro, não omissão.
 */
export function absolutizeNsisResources(nsis, buildResourcesDir) {
  if (!nsis || typeof nsis !== "object") return nsis;
  const next = { ...nsis };
  for (const key of NSIS_RESOURCE_KEYS) {
    const value = next[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    if (path.isAbsolute(value)) {
      if (!fs.existsSync(value)) throw new Error(`nsis.${key} aponta para um ficheiro inexistente: ${value}`);
      continue;
    }
    const resolved = path.join(buildResourcesDir, value);
    if (!fs.existsSync(resolved)) {
      throw new Error(`nsis.${key} = ${JSON.stringify(value)} não existe em ${buildResourcesDir}; o instalador desenhado seria substituído pelo de omissão`);
    }
    next[key] = resolved;
  }
  return next;
}

export function candidateOutput(shellDir, id) {
  if (typeof id !== "string" || !/^[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/.test(id)) throw new Error("Invalid candidate identifier");
  return {output: path.join(shellDir, "release", `candidate-${id}`), artifactName: '${productName}-${version}-candidate-' + id + '-setup.${ext}'};
}

export function buildAppManifest({ desktopManifest, tarballs, electronVersion, scanEngine, outDir: outputDir, desktopDir: shellDir, clamavDir = vendorClamavDir, clamavSeedDir: seedDir = null, licensesFrom = licensesDir, candidateId, productVersion }) {
  if (seedDir) throw new Error("CLAMAV_SEED_NATIVE_BOUNDARY_REQUIRED: publicação automática bloqueada; não gerar setup com seed inoperacional");
  // A versão do produto vem de `product-version.json` (fonte única), não do
  // `package.json` do desktop: é este campo que o electron-builder usa para o
  // nome do artefacto, para `${VERSION}` do NSIS, para `app.getVersion()` e para
  // a chave `DisplayVersion` na desinstalação. Manter as três superfícies
  // (instalador, aplicação, renderer) na mesma versão depende disto.
  //
  // Obrigatória de propósito: a primeira tentativa desta candidata caiu para
  // `desktopManifest.version` (0.1.2) e gerou um setup que não podia ser
  // upgrade. Um fallback silencioso é pior do que falhar o build.
  if (typeof productVersion !== "string" || productVersion.trim() === "") {
    throw new Error("buildAppManifest exige productVersion (product-version.json), não o version de packages/desktop");
  }
  const version = productVersion;
  return {
    name: desktopManifest.name,
    productName: desktopManifest.build.productName,
    version,
    private: true,
    description: desktopManifest.description,
    author: desktopManifest.author,
    type: desktopManifest.type,
    main: desktopManifest.main,
    // `file:` com barras normais: o npm normaliza em Windows e aceita o caminho
    // absoluto real da árvore de staging (fora do repositório).
    dependencies: {
      "@cybersafe/core": `file:${toPosix(tarballs["@cybersafe/core"])}`,
      "@cybersafe/shared-types": `file:${toPosix(tarballs["@cybersafe/shared-types"])}`,
      "@cybersafe/service": `file:${toPosix(tarballs["@cybersafe/service"])}`,
      api: `file:${toPosix(tarballs.api)}`,
    },
    build: {
      ...desktopManifest.build,
      ...(desktopManifest.build?.nsis
        ? { nsis: absolutizeNsisResources(desktopManifest.build.nsis, path.join(shellDir, "build")) }
        : {}),
      ...(candidateId ? { artifactName: candidateOutput(shellDir, candidateId).artifactName } : {}),
      electronVersion,
      // Saída no sítio habitual do projeto (release/ está ignorado pelo git).
      // O staging vive FORA do repositório: sem `buildResources` absoluto o
      // electron-builder procura `<staging>/build`, onde não há include NSIS
      // nem os BMP do instalador (getResource e ${BUILD_RESOURCES_DIR}).
      directories: { ...desktopManifest.build.directories, output: outputDir, buildResources: path.join(shellDir, "build") },
      // Árvore real (sem symlinks): incluir node_modules inteiro é seguro aqui.
      files: [
        "dist/**/*",
        "package.json",
        "node_modules/**/*",
        "!**/*.log",
        "!**/*.map",
        "!**/.env*",
        "!**/api-jwt-secret*",
        "!**/node_modules/@prisma/**",
      ],
      // O pipeline reconstrói e verifica os addons ANTES do builder (ver
      // `prepareNativeAddons`): o rebuild embutido do electron-builder usa um
      // node-gyp 9.4.1 que não reconhece o VS 18. Desligá-lo sem essa verificação
      // viajaria ABI errada em silêncio; por isso `npmRebuild` é falso aqui e o
      // gate de ABI é obrigatório no stage.
      npmRebuild: false,
      // Módulos nativos não podem ser carregados de dentro do asar.
      asarUnpack: ["**/*.node", "**/node_modules/better-sqlite3/**"],
      // `extraResources` do manifesto é explícito (não herdado do desktop) de
      // propósito: a árvore de staging vive FORA do repositório, por isso o
      // `from` relativo ao desktop apontaria para o sítio errado. O bundle vai
      // com caminho ABSOLUTO e `to: "clamav"` ⇒ `<app>/resources/clamav`, que é
      // exactamente onde o pin `CYBERSAFE_CLAMSCAN_PATH` do main.ts o procura.
      extraResources: [
        { from: scanEngine, to: "scan-engine.exe" },
        // YARA clássico oficial: `resolveYaraClassicBinaries()` procura
        // `resources/yara` no artefacto empacotado. Sem esta entrada, o build
        // sai com o motor indisponível e nenhum aviso no setup.
        { from: yaraVendorDir, to: "yara" },
        { from: clamavDir, to: "clamav" },
        { from: licensesFrom, to: "licenses" },
      ],
      win: { ...desktopManifest.build.win, icon: path.join(shellDir, "src", "assets", "icon.ico") },
    },
  };
}

/** Mede a árvore REAL do staging antes do builder; nunca devolve conteúdos. */
export function verifyStagingSafety(appDir, { forbiddenContent = [] } = {}) {
  const problems = [];
  let filesChecked = 0;
  let bytesChecked = 0;
  const markers = forbiddenContent.filter((value) => typeof value === "string" && value.length > 0);
  const add = (code, file) => problems.push({ code, path: file });
  const privatePath = /(^|\/)(?:runtime-data|secrets|profiles|quarantine|history)(\/|$)|(^|\/)\.env[^/]*(?:\/|$)|api-jwt-secret|(^|\/)(?:credentials?|tokens?)(?:\.(?:json|ya?ml|ini|conf|txt))?$|\.(?:sqlite3?|db)(?:-(?:wal|shm))?$/i;
  function walk(dir, relative = "") {
    let entries;
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) { add("linked-staging-entry", relative || "."); return; }
      if (!stat.isDirectory()) { add("non-regular-staging-entry", relative || "."); return; }
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { add("staging-unreadable", relative || "."); return; }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      // Recusa caminhos privados antes de ler o respectivo conteúdo.
      if (privatePath.test(rel)) { add("private-runtime-path", rel); continue; }
      let stat;
      try { stat = fs.lstatSync(file); } catch { add("staging-unreadable", rel); continue; }
      if (stat.isSymbolicLink() || stat.nlink > 1) { add("linked-staging-entry", rel); continue; }
      if (stat.isDirectory()) { walk(file, rel); continue; }
      if (!stat.isFile()) { add("non-regular-staging-entry", rel); continue; }
      filesChecked += 1;
      // Leitura em blocos com sobreposição: também detecta marcadores em binários,
      // sem carregar toda a árvore ou um executável inteiro na memória.
      let fd;
      try {
        fd = fs.openSync(file, "r");
        const buffer = Buffer.alloc(64 * 1024);
        const overlap = Math.max(4096, ...markers.map((marker) => Buffer.byteLength(marker)));
        let previous = Buffer.alloc(0);
        let count;
        const found = new Set();
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          bytesChecked += count;
          const chunk = Buffer.concat([previous, buffer.subarray(0, count)]);
          const text = chunk.toString("utf8");
          if (markers.some((marker) => chunk.includes(Buffer.from(marker)))) found.add("forbidden-content");
          if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*(?:\\n)?[A-Za-z0-9+/=\r\n]{64,}/.test(text)) found.add("private-key-material");
          if (/\.(?:json|[cm]?js|ya?ml|toml|ini|conf|txt)$/i.test(rel) && /["']?(?:api[_-]?key|jwt[_-]?secret|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9_./+\-=]{24,}["']/i.test(text)) found.add("literal-credential");
          previous = chunk.subarray(Math.max(0, chunk.length - overlap));
        }
        for (const code of found) add(code, rel);
      } catch { add("staging-unreadable", rel); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  }
  walk(appDir);
  return { ok: problems.length === 0, filesChecked, bytesChecked, problems,
    limits: "Marcadores conhecidos, chaves privadas e literais reconhecidos; não prova ausência de qualquer segredo arbitrário ou ofuscado." };
}

// ── Rebuild nativo do pipeline (ABI do Electron empacotado) ──────────────────
//
// PORQUE É QUE O PIPELINE FAZ O REBUILD E NÃO DELEGA NO BUILDER:
// o electron-builder instalado (25.1.8 → @electron/rebuild 3.6.1 → worker com
// `require("node-gyp")`) resolve o node-gyp 9.4.1 do repositório. O 9.4.1 não
// reconhece o Visual Studio 18/2026 (`unknown version "undefined"`, comprovado
// em 2026-10-24), pelo que o rebuild nativo falharia no configure antes de
// tocar no módulo. Em vez de fingir uma versão de VS ou de desligar o rebuild
// sem verificar nada, o pipeline reconstrói com um node-gyp >= 12.1.0 (o
// primeiro com suporte a VS18) e MEDE todos os `.node` da árvore depois. Se
// algum addon ficar com ABI errada, ou se a ferramenta não servir, FALHA.
const NATIVE_REBUILD_MIN_NODE_GYP = [12, 1, 0];

/** CLI do node-gyp do pipeline: override explícito ou instalação do repo. */
export function resolveNativeRebuildTool({ cli = process.env.CYBERSAFE_NODE_GYP_CLI } = {}) {
  const cliPath = path.resolve(cli ?? path.join(root, "node_modules", "node-gyp", "bin", "node-gyp.js"));
  if (!fs.existsSync(cliPath)) return { ok: false, cliPath, reason: `node-gyp ausente em ${cliPath}` };
  let version = null;
  try {
    version = readJson(path.join(path.dirname(cliPath), "..", "package.json")).version ?? null;
  } catch {
    return { ok: false, cliPath, reason: "node-gyp sem package.json legível" };
  }
  const parts = String(version).split(".").map((value) => Number.parseInt(value, 10));
  const ok = parts.length >= 3 && parts.every(Number.isFinite) && compareVersion(parts, NATIVE_REBUILD_MIN_NODE_GYP) >= 0;
  return { ok, cliPath, version, reason: ok ? null : `node-gyp ${version} não suporta Visual Studio 18 (mínimo ${NATIVE_REBUILD_MIN_NODE_GYP.join(".")})` };
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Lê o addon e diz se é N-API (estável) ou Node-ABI (e qual). Nunca o carrega. */
export function classifyNativeAddon(file) {
  const bytes = fs.readFileSync(file);
  const abi = /node_register_module_v(\d+)/.exec(bytes.toString("latin1"));
  if (bytes.includes(Buffer.from("napi_register_module_v1"))) return { kind: "napi", abi: null, bytes: bytes.length };
  if (abi) return { kind: "node-abi", abi: Number(abi[1]), bytes: bytes.length };
  return { kind: "unknown", abi: null, bytes: bytes.length };
}

/** Percorre a árvore real e devolve todos os `.node` regulares. */
export function findNativeAddons(appDir) {
  const found = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`addon sob link: ${file}`);
      if (entry.isDirectory()) { walk(file); continue; }
      if (entry.isFile() && entry.name.endsWith(".node")) found.push(file);
    }
  }
  walk(path.join(appDir, "node_modules"));
  return found;
}

/** Mede a ABI de todos os addons; falha fechado em desconhecidos ou errados. */
export function verifyNativeAddons(appDir, { targetAbi }) {
  const addons = findNativeAddons(appDir).map((file) => {
    const info = classifyNativeAddon(file);
    return {
      path: path.relative(appDir, file).split(path.sep).join("/"),
      ...info,
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      ok: info.kind === "napi" || (info.kind === "node-abi" && info.abi === targetAbi),
    };
  });
  const problems = addons.filter((addon) => !addon.ok).map((addon) =>
    addon.kind === "unknown"
      ? `${addon.path}: addon nativo de tipo desconhecido`
      : `${addon.path}: ABI ${addon.abi}, esperada ${targetAbi}`);
  return { ok: problems.length === 0, targetAbi, addons, problems };
}

/**
 * Copia headers regulares para a lane e garante o layout que o GYP gere.
 *
 * O GYP liga `--nodedir=...\<Release>\node.lib`, mas a cache do Electron
 * guarda o importlib em `<cache>\x64\node.lib`. A cópia é byte-idêntica e fica
 * na lane: nunca se escreve na cache do utilizador nem em `node_modules` de U.
 */
function prepareHeaders(headersRoot, destination) {
  copyInto(headersRoot, destination);
  const release = path.join(destination, "Release");
  const lib = path.join(release, "node.lib");
  if (!fs.existsSync(lib)) {
    const source = path.join(destination, "x64", "node.lib");
    if (!fs.existsSync(source)) throw new Error(`headers sem x64/node.lib: ${headersRoot}`);
    fs.mkdirSync(release, { recursive: true });
    fs.copyFileSync(source, lib);
  }
  return { root: destination, nodeLib: lib, nodeLibSha256: createHash("sha256").update(fs.readFileSync(lib)).digest("hex") };
}

/**
 * Tira a informação de debug do projeto MSBuild que o `configure` acabou de gerar.
 *
 * PORQUE É QUE ISTO É FEITO AQUI: o `node-gyp` não encaminha argumentos para o
 * `msbuild`, e o módulo de terceiros traz no seu `binding.gyp` (herdado do gyp do
 * node-gyp) `DebugInformationFormat=OldStyle` (/Z7) e `GenerateDebugInformation`.
 * Ambos embutem no `.node` o CAMINHO ABSOLUTO da árvore de compilação — a pasta de
 * staging fica sob o perfil do utilizador, portanto o binário publicado revelava
 * `C:\\Users\\<nome>\\.cybersafe-integration\\…`. Desligar a informação de debug
 * não altera código gerado nem ABI: remove só as secções CodeView e o PDB.
 *
 * FALHA FECHADO: se o projeto gerado deixar de ter estes marcadores, a política de
 * build mudou e é preferível parar a publicar um binário com caminhos de DEV.
 */
export function stripGeneratedBuildDebugInfo(moduleDir) {
  const buildDir = path.join(moduleDir, "build");
  const projects = fs.existsSync(buildDir)
    ? fs.readdirSync(buildDir).filter((name) => name.endsWith(".vcxproj"))
    : [];
  if (projects.length === 0) throw new Error(`sem projeto MSBuild gerado em ${buildDir}`);
  let seen = 0;
  const changed = [];
  for (const name of projects) {
    const file = path.join(buildDir, name);
    const before = fs.readFileSync(file, "utf8");
    const formatTags = before.match(/<DebugInformationFormat>[^<]*<\/DebugInformationFormat>/g) ?? [];
    const debugTags = before.match(/<GenerateDebugInformation>[^<]*<\/GenerateDebugInformation>/g) ?? [];
    seen += formatTags.length + debugTags.length;
    const after = before
      .replace(/<DebugInformationFormat>[^<]*<\/DebugInformationFormat>/g, "<DebugInformationFormat>None</DebugInformationFormat>")
      .replace(/<GenerateDebugInformation>[^<]*<\/GenerateDebugInformation>/g, "<GenerateDebugInformation>false</GenerateDebugInformation>");
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(name);
    }
  }
  if (seen === 0) throw new Error(`projetos sem marcadores de debug em ${buildDir}: política de build mudou`);
  const leftovers = changed
    .map((name) => fs.readFileSync(path.join(buildDir, name), "utf8"))
    .filter((text) => /<DebugInformationFormat>(?!None<)/.test(text) || /<GenerateDebugInformation>true</.test(text));
  if (leftovers.length > 0) throw new Error("informação de debug resistiu à reescrita do projeto");
  return { projects: changed, tags: seen };
}

/**
 * Remove os subprodutos de compilação de um módulo reconstruído.
 *
 * O rebuild do better-sqlite3 deixa no `build/` projetos MSBuild, objetos, `.pdb`,
 * `.lib`, `.exp`, `.iobj` e `.tlog` — todos com o caminho absoluto da árvore de
 * staging. Só o addon `.node` é carregado em runtime (`require('bindings')`); o
 * resto são restos de toolchain que não podem viajar no produto.
 *
 * `keep` são os `.node` que ficam (os que já existiam e o reconstruído): nunca se
 * apaga um ficheiro de runtime. Devolve a lista do que saiu, em caminhos POSIX
 * relativos ao módulo, para o log do pipeline.
 */
export function pruneNativeBuildProducts(moduleDir, { keep = [] } = {}) {
  const buildDir = path.join(moduleDir, "build");
  if (!fs.existsSync(buildDir)) return [];
  const keepSet = new Set(keep.map((file) => path.resolve(file)));
  const removed = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        if (fs.readdirSync(file).length === 0) fs.rmdirSync(file);
        continue;
      }
      if (keepSet.has(path.resolve(file))) continue;
      fs.unlinkSync(file);
      removed.push(path.relative(moduleDir, file).split(path.sep).join("/"));
    }
  }
  walk(buildDir);
  return removed;
}

/**
 * Compila o módulo através de uma unidade temporária sem relação com o perfil.
 *
 * PORQUE É QUE ISTO É NECESSÁRIO: além do debug (que já é desligado), o `cl.exe`
 * recebe do MSBuild o caminho ABSOLUTO do `.cpp` e do `.obj`, e o `/GL` grava
 * essa tabela de ficheiros no módulo. O caminho viaja então dentro do `.node`
 * publicado (`C:\\Users\\<nome>\\.cybersafe-integration\\…\\src\\better_sqlite3.cpp`).
 * Não há flag do MSVC para reescrever esses caminhos (`/pathmap` é do clang), e
 * alterar `/GL` mudaria o código gerado. A solução mínima é compilar através de
 * uma letra de unidade mapeada para o módulo: os caminhos passam a `R:\src\…`,
 * que não identifica ninguém, e o binário mantém exactamente a mesma ABI, as
 * mesmas optimizações e o mesmo comportamento.
 *
 * O mapeamento é sempre removido no fim (mesmo em erro). Se não houver letra
 * livre, falha — é preferível parar a publicar um binário com o perfil do autor.
 */
function withNeutralBuildDrive(targetDir, run) {
  if (process.platform !== "win32") return run(targetDir);
  const letters = [..."ZYXWVUTSRQPNMLKJIHG"];
  let mapped = null;
  for (const letter of letters) {
    const drive = `${letter}:`;
    if (fs.existsSync(`${drive}\\`)) continue;
    try {
      execFileSync("subst", [drive, targetDir], { stdio: "pipe" });
      mapped = drive;
      break;
    } catch { /* letra ocupada ou subst indisponível: tenta a seguinte */ }
  }
  if (!mapped) throw new Error(`sem letra de unidade livre para compilar ${targetDir} sem caminhos privados`);
  try {
    return run(`${mapped}\\`);
  } finally {
    try { execFileSync("subst", [mapped, "/D"], { stdio: "pipe" }); } catch { /* a limpeza não muda o resultado */ }
  }
}

/**
 * Reconstrói os addons Node-ABI da árvore de staging e verifica TODOS.
 * Devolve um relatório; lança se algo ficar errado — nunca "best effort".
 *
 * O rebuild é feito em dois passos (`configure` + `build`) em vez de `rebuild`
 * para permitir o hardening do projeto gerado ENTRE os dois: sem essa janela não
 * há forma de o `node-gyp` desligar a informação de debug (não encaminha
 * argumentos para o msbuild). O `build/` é apagado antes do `configure`, que é
 * exactamente o que o `clean` interno do `rebuild` faria.
 */
export function prepareNativeAddons({ appDir, electronVersion, targetAbi, headersRoot, cacheDir, log = () => {} }) {
  const tool = resolveNativeRebuildTool();
  if (!tool.ok) throw new Error(`rebuild nativo impossível: ${tool.reason}`);
  const headers = prepareHeaders(headersRoot, path.join(cacheDir, "headers", electronVersion));
  const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "rebuild-offline-guard.cjs");
  const before = verifyNativeAddons(appDir, { targetAbi });
  const rebuilt = [];
  for (const addon of before.addons) {
    if (addon.ok) continue;
    if (addon.kind !== "node-abi") throw new Error(`addon sem ABI reconstruível: ${addon.path}`);
    const addonFile = path.join(appDir, addon.path);
    const moduleDir = packageRootOf(addonFile);
    const beforeFiles = new Set(findNativeFileList(moduleDir));
    const gyp = (cwd, command) => execFileSync(process.execPath, [
      "--require", guard,
      tool.cliPath, command, "--release", "--arch=x64",
      `--target=${electronVersion}`, `--nodedir=${headers.root}`, "--jobs=2",
    ], { cwd, stdio: "pipe" });
    log(`     rebuild ${addon.path} (ABI ${addon.abi} → ${targetAbi}) com node-gyp ${tool.version} …`);
    const hardening = withNeutralBuildDrive(moduleDir, (cwd) => {
      fs.rmSync(path.join(moduleDir, "build"), { recursive: true, force: true });
      gyp(cwd, "configure");
      const stripped = stripGeneratedBuildDebugInfo(moduleDir);
      gyp(cwd, "build");
      return stripped;
    });
    log(`     sem informação de debug no projeto nativo (${hardening.tags} marcadores, ${hardening.projects.length} ficheiro(s)) e sem caminhos do perfil no binário`);
    // O `node-gyp` constrói TODOS os targets do binding.gyp. O better-sqlite3 tem
    // `test_extension` (extensão SQLite, não addon Node): esse `.node` não vem no
    // pacote npm e não é carregável pelo Node. Remove-se só o que o rebuild CRIOU
    // agora e não é o addon reconstruído — nunca um ficheiro que já existisse antes.
    const keptName = path.basename(addonFile);
    for (const extra of findNativeFileList(moduleDir)) {
      if (path.basename(extra) === keptName) continue;
      if (beforeFiles.has(extra)) continue;
      fs.unlinkSync(extra);
      log(`     removido subproduto de build não empacotável: ${path.relative(appDir, extra).split(path.sep).join("/")}`);
    }
    const pruned = pruneNativeBuildProducts(moduleDir, { keep: findNativeFileList(moduleDir) });
    if (pruned.length > 0) {
      log(`     removidos ${pruned.length} subproduto(s) de compilação de ${path.relative(appDir, moduleDir).split(path.sep).join("/")}/build (ficam só addons .node)`);
    }
    const after = verifyNativeAddons(appDir, { targetAbi });
    const updated = after.addons.find((entry) => entry.path === addon.path);
    if (!updated?.ok) throw new Error(`rebuild não corrigiu ${addon.path} (ABI ${updated?.abi ?? "?"})`);
    rebuilt.push({ path: addon.path, fromAbi: addon.abi, toAbi: updated.abi, fromSha256: addon.sha256, toSha256: updated.sha256, tool: tool.version, pruned: pruned.length });
  }
  const final = verifyNativeAddons(appDir, { targetAbi });
  if (!final.ok) throw new Error(`addons nativos com ABI errada: ${final.problems.join("; ")}`);
  return { tool, headers, targetAbi, addons: final.addons, rebuilt };
}

/**
 * ABI do Electron para a versão empacotada. Usa `node-abi` (a mesma tabela que
 * o electron-builder usa) e, sem ela, uma tabela explícita mínima. Desconhecida
 * ⇒ falha: uma ABI adivinhada é pior do que um build parado.
 */
export function electronAbi(electronVersion) {
  try {
    const requireFromRoot = createRequire(path.join(root, "package.json"));
    const abi = requireFromRoot("node-abi").getAbi(electronVersion, "electron");
    if (abi) return Number(abi);
  } catch { /* cai na tabela explícita */ }
  const known = { "33.4.11": 130 };
  if (known[electronVersion]) return known[electronVersion];
  throw new Error(`ABI desconhecida para Electron ${electronVersion}: sem node-abi e sem tabela explícita`);
}

/** Lista `.node` de um módulo (sem seguir links). */
function findNativeFileList(moduleDir) {
  const list = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".node")) list.push(file);
    }
  })(moduleDir);
  return list;
}

/** Sobe do ficheiro até ao directório com `package.json` (raiz do módulo). */
export function packageRootOf(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`sem package.json acima de ${file}`);
    dir = parent;
  }
}

// ── Higiene do pacote: referências `file:` do staging ────────────────────────
// O `npm install` da árvore de staging escreve as dependências internas como
// `file:<tarball do staging>` — e o `electron-builder` empacota o manifesto tal
// como está. MEDIDO a 13/10/2026 no app.asar entregue a 11/10: 10 referências a
// `file:C:/Users/<user>/AppData/Local/Temp/cybersafe-package-*/tarballs/*.tgz`
// dentro do pacote, em CINCO ficheiros (o manifesto raiz e quatro manifestos de
// pacotes instalados), ou seja, o caminho do build viajava para o computador do
// utilizador. Estas funções normalizam SÓ essas referências, para a versão real
// do pacote instalado — sem tocar em dependências externas, no root/workspace
// manifests nem nos lockfiles.
const DEPENDENCY_BLOCKS = ["dependencies", "devDependencies", "optionalDependencies"];
const STAGING_MARKER = "cybersafe-package-";

function isStagingTarballSpec(spec, posixTarballDir) {
  if (typeof spec !== "string" || !spec.startsWith("file:")) return false;
  const raw = spec.slice("file:".length);
  if (!raw.toLowerCase().endsWith(".tgz")) return false;
  const posix = toPosix(raw).toLowerCase();
  return posix.slice(0, posix.lastIndexOf("/")) === posixTarballDir;
}

/**
 * FUNÇÃO PURA. Devolve `{ manifest, changes }` sem alterar a entrada.
 * Só substitui dependências internas conhecidas cujo spec é um `.tgz` dentro de
 * `tarballDir`. Sem versão verificada para o pacote, FALHA — não inventa.
 */
export function normalizeStagingRefs(manifest, { tarballDir, internalNames, versions }) {
  if (!manifest || typeof manifest !== "object") throw new Error("normalizeStagingRefs: manifesto inválido");
  const posixTarballDir = toPosix(path.resolve(tarballDir)).toLowerCase();
  const changes = [];
  const output = { ...manifest };
  for (const block of DEPENDENCY_BLOCKS) {
    const deps = manifest[block];
    if (!deps || typeof deps !== "object") continue;
    let next = null;
    for (const [name, spec] of Object.entries(deps)) {
      if (!internalNames.includes(name)) continue;
      if (!isStagingTarballSpec(spec, posixTarballDir)) continue;
      const version = versions?.[name];
      if (typeof version !== "string" || version.trim() === "" || version.startsWith("file:")) {
        throw new Error(`sem versão verificada para ${name}: referência de staging não é normalizada às cegas`);
      }
      next = next ?? { ...deps };
      next[name] = version;
      changes.push({ name, from: spec, to: version, block });
    }
    if (next) output[block] = next;
  }
  return { manifest: output, changes };
}

/**
 * Versão REAL de cada pacote interno tal como ficou instalado no pacote.
 * Se um deles não estiver instalado, falha: a inclusão das dependências é
 * pré-requisito da normalização, não uma suposição.
 */
export function readInstalledVersions(appDir, internalNames) {
  const versions = {};
  for (const name of internalNames) {
    const file = path.join(appDir, "node_modules", ...name.split("/"), "package.json");
    if (!fs.existsSync(file)) {
      throw new Error(`${name} não está instalado em ${file}: inclusão de dependências quebrada, não normalizo`);
    }
    const manifest = readJson(file);
    if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
      throw new Error(`${name}: manifesto instalado sem version (${file})`);
    }
    versions[name] = manifest.version;
  }
  return versions;
}

/** Manifesto raiz + todos os manifestos instalados (profundidade limitada). */
function collectInstalledManifests(appDir) {
  const files = [path.join(appDir, "package.json")];
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const manifest = path.join(full, "package.json");
      if (fs.existsSync(manifest)) files.push(manifest);
      walk(full, depth + 1);
    }
  };
  walk(path.join(appDir, "node_modules"), 0);
  return files;
}

/**
 * Aplica a normalização à árvore instalada inteira. Não finge higiene só no
 * root: qualquer referência de staging que sobrar — tipicamente num manifesto
 * de terceiros, que NÃO se reescreve — faz falhar com a primeira encontrada.
 */
export function normalizeStagingRefsUnderApp({ appDir, tarballDir, internalNames }) {
  const versions = readInstalledVersions(appDir, internalNames);
  // Nossos: o manifesto raiz da app (que escrevemos nós) e os manifestos de cada
  // pacote interno instalado. Qualquer outro manifesto com referência nossa é de
  // terceiros e não se reescreve.
  const internalFiles = new Set([
    path.join(appDir, "package.json"),
    ...internalNames.map((name) => path.join(appDir, "node_modules", ...name.split("/"), "package.json")),
  ]);
  const changedFiles = [];
  const changes = [];
  const leftovers = [];

  for (const file of collectInstalledManifests(appDir)) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`manifesto ilegível (primeira falha preservada): ${file}: ${error.message}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (error) {
      throw new Error(`manifesto inválido (primeira falha preservada): ${file}: ${error.message}`);
    }

    const { manifest: next, changes: fileChanges } = normalizeStagingRefs(manifest, {
      tarballDir,
      internalNames,
      versions,
    });

    if (fileChanges.length > 0 && !internalFiles.has(file)) {
      // Manifesto de terceiros com referência nossa: não se reescreve, mas também
      // não se deixa atravessar para dentro do pacote.
      leftovers.push({ file, refs: fileChanges.map((change) => change.from) });
      continue;
    }
    if (fileChanges.length > 0) {
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      changedFiles.push(file);
      for (const change of fileChanges) changes.push({ ...change, file });
      continue;
    }
    if (raw.includes(STAGING_MARKER)) {
      leftovers.push({ file, refs: [raw.match(new RegExp(`[^"]*${STAGING_MARKER}[^"]*`))?.[0] ?? STAGING_MARKER] });
    }
  }

  if (leftovers.length > 0) {
    const first = leftovers[0];
    throw new Error(
      `referência de staging por normalizar em ${first.file}: ${first.refs.join(", ")} (primeira de ${leftovers.length} ficheiro(s))`,
    );
  }
  return { changedFiles, changes, versions };
}

function usage() {
  return [
    "Uso: node scripts/package-windows.mjs [--dir] [--keep] [--candidate] [--check] [--json] [--help]",
    "",
    "  (sem flags)  instalador NSIS x64",
    "  --dir        pasta win-unpacked, sem instalador",
    "  --keep       mantém o staging em %TEMP% mesmo com sucesso",
    "  --candidate  nova pasta e nome únicos; preserva os instaladores anteriores",
    "  --check      só pré-verificação: inputs, bundle ClamAV e manifesto de fontes",
    "               congeladas (source-freeze) e obrigação documental de licenças;",
    "               NÃO compila, instala nem empacota",
    "  --json       relatório legível por máquina (com --check)",
    "",
    "Códigos de saída: 0 = ok, 1 = inputs em falta, fontes divergentes, licença por resolver ou build falhou, 2 = flags inválidas",
  ].join("\n");
}

const KNOWN_FLAGS = ["--dir", "--keep", "--candidate", "--check", "--json", "--help", "-h"];
// Quando o módulo é importado, `process.argv` é o do processo que importa: não
// pode ser interpretado como flags deste script.
const argv = isMain ? process.argv.slice(2) : [];
const unknownFlags = argv.filter((arg) => !KNOWN_FLAGS.includes(arg));

if (isMain && unknownFlags.length > 0) {
  console.error(`[package] flag(s) desconhecida(s): ${unknownFlags.join(" ")}`);
  console.error(usage());
  process.exit(2);
}

const dirOnly = argv.includes("--dir");
const keepStaging = argv.includes("--keep");
const checkOnly = argv.includes("--check");
const jsonOut = argv.includes("--json");
if (argv.includes("--candidate")) {
  const at = new Date().toISOString();
  candidateId = `${at.slice(0,10).replace(/-/g, "")}-${at.slice(11,19).replace(/:/g, "")}-${randomUUID().slice(0,8)}`;
  outDir = candidateOutput(desktopDir, candidateId).output;
  if (fs.existsSync(outDir)) throw new Error("Candidate output already exists; refusing overwrite");
}

function log(message) {
  console.log(`[package] ${message}`);
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}${options.cwd ? `   (cwd=${path.relative(root, options.cwd) || "."})` : ""}`);
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

function runCapture(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCli, ...args], options);
}

function runNpmCapture(args, options = {}) {
  return runCapture(process.execPath, [npmCli, ...args], options);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonIfPresent(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function copyInto(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

/**
 * Gate de fontes congeladas (TP-MATRIX-FINAL-FREEZE).
 *
 * O pipeline corre três gates à volta dos passos: PRE (antes de compilar),
 * PRE-builder (imediatamente antes do electron-builder) e POS (imediatamente
 * antes de declarar a candidata). Um gate que falhe lança SourceFreezeError e
 * o passo seguinte NÃO corre — é o que os testes provam com spies, sem build.
 *
 * `verify` é injectável (testes) e recebe a fase; por omissão verifica a árvore
 * real contra o manifesto aprovado. Não há flag de bypass nem re-pin silencioso.
 */
export class SourceFreezeError extends Error {
  constructor(phase, freeze) {
    super(`source-freeze: fontes divergentes (${phase})`);
    this.name = "SourceFreezeError";
    this.phase = phase;
    this.freeze = freeze;
  }
}

export function runFreezeGatedPipeline({ stages, verify = (phase) => verifySourceFreeze(), onGateFail = null }) {
  const done = [];
  const gate = (phase) => {
    const freeze = verify(phase);
    if (freeze.ok) {
      done.push(`gate:${phase}`);
      return freeze;
    }
    const error = new SourceFreezeError(phase, freeze);
    error.phasesDone = [...done];
    if (onGateFail) onGateFail(phase, freeze);
    throw error;
  };
  gate("PRE");
  stages.workspaces();
  gate("PRE-builder");
  stages.builder();
  gate("POS");
  stages.promote();
  return done;
}

function logFreezeFailure(context, freeze) {
  console.error(`[package] source-freeze (${context}): build bloqueado`);
  for (const problem of freeze.problems) {
    console.error(`  ${problem.kind}: ${problem.path} ${problem.detail ?? ""}`.trimEnd());
  }
  for (const [kind, list] of Object.entries(freeze.samples)) {
    for (const item of list) console.error(`  ${kind}: ${item.path} ${item.detail ?? ""}`.trimEnd());
  }
}

/** Marca a pasta candidata como NÃO entregável. Nunca apaga artefactos. */
function markNotDeliverable(outputDir, freeze) {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const marker = path.join(outputDir, "SOURCE-FREEZE-FAILED.json");
    const payload = {
      schema: 1,
      at: new Date().toISOString(),
      reason: "source-freeze POS electron-builder",
      manifest: freeze.manifestPath,
      counts: freeze.counts,
      problems: freeze.problems.slice(0, 50),
    };
    fs.writeFileSync(marker, `${JSON.stringify(payload, null, 2)}\n`);
    return marker;
  } catch (error) {
    console.error(`[package] nao foi possivel marcar a candidata: ${error?.message ?? error}`);
    return null;
  }
}

function regularNonEmpty(file) {
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { exists: false, regular: false, bytes: 0, symlink: false, unreadable: true };
  }
  return {
    exists: true,
    regular: stat.isFile(),
    bytes: stat.isFile() ? stat.size : 0,
    symlink: stat.isSymbolicLink(),
    unreadable: false,
  };
}

/**
 * VERIFICAÇÃO REAL do vendor YARA — bytes e sha256, não nomes de ficheiros.
 *
 * O `--check` e o pipeline falham FECHADO se o `VENDOR.json` não descrever os
 * quatro ficheiros obrigatórios (dois executáveis, a licença e o runtime
 * app-local) ou se qualquer byte divergir do manifesto. Isto existe porque a
 * VM016 mostrou o modo de falha caro: o `yarac64.exe` importa VCRUNTIME140.dll,
 * o loader do Windows não a encontra ao lado do executável e o processo nunca
 * chega a `main` (STATUS_DLL_NOT_FOUND). A presença do `.exe` não prova que o
 * motor arranca; o runtime tem de viajar ao lado dele e ser medido.
 *
 * Não segue symlinks e não lê ficheiros fora do directório do vendor.
 */
export function verifyYaraVendor(options = {}) {
  const requestedDir = options.dir ?? yaraVendorDir;
  const dir = path.resolve(requestedDir);
  const manifestPath = options.manifestPath ?? path.join(dir, "VENDOR.json");
  const problems = [];
  const result = { ok: false, problems, manifestPath, version: null, filesChecked: 0, bytesChecked: 0, runtimeBundled: false };
  const REQUIRED = ["yara64.exe", "yarac64.exe", "COPYING.txt", "vcruntime140.dll"];
  // Lista EXATA do que pode viver em vendor/yara: o manifesto + os 4 recursos.
  // O extraResources copia o directório inteiro; sem esta allowlist um ficheiro
  // extra (ou um subdirectório) entrava no pacote sem ser medido.
  const ALLOWED = new Set(["vendor.json", ...REQUIRED.map((name) => name.toLowerCase())]);

  const lstatOrNull = (file) => {
    try {
      return fs.lstatSync(file);
    } catch {
      return null;
    }
  };
  const norm = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));

  // ── Raiz e PARENTES: um junction acima do vendor também é um escape ───────
  const rootStat = lstatOrNull(dir);
  if (!rootStat) {
    problems.push(`${requestedDir}: vendor ausente`);
    return result;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    problems.push(`${requestedDir}: vendor é um link/junction ou não é directório`);
    return result; // NÃO ler nada através de uma raiz inválida
  }
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync.native(dir);
  } catch {
    problems.push(`${requestedDir}: caminho não resolvível`);
    return result;
  }
  if (norm(resolvedRoot) !== norm(dir)) {
    problems.push(`${requestedDir}: caminho resolvido fora do vendor (link/junction num parent)`);
    return result; // um parent linkado já provou que a leitura não é confiável
  }

  // ── Travessia: recusa QUALQUER link antes de ler; junta colisões de caixa ─
  const onDisk = new Map();
  let walkFailed = false;
  const walk = (current, relBase) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      problems.push(`${relBase || "."}: directório ilegível`);
      walkFailed = true;
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const stat = lstatOrNull(full);
      if (!stat) {
        problems.push(`${rel}: inacessível`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        problems.push(`${rel}: link/junction recusado (não é seguido)`);
        continue;
      }
      if (stat.isDirectory()) {
        // A allowlist é PLANA: o extraResources copiaria este directório
        // inteiro (mesmo vazio) sem que nenhum ficheiro fosse medido.
        problems.push(`${rel}: subdirectório não permitido (a allowlist é plana)`);
        continue;
      }
      if (!stat.isFile()) {
        problems.push(`${rel}: não é ficheiro regular`);
        continue;
      }
      const key = rel.toLowerCase();
      if (onDisk.has(key)) {
        problems.push(`${rel}: colisão de maiúsculas/duplicado no disco`);
        continue;
      }
      onDisk.set(key, rel);
    }
  };
  walk(dir, "");
  if (walkFailed) return result;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    problems.push(`${manifestPath}: manifesto ausente ou ilegível (${error instanceof Error ? error.message : String(error)})`);
    return result;
  }
  if (manifest.engine !== "yara-classic") problems.push(`engine inesperado: ${JSON.stringify(manifest.engine)}`);
  if (manifest.version !== "4.6.0") problems.push(`versão inesperada: ${JSON.stringify(manifest.version)}`);
  if (manifest.license !== "BSD-3-Clause") problems.push(`licença inesperada: ${JSON.stringify(manifest.license)}`);
  if (!Array.isArray(manifest.files)) {
    problems.push("VENDOR.json sem lista `files`");
    return result;
  }

  // ── Manifesto: entradas exactas, sem duplicados nem subdirectórios ────────
  const declared = new Map();
  for (const entry of manifest.files) {
    const rel = String(entry.path ?? "").replaceAll("\\", "/");
    if (!rel || rel.includes("..") || path.isAbsolute(rel) || rel.includes("/")) {
      problems.push(`caminho inválido/não permitido no manifesto: ${rel}`);
      continue;
    }
    const key = rel.toLowerCase();
    if (!ALLOWED.has(key)) {
      problems.push(`${rel}: entrada não permitida no manifesto`);
      continue;
    }
    if (declared.has(key)) {
      problems.push(`${rel}: entrada duplicada/colisão de maiúsculas no manifesto`);
      continue;
    }
    declared.set(key, entry);
  }

  for (const name of REQUIRED) {
    if (!declared.has(name.toLowerCase())) problems.push(`${name}: ausente do VENDOR.json`);
  }

  // ── Conjunto exacto: qualquer ficheiro extra seria copiado pelo packaging ─
  for (const [key, rel] of onDisk) {
    if (!ALLOWED.has(key)) problems.push(`${rel}: ficheiro extra não listado (o extraResources copiá-lo-ia)`);
  }
  for (const key of ALLOWED) {
    if (key !== "vendor.json" && !onDisk.has(key)) problems.push(`${key}: ficheiro obrigatório ausente do disco`);
  }

  for (const name of REQUIRED) {
    const entry = declared.get(name.toLowerCase());
    if (!entry) continue;
    const file = path.join(dir, name);
    const stat = lstatOrNull(file);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      problems.push(`${name}: ausente ou não regular no disco`);
      continue;
    }
    result.filesChecked += 1;
    result.bytesChecked += stat.size;
    if (stat.size !== entry.bytes) {
      problems.push(`${name}: ${stat.size} B != ${entry.bytes} B declarados`);
      continue;
    }
    if (sha256OfFile(file) !== entry.sha256) {
      problems.push(`${name}: sha256 diferente do manifesto`);
    }
  }

  result.version = typeof manifest.version === "string" ? manifest.version : null;
  result.runtimeBundled = onDisk.has("vcruntime140.dll");
  result.ok = problems.length === 0;
  return result;
}

export function estadoManifestoObrigacao(file) {
  const stat = regularNonEmpty(file);
  const insuficiente = (detalhe, bloqueador = null) => ({ estado: "manifesto-insuficiente", detalhe, bloqueador, evidencias: [] });
  if (!stat.exists || !stat.regular || !(stat.bytes > 0)) {
    return insuficiente(`manifesto de proveniência em falta, vazio ou não regular em ${file}`);
  }
  let dados;
  try {
    dados = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (erro) {
    return insuficiente(`manifesto de proveniência ilegível em ${file}: ${erro instanceof Error ? erro.message : String(erro)}`);
  }
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
    return insuficiente(`o JSON em ${file} não é um objeto de manifesto`);
  }
  const obrigacao = dados.obrigacaoPorResolver;
  if (!obrigacao || typeof obrigacao !== "object" || Array.isArray(obrigacao)) {
    return insuficiente("o manifesto não declara `obrigacaoPorResolver`; não declarar a obrigação não é fechá-la");
  }
  const bruto = [].concat(obrigacao.evidencia ?? [], obrigacao.prova ?? []);
  const evidencias = bruto.filter((entrada) => typeof entrada === "string" && entrada.trim().length > 0).map((entrada) => entrada.trim());
  if (obrigacao.bloqueador === true) {
    const texto = typeof obrigacao.texto === "string" && obrigacao.texto.trim().length > 0
      ? obrigacao.texto.trim()
      : "obrigação declarada em aberto pelo próprio manifesto publicado";
    return { estado: "obrigacao-vigente", detalhe: texto, bloqueador: true, evidencias };
  }
  if (obrigacao.bloqueador === false) {
    if (evidencias.length === 0) {
      return insuficiente("o manifesto declara `bloqueador: false` sem qualquer evidência; encerrar uma obrigação exige prova registada, não a negação", false);
    }
    return {
      estado: "prova-fecha",
      detalhe: `obrigação encerrada com ${evidencias.length} entrada(s) de evidência registada no manifesto`,
      bloqueador: false,
      evidencias,
    };
  }
  return insuficiente(`\`obrigacaoPorResolver.bloqueador\` não é booleano (veio ${JSON.stringify(obrigacao.bloqueador) ?? "em falta"})`);
}

function checkReport() {
  const checks = preflightChecks({ clamavSeedDir });
  const seed = clamavSeedDir ? verifyClamavSeedBundle(clamavSeedDir) : null;
  // Integridade REAL do bundle (bytes + sha256 de cada ficheiro, fonte
  // correspondente e licenças). O `--check` nunca descarrega nada: isto é
  // apenas leitura do disco.
  const bundle = verifyClamavBundle();
  // Fontes congeladas: o `--check` falha se a árvore divergir do manifesto
  // aprovado (ou se o manifesto não existir). É um gate, não um relatório.
  const freeze = verifySourceFreeze();
  const licensing = estadoManifestoObrigacao(path.join(licensesDir, "PROVENANCE.json"));
  const yara = verifyYaraVendor();
  return {
    ok: checks.every((check) => check.exists) && bundle.ok && yara.ok && freeze.ok && !clamavSeedDir && licensing.estado === "prova-fecha",
    licensing,
    yara: {
      ok: yara.ok,
      version: yara.version,
      filesChecked: yara.filesChecked,
      bytesChecked: yara.bytesChecked,
      runtimeBundled: yara.runtimeBundled,
      problems: yara.problems,
    },
    mode: "check",
    flags: { dir: dirOnly, keep: keepStaging, check: checkOnly },
    builds: [...BUILD_WORKSPACES.map((w) => `npm run build -w ${w}`), "node scripts/stage-renderer.mjs"],
    packages: WORKSPACE_PACKAGES,
    outputs: { unpacked: path.join(outDir, "win-unpacked"), installerDir: outDir, target: dirOnly ? "win-unpacked (--dir)" : "nsis x64" },
    electronVersion: readJsonIfPresent(path.join(root, "node_modules", "electron", "package.json"))?.version ?? null,
    staging: { created: false, removedOnSuccess: !keepStaging },
    bundle: {
      ok: bundle.ok,
      version: bundle.version,
      manifestPath: bundle.manifestPath,
      filesChecked: bundle.filesChecked,
      bytesChecked: bundle.bytesChecked,
      licenses: bundle.licenses,
      sourceBundled: bundle.sourceBundled,
      problems: bundle.problems,
    },
    freeze: {
      ok: freeze.ok,
      manifestPath: freeze.manifestPath,
      manifestPresent: freeze.manifestPresent,
      digest: freeze.manifestDigest,
      counts: freeze.counts,
      problems: freeze.problems.slice(0, 20),
    },
    seed: seed
      ? { ok: false, integrityOk: seed.ok, dir: seed.dir, filesChecked: seed.filesChecked, bytesChecked: seed.bytesChecked, version: seed.version, problems: [...seed.problems, "CLAMAV_SEED_NATIVE_BOUNDARY_REQUIRED: integridade não prova publicação segura"] }
      : { ok: false, dir: null, publicationEnabled: false, problems: ["CLAMAV_SEED_NATIVE_BOUNDARY_REQUIRED: candidata bloqueada independentemente da cache disponível"] },
    checks: checks.map(({ id, exists, path: checkPath, fix }) => ({ id, exists, path: checkPath, fix })),
  };
}

/**
 * Apaga o staging APENAS se for realmente uma árvore criada por este script
 * (em %TEMP% e com o prefixo do `mkdtempSync`). Nunca apaga um caminho arbitrário.
 */
function removeStagingIfOurs(dir) {
  if (!dir) return false;
  const tmpRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== tmpRoot) return false;
  if (!path.basename(resolved).startsWith("cybersafe-package-")) return false;
  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}

function runPipeline() {
  /** Staging desta execução (null no `--check`, que não cria nada). */
  let stagingRoot = null;

  // Um build falhado sai com código != 0: nesse caso o staging fica para inspeção.
  process.on("exit", (code) => {
    if (code === 0 && !keepStaging && stagingRoot) removeStagingIfOurs(stagingRoot);
  });

  // ── 0. Pré-verificação dos inputs ──────────────────────────────────────────
  // Sem esta lista, uma cópia de workspace esquecida só rebentava a meio (depois
  // de gastar minutos no `npm install` da árvore) ou — pior — o pacote saía com
  // `dist` antigo, porque o passo 1 compilava uns pacotes e o passo 3 copiava
  // outros sem os compilar.
  // Mesmo bloqueador documental que o --check; antes de builds/staging.
  const licensing = estadoManifestoObrigacao(path.join(licensesDir, "PROVENANCE.json"));
  if (licensing.estado !== "prova-fecha") {
    console.error(`[package] BLOQUEIO ${licensing.estado === "obrigacao-vigente" ? "licencas-obrigacao-em-aberto" : "licencas-manifesto-de-obrigacao-insuficiente"}: ${licensing.detalhe}`);
    process.exit(1);
  }
  if (candidateId || clamavSeedDir) {
    console.error("[package] CLAMAV_SEED_NATIVE_BOUNDARY_REQUIRED: candidata bloqueada até publicação nativa segura e revisão; nada foi empacotado");
    process.exit(1);
  }
  const missingInputs = preflightChecks({ clamavSeedDir }).filter((check) => !check.exists);
  if (missingInputs.length > 0) {
    for (const check of missingInputs) {
      log(`FALTA ${check.id}  ${check.path}  → ${check.fix}`);
    }
    console.error(`[package] pré-verificação falhou: ${missingInputs.length} input(s) em falta (corre \`--check\` para a lista completa)`);
    process.exit(1);
  }

  // Integridade REAL do bundle ClamAV antes de compilar/empacotar: um bundle
  // corrompido, sem licenças ou sem a fonte correspondente NÃO entra no
  // artefacto. Este passo só LÊ o disco — o pipeline nunca descarrega o bundle
  // por conta própria (isso é do `vendor-clamav.mjs`, pedido explicitamente).
  const bundleCheck = verifyClamavBundle();
  if (!bundleCheck.ok) {
    for (const problem of bundleCheck.problems) log(`BUNDLE ${problem}`);
    console.error("[package] bundle ClamAV inválido: nada foi empacotado");
    process.exit(1);
  }
  log(`     bundle ClamAV ok: ${bundleCheck.filesChecked} ficheiros, ${(bundleCheck.bytesChecked / 1024 / 1024).toFixed(1)} MiB, versão ${bundleCheck.version}${bundleCheck.sourceBundled ? ", fonte correspondente incluída" : ""}`);

  // YARA clássico: bytes e sha256 do executável, licença E runtime app-local.
  // A existência do `.exe` não prova que o loader encontra VCRUNTIME140.dll ao
  // lado dele — o modo de falha medido na VM016. Falha FECHADO.
  const yaraCheck = verifyYaraVendor();
  if (!yaraCheck.ok) {
    for (const problem of yaraCheck.problems) log(`YARA ${problem}`);
    console.error("[package] vendor/yara inválido: nada foi empacotado");
    process.exit(1);
  }
  log(`     YARA clássico ok: ${yaraCheck.filesChecked} ficheiros, ${yaraCheck.bytesChecked} B, versão ${yaraCheck.version}${yaraCheck.runtimeBundled ? ", VCRUNTIME140 app-local" : ""}`);

  // ── 0c. Pins de versão do staging (TP-QA2-PACKAGING-ENGINES) ───────────────
  // Antes de compilar/instalar: os manifestos dos workspaces têm de declarar a
  // versão EXACTA do lock para as dependências fixadas. Com `^`, o `npm install`
  // sem lock no staging resolveu better-sqlite3 12.11.1 e YARA-X 0.5.2/0.5.1 na
  // candidata QA1, fora do lock e dos avisos documentados. Falha aqui, cedo.
  const pinCheck = assertPinnedManifestSpecs({ root, lockFile: path.join(root, "package-lock.json") });
  if (!pinCheck.ok) {
    for (const problem of pinCheck.problems) log(`PIN ${problem.name}  ${problem.file}  → ${problem.detail}`);
    console.error("[package] pins de staging divergentes do lock: nada foi empacotado");
    process.exit(1);
  }
  for (const check of pinCheck.checks) {
    log(`     pin ${check.name} ${check.expected} (exacto em ${check.file})`);
  }

  // ── 0b. Fontes congeladas: gates PRE / PRE-builder / POS ───────────────────
  // O driver corre os três gates à volta dos passos do pipeline. Um gate que
  // falhe lança SourceFreezeError e o passo seguinte NÃO corre. Não há bypass
  // nem re-pin automático: o único caminho é um manifesto novo aprovado.
  let appDir = null;
  runFreezeGatedPipeline({
    stages: {
      workspaces: () => {
        const result = stageWorkspaces();
        stagingRoot = result.stagingRoot;
        appDir = result.appDir;
      },
      builder: () => stageBuilder(appDir),
      promote: () => stagePromote({ stagingRoot }),
    },
    onGateFail: (phase, freeze) => {
      logFreezeFailure(phase, freeze);
      if (phase !== "POS") return;
      const marker = markNotDeliverable(outDir, freeze);
      console.error(
        `[package] source-freeze: candidata NAO entregavel${marker ? ` (marcador: ${marker})` : ""} — artefactos preservados`,
      );
    },
  });
}

/**
 * Passos 1–7: compilar workspaces, staging, packs, instalação e higiene.
 *
 * Exportada para o ensaio E2E poder correr ESTE caminho de produção (não uma
 * reconstrução dos helpers): é aqui que os pins são verificados e os metadados
 * de instalação são removidos. Importar o módulo continua sem efeitos.
 */
export function stageWorkspaces() {
  let stagingRoot = null;
  const productVersion = readProductVersion({ root }).version;
  log(`     versão canónica do produto: ${productVersion} (${PRODUCT_VERSION_FILE})`);
  // ── 1. Compilar o que vai dentro do pacote ─────────────────────────────────
  log("1/8  compilar workspaces (dist) …");
  // `@cybersafe/native-windows` faz falta aqui: o passo 3 empacota o `dist` dele e
  // o `service` importa-o em runtime, mas era o único workspace que o pipeline
  // nunca reconstruía — o pacote podia sair com um `dist` de uma alteração antiga.
  for (const workspace of BUILD_WORKSPACES) {
    runNpm(["run", "build", "-w", workspace], { cwd: root });
  }
  run("node", [path.join(root, "scripts", "stage-renderer.mjs")], { cwd: root });
  const rendererIdentity = verifyBuiltRenderer({
    distDir: path.join(desktopDir, "dist"),
    version: productVersion,
  });
  if (!rendererIdentity.ok) {
    throw new Error(`renderer com identidade divergente: ${rendererIdentity.problems.join("; ")}`);
  }
  log(`     renderer: versão ${rendererIdentity.version}, commit ${rendererIdentity.commit ?? "desconhecido"}`);

  // ── 2. Árvore de trabalho fora do repositório ──────────────────────────────
  stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-package-"));
  const appDir = path.join(stagingRoot, "app");
  const slimDir = path.join(stagingRoot, "slim");
  const tarballDir = path.join(stagingRoot, "tarballs");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(slimDir, { recursive: true });
  fs.mkdirSync(tarballDir, { recursive: true });
  log(`2/8  staging em ${stagingRoot}`);

  // ── 3. Cópias mínimas dos pacotes do workspace (sem src/test/logs) ─────────
  // `logs` do serviço tem 249 MB de logs de runtime e `src`/`test` não são usados
  // em runtime (o dist é o artefacto). `definitions` É usado em runtime.
  log("3/8  preparar cópias do workspace …");
  for (const pkg of WORKSPACE_PACKAGES) {
    const source = path.join(root, "packages", pkg.dir);
    const target = path.join(slimDir, pkg.dir);
    fs.mkdirSync(target, { recursive: true });
    for (const entry of pkg.include) {
      const from = path.join(source, entry);
      if (!fs.existsSync(from)) throw new Error(`falta ${from} (corre \`--check\` para a lista completa)`);
      copyInto(from, path.join(target, entry));
    }

    // O `@prisma/client` está declarado na API mas NÃO tem um único import em
    // `src/` nem `dist/` (o adaptador é better-sqlite3 escrito à mão). Fica fora
    // do pacote: evita o postinstall do Prisma e ~50 MB de peso morto.
    if (pkg.name === "api") {
      const manifestPath = path.join(target, "package.json");
      const manifest = readJson(manifestPath);
      if (manifest.dependencies?.["@prisma/client"]) {
        delete manifest.dependencies["@prisma/client"];
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        log("     api: @prisma/client removido do manifesto do pacote (não usado em runtime)");
      }
    }
  }

  // ── 4. Empacotar cada pacote como tarball (cópias reais, zero symlinks) ────
  // Duas passagens: a 1.ª cria os tarballs, a 2.ª reescreve as dependências entre
  // pacotes do workspace (`@cybersafe/x: 0.1.1`) para `file:` do tarball local —
  // sem isto o npm tentaria a registry e rebentaria com 404 (pacotes privados).
  log("4/8  npm pack dos pacotes do workspace …");
  const tarballs = {};
  function packAll() {
    for (const pkg of WORKSPACE_PACKAGES) {
      const produced = runNpmCapture(
        ["pack", path.join(slimDir, pkg.dir), "--pack-destination", tarballDir],
        { cwd: stagingRoot },
      )
        .split(/\r?\n/)
        .filter((line) => line.endsWith(".tgz"))
        .pop();
      if (!produced) throw new Error(`npm pack não produziu tarball para ${pkg.name}`);
      tarballs[pkg.name] = path.join(tarballDir, path.basename(produced));
    }
  }
  packAll();

  for (const pkg of WORKSPACE_PACKAGES) {
    const manifestPath = path.join(slimDir, pkg.dir, "package.json");
    const manifest = readJson(manifestPath);
    let rewritten = 0;
    for (const [depName, depRange] of Object.entries(manifest.dependencies ?? {})) {
      const local = tarballs[depName];
      if (!local) continue;
      manifest.dependencies[depName] = `file:${toPosix(local)}`;
      rewritten += 1;
      void depRange;
    }
    if (rewritten > 0) {
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      log(`     ${pkg.name}: ${rewritten} dependência(s) do workspace → tarball local`);
    }
  }
  packAll();
  for (const pkg of WORKSPACE_PACKAGES) {
    log(`     ${pkg.name} → ${path.basename(tarballs[pkg.name])}`);
  }

  // ── 5. Manifesto da aplicação empacotada (com a config do desktop) ─────────
  const desktopManifest = readJson(path.join(desktopDir, "package.json"));
  const electronVersion = readJson(path.join(root, "node_modules", "electron", "package.json")).version;
  const scanEngine = path.join(root, "packages", "native-engine", "build", "Release", "scan-engine.exe");
  if (!fs.existsSync(scanEngine)) throw new Error(`scan-engine.exe ausente: ${scanEngine} (corre npm run build:native)`);

  const appManifest = buildAppManifest({ desktopManifest, tarballs, electronVersion, scanEngine, outDir, desktopDir, clamavSeedDir, candidateId, productVersion });
  fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify(appManifest, null, 2)}\n`);

  // ── 6. Conteúdo do shell (renderer + main + preload + assets) ──────────────
  log("5/8  copiar o shell desktop (dist) …");
  copyInto(path.join(desktopDir, "dist"), path.join(appDir, "dist"));

  // ── 7. Instalar a árvore de dependências REAL ─────────────────────────────
  log("6/8  npm install na árvore do pacote (pode demorar) …");
  runNpm(["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: appDir });

  // ── 7b. Higiene antes do empacotamento ────────────────────────────────────
  // O `npm install` escreveu `file:<tarball do staging>` nos manifestos; o
  // electron-builder empacotaria esses caminhos. Normalizar AQUI — depois do
  // install (a árvore tem de existir) e antes do builder (é ele que copia).
  log("6b/8 normalizar referências do staging (higiene do pacote) …");
  const normalization = normalizeStagingRefsUnderApp({
    appDir,
    tarballDir,
    internalNames: WORKSPACE_PACKAGES.map((pkg) => pkg.name),
  });
  for (const change of normalization.changes) {
    log(`     ${change.name} [${change.block}] ${change.from} → ${change.to}`);
  }
  log(`     ${normalization.changedFiles.length} manifesto(s) normalizado(s); 0 referências de staging restantes`);

  // ── 7a. Versões fixadas: medir o que o `npm install` instalou ─────────────
  // O staging não usa o lock do repositório; a versão exacta vem dos manifestos
  // (passo 0c) e é CONFIRMADA aqui antes de qualquer rebuild. Uma deriva pára o
  // build: ABI, hashes e avisos documentais deixariam de corresponder.
  // A expectativa é calculada AQUI (o lock é a fonte); fica no mesmo scope da
  // única utilização — não há variável atravessada entre funções.
  log("6a/8 verificar versões fixadas do staging …");
  const expectedVersions = expectedStagingVersions({ lockFile: path.join(root, "package-lock.json") });
  const stagedVersions = verifyStagedVersions(appDir, expectedVersions);
  for (const entry of stagedVersions.checked) {
    log(`     ${entry.name} ${entry.actual} (fixado ${entry.expected})`);
  }
  if (!stagedVersions.ok) {
    throw new Error(`deriva de versões no staging: ${describeStagingDrift(stagedVersions)}`);
  }

  // ── 7b. Metadados de instalação que não são de runtime ────────────────────
  // O `npm install` escreve dois lockfiles com `file:<tarball do staging>`; o
  // `node_modules/**` é empacotado e o caminho absoluto do build viajaria, além
  // de a verificação de staging recusar o marcador. Só estes dois ficheiros
  // saem — e o passo re-mede manifestos e addons para provar que nada de
  // runtime desapareceu.
  const installMetadata = stripStagingInstallMetadata({ appDir });
  if (installMetadata.removed.length > 0) {
    log(`     metadados de instalação removidos (não usados em runtime): ${installMetadata.removed.join(", ")}; ${installMetadata.preserved.manifests} manifesto(s) e ${installMetadata.preserved.addons} addon(s) preservados`);
  }

  // Addons nativos: reconstruir para a ABI do Electron e medir TODOS antes do
  // builder. Sem isto, um mismatch só apareceria na primeira abertura da DB.
  const native = prepareNativeAddons({
    appDir,
    electronVersion,
    targetAbi: electronAbi(electronVersion),
    headersRoot: process.env.CYBERSAFE_ELECTRON_HEADERS ?? path.join(os.homedir(), ".electron-gyp", electronVersion),
    cacheDir: path.join(stagingRoot, "native"),
    log,
  });
  log(`     addons nativos: ${native.addons.length} medidos, ${native.rebuilt.length} reconstruído(s) para ABI ${native.targetAbi}`);

  const safety = verifyStagingSafety(appDir, {
    forbiddenContent: [...new Set([root, toPosix(root), os.homedir(), toPosix(os.homedir()), stagingRoot, toPosix(stagingRoot)])],
  });
  if (!safety.ok) {
    for (const problem of safety.problems) log(`STAGING ${problem.code}: ${problem.path}`);
    throw new Error("staging recusado: dados privados, credenciais reconhecidas, links ou caminhos de DEV; nada foi empacotado");
  }
  log(`     staging medido: ${safety.filesChecked} ficheiros; sem violações reconhecidas (não é prova universal de ausência de segredos)`);
  return { appDir, stagingRoot };
}

/** Passo 8: electron-builder contra a árvore de staging. */
function stageBuilder(appDir) {
  // ── 8. electron-builder ───────────────────────────────────────────────────
  log(`7/8  electron-builder (${dirOnly ? "--win dir" : "instalador NSIS"}) …`);
  const electronBuilderCli = path.join(root, "node_modules", "electron-builder", "cli.js");
  run("node", [electronBuilderCli, "--win", ...(dirOnly ? ["dir"] : [])], { cwd: appDir });

}

/** Declaração final da candidata (só corre com os três gates verdes). */
function stagePromote({ stagingRoot }) {
  const winUnpacked = path.join(outDir, "win-unpacked");
  const asar = path.join(winUnpacked, "resources", "app.asar");
  const unpacked = path.join(winUnpacked, "resources", "app.asar.unpacked");
  const exe = fs.existsSync(winUnpacked)
    ? fs.readdirSync(winUnpacked).find((entry) => entry.endsWith(".exe") && !/^Uninstall/i.test(entry))
    : null;

  log("8/8  artefactos:");
  for (const file of [exe && path.join(winUnpacked, exe), asar, unpacked].filter(Boolean)) {
    if (!fs.existsSync(file)) {
      log(`     AUSENTE: ${file}`);
      continue;
    }
    const stats = fs.statSync(file);
    log(`     ${stats.isDirectory() ? "dir " : "file"} ${(stats.size / 1024 / 1024).toFixed(1)} MB  ${file}`);
  }
  const setup = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).find((entry) => entry.endsWith(".exe") && /setup/i.test(entry))
    : null;
  if (setup) log(`     instalador: ${path.join(outDir, setup)}`);
  log(keepStaging ? `     staging mantido (--keep): ${stagingRoot}` : `     staging removido no fim desta execução (usa --keep para o inspecionar): ${stagingRoot}`);
}


if (isMain) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  if (checkOnly) {
    const report = checkReport();
    if (jsonOut) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      log("pré-verificação (--check): nada é compilado, instalado ou empacotado");
      for (const check of report.checks) {
        log(`${check.exists ? "OK   " : "FALTA"} ${check.id}  ${check.path}${check.exists ? "" : `  → ${check.fix}`}`);
      }
      log(
        report.bundle.ok
          ? `OK    bundle-clamav  ${report.bundle.manifestPath}  (${report.bundle.filesChecked} ficheiros, ${(report.bundle.bytesChecked / 1024 / 1024).toFixed(1)} MiB, ${report.bundle.licenses} licenças, versão ${report.bundle.version}${report.bundle.sourceBundled ? ", fonte correspondente incluída" : ""})`
          : `FALTA bundle-clamav  ${report.bundle.manifestPath}  → ${VENDOR_FIX}`,
      );
      for (const problem of report.bundle.problems) log(`      bundle: ${problem}`);
      for (const problem of report.freeze.problems) {
        log(`      fontes: ${problem.kind}  ${problem.path}${problem.detail ? `  ${problem.detail}` : ""}`);
      }
      const missing = report.checks.filter((check) => !check.exists);
      if (report.licensing.estado !== "prova-fecha") {
        console.error(`[package] BLOQUEIO ${report.licensing.estado === "obrigacao-vigente" ? "licencas-obrigacao-em-aberto" : "licencas-manifesto-de-obrigacao-insuficiente"}: ${report.licensing.detalhe}`);
      }
      const problems = missing.length + report.bundle.problems.length + report.freeze.problems.length + (report.licensing.estado === "prova-fecha" ? 0 : 1);
      log(
        problems === 0
          ? "pré-verificação: inputs presentes, bundle íntegro, fontes congeladas e obrigação documental encerrada; não comprova instalação"
          : `pré-verificação: ${problems} problema(s) (o bundle é verificado byte a byte; as fontes contra o manifesto aprovado; nada é descarregado aqui)`,
      );
    }
    process.exit(report.ok ? 0 : 1);
  }

  try {
    runPipeline();
  } catch (error) {
    if (error?.name === "SourceFreezeError") {
      // Mensagem curta e distinta de falhas de tooling: o gate é um bloqueio
      // deliberado, não um erro de comando. Saída != 0 e artefactos intactos.
      console.error(`[package] source-freeze (${error.phase}): build bloqueado — nada foi promovido`);
      process.exit(1);
    }
    console.error(`[package] falhou: ${error?.stack ?? error}`);
    process.exit(1);
  }
}
