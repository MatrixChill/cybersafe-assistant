/**
 * Versão canónica do produto CyberSafe Assistant.
 *
 * PROBLEMA QUE ISTO RESOLVE (medido na candidata 0.1.10, 31/10/2026):
 * o número que o utilizador vê vinha de três sítios independentes e
 * discordantes — o instalador mostrava 0.1.8 (texto NSIS herdado de um
 * `installer.nsh` de 5 linhas), o renderer mostrava 0.1.9 (`__BUILD__`
 * embutido no `vite build`) e o `app.getVersion()` dizia 0.1.10 (manifesto do
 * pacote). Nenhum deles era derivado de uma fonte única, por isso podiam
 * divergir sem que nada falhasse.
 *
 * REGRA: `product-version.json` na raiz é a ÚNICA fonte. O pipeline injecta-a
 *   - no manifesto da aplicação empacotada (=> `.VERSION` do NSIS, janela
 *     "Sobre", `app.getVersion()`, nome do artefacto);
 *   - no renderer, por `CYBERSAFE_BUILD_VERSION` (=> `__BUILD__`, chip da
 *     barra lateral, página de Atualizações, relatório impresso).
 * Os `package.json` dos workspaces mantêm a versão INTERNA de cada pacote:
 * não são identidade do produto e não são apresentados ao utilizador.
 *
 * Este módulo é puro: lê e valida, não escreve nada durante um build. O único
 * comando que escreve é `--set`, explícito.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, "..");
export const PRODUCT_VERSION_FILE = "product-version.json";

/**
 * Semver estrito o suficiente para o electron-builder: `1.2.3` com sufixo
 * opcional de pré-lançamento. Recusa espaços, barras e `+build` (que o nome do
 * artefacto não aceita sem escapar).
 */
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

export function isValidVersion(value) {
  return typeof value === "string" && VERSION_RE.test(value);
}

/** Caminho do ficheiro canónico dentro de uma árvore. */
export function productVersionPath({ root = DEFAULT_ROOT } = {}) {
  return path.join(root, PRODUCT_VERSION_FILE);
}

/**
 * Lê a versão canónica.
 * Falha FECHADO: ficheiro ausente, ilegível ou versão inválida são erro, nunca
 * um valor por omissão. Um build com versão inventada é pior do que sem build.
 */
export function readProductVersion({ root = DEFAULT_ROOT } = {}) {
  const file = productVersionPath({ root });
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`${PRODUCT_VERSION_FILE}: ilegível (${error.code ?? error.message}); a versão do produto não pode ser inferida`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${PRODUCT_VERSION_FILE}: JSON inválido (${error.message})`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${PRODUCT_VERSION_FILE}: tem de ser um objeto`);
  }
  if (!isValidVersion(data.version)) {
    throw new Error(`${PRODUCT_VERSION_FILE}: version inválida ${JSON.stringify(data.version)} (esperado 1.2.3 ou 1.2.3-sufixo)`);
  }
  return {
    version: data.version,
    productVersion: data.version.split("-")[0],
    windowsVersion: `${data.version.split("-")[0]}.0`,
    channel: typeof data.channel === "string" ? data.channel : null,
    codename: typeof data.codename === "string" ? data.codename : null,
  };
}

/**
 * Escreve a versão canónica. Recusa versões inválidas e recusa "escrever o
 * mesmo" (não mascara um pedido enganado).
 * Devolve o que mudou, para o relatório de build.
 */
export function setProductVersion(next, { root = DEFAULT_ROOT, dryRun = false } = {}) {
  if (!isValidVersion(next)) {
    throw new Error(`versão inválida ${JSON.stringify(next)}; esperado 1.2.3 ou 1.2.3-sufixo`);
  }
  const file = productVersionPath({ root });
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    current = { version: next, channel: "internal", codename: null };
    if (!/^[0-9]+\.[0-9]+\.[0-9]+-/.test(next)) {
      throw new Error("primeira definição da versão exige uma variante com sufixo (ex.: 0.1.11-internal)");
    }
  }
  if (current.version === next) {
    return { changed: false, previous: current.version, version: next, file, written: false };
  }
  const nextData = { ...current, version: next };
  if (!dryRun) {
    fs.writeFileSync(file, `${JSON.stringify(nextData, null, 2)}\n`);
  }
  return { changed: true, previous: typeof current.version === "string" ? current.version : null, version: next, file, written: !dryRun };
}

/**
 * Verifica o renderer COMPILADO. Não confia no nome do ficheiro nem no
 * manifesto: lê os bytes que vão ser servidos e extrai o `__BUILD__` que o
 * `vite build` inlined.
 *
 * Devolve todas as identidades encontradas. O aceite exige exactamente uma
 * versão, igual à canónica; um `commit` "desconhecido" é registado como aviso
 * (proveniência fraca), não como falha, porque o build pode correr fora de git.
 */
export function verifyBuiltRenderer({ distDir, version, allowCommitUnknown = true } = {}) {
  const result = { ok: false, version: null, identities: [], problems: [], commit: null, commitKnown: false };
  if (typeof distDir !== "string" || !fs.existsSync(distDir)) {
    result.problems.push(`renderer não encontrado: ${distDir}`);
    return result;
  }
  const assets = path.join(distDir, "assets");
  const dirs = fs.existsSync(assets) ? [assets] : [distDir];
  const files = [];
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(dir, entry.name));
    }
  }
  if (files.length === 0) {
    result.problems.push(`sem ficheiros .js em ${assets}`);
    return result;
  }
  // O define chega ao bundle minificado como `{version:`x`,buildId:`y`,commit:`z`,...}`.
  const pattern = /version:\s*[`"']([^`"']{1,80})[`"']\s*,\s*buildId:\s*[`"']([^`"']{0,40})[`"']\s*,\s*commit:\s*[`"']([^`"']{0,40})[`"']/g;
  const seen = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      // O renderer contém o fallback explícito de desenvolvimento
      // (`desconhecida/desenvolvimento/desconhecido`) no mesmo bundle. Não é
      // uma segunda build: é o ramo que corre fora do Vite. Contá-lo como
      // identidade faria qualquer build de produção falhar sem haver mistura
      // real de versões.
      if (match[1] === "desconhecida" && match[2] === "desenvolvimento" && match[3] === "desconhecido") {
        continue;
      }
      const key = `${match[1]}|${match[2]}|${match[3]}`;
      if (!seen.has(key)) {
        seen.set(key, { version: match[1], buildId: match[2], commit: match[3], files: [] });
      }
      seen.get(key).files.push(path.basename(file));
    }
  }
  result.identities = [...seen.values()];
  if (result.identities.length === 0) {
    result.problems.push("nenhum __BUILD__ embutido no renderer (build sem define de identidade)");
    return result;
  }
  const versions = new Set(result.identities.map((entry) => entry.version));
  if (versions.size > 1) {
    result.problems.push(`renderer com ${versions.size} versões diferentes: ${[...versions].join(", ")}`);
    return result;
  }
  result.version = [...versions][0];
  if (result.version !== version) {
    result.problems.push(`renderer diz ${result.version} mas a versão canónica é ${version}`);
    return result;
  }
  const commit = result.identities[0].commit;
  result.commit = commit;
  result.commitKnown = /^[0-9a-f]{7,40}$/.test(String(commit));
  if (!result.commitKnown && !allowCommitUnknown) {
    result.problems.push(`commit do renderer não é um SHA: ${JSON.stringify(commit)}`);
  }
  result.ok = result.problems.length === 0;
  return result;
}

/** Linhas legíveis para o log do pipeline. */
export function describeProductVersion({ root = DEFAULT_ROOT } = {}) {
  try {
    const info = readProductVersion({ root });
    return `versão do produto ${info.version}${info.codename ? ` (${info.codename})` : ""} — fonte ${PRODUCT_VERSION_FILE}`;
  } catch (error) {
    return `versão do produto ILEGÍVEL — ${error.message}`;
  }
}

function usage() {
  return [
    "Uso: node scripts/app-version.mjs [--check] [--json]",
    "     node scripts/app-version.mjs --set <versão> [--dry-run]",
    "     node scripts/app-version.mjs --verify-renderer <dist>",
    "",
    `  A fonte canónica é ${PRODUCT_VERSION_FILE} na raiz.`,
    "  --check            lê e valida; exit 1 se ausente/inválida",
    "  --set <versão>     escreve a versão canónica (1.2.3 ou 1.2.3-sufixo)",
    "  --verify-renderer  confere o __BUILD__ embutido em <dist>/assets/*.js",
  ].join("\n");
}

function main(argv) {
  const json = argv.includes("--json");

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (argv.includes("--set")) {
    const value = argv[argv.indexOf("--set") + 1];
    const out = setProductVersion(value, { dryRun: argv.includes("--dry-run") });
    console.log(json ? JSON.stringify(out, null, 2) : `${out.changed ? "versão" : "versão (sem alteração)"}: ${out.version}${out.previous ? ` (antes ${out.previous})` : ""}${out.written ? "" : " [dry-run]"}`);
    return 0;
  }

  if (argv.includes("--verify-renderer")) {
    const dist = argv[argv.indexOf("--verify-renderer") + 1];
    const { version } = readProductVersion();
    const out = verifyBuiltRenderer({ distDir: path.resolve(dist ?? ""), version });
    console.log(json ? JSON.stringify(out, null, 2) : `${out.ok ? "renderer OK" : "renderer REPROVADO"}: ${out.identities.map((i) => `${i.version} (${i.buildId}, commit ${i.commit})`).join("; ")}`);
    if (!out.ok) for (const problem of out.problems) console.error(`  ${problem}`);
    return out.ok ? 0 : 1;
  }

  const info = readProductVersion();
  console.log(json ? JSON.stringify(info, null, 2) : describeProductVersion());
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`[app-version] ${error.message}`);
    process.exit(1);
  }
}
