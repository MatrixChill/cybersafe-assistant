#!/usr/bin/env node
/**
 * source-freeze — manifesto SHA256 aprovado das fontes do empacotamento.
 *
 * O `package-windows.mjs` compila `src` e empacota o resultado. Sem um
 * manifesto aprovado, um build pode sair de fontes que ninguém aprovou.
 * Este script compara a árvore real com o manifesto e falha FECHADO (exit 1)
 * em: adicionado, removido, modificado, ilegível, leitura curta, ficheiro que
 * muda durante a leitura, link/junction, root em falta, manifesto ausente ou
 * inválido (schema/digest/caminhos/duplicados/colisões de maiúsculas).
 *
 * Cobertura: package.json, package-lock.json, tsconfig*, vite config e .npmrc da
 * raiz; scripts/**, packages/** (fontes, configs, assets, contratos) e assets/**
 * (branding e o corpus de licenças publicado), excepto
 * node_modules/dist/release/logs/coverage/build/output; scan-engine.exe e
 * vendor/clamav/VENDOR.json. `dist`/`release` são gerados e nunca entram.
 * `assets/licenses/THIRD-PARTY-NOTICES.txt` e `assets/licenses/PROVENANCE.json`
 * são obrigatórios mesmo num `--write`: sem eles o contrato nasce incompleto.
 * Segredos, perfis e dados de runtime em `assets/` fazem falhar (nunca são
 * fixados no manifesto). Diretórios/ficheiros que o walker exclui noutros roots
 * (`logs`, `dist`, `*.log`, …) também falham dentro de `assets/`: o que é
 * publicado não pode ficar fora do contrato em silêncio.
 * O hash do VENDOR.json NÃO prova os bytes do bundle ClamAV: isso continua a
 * ser feito pelo `verifyClamavBundle`.
 *
 * --approval é um registo operacional, não uma assinatura criptográfica: a
 * autoridade vem do processo do integrador autorizado, não do ficheiro.
 * Transferência temporária (2026-10-25): o Codex Lead atingiu o limite e o
 * utilizador autorizou o Freebuff 2 como único integrador da U. O aprovador
 * aceite é um só (`APPROVER`); quando a autoridade regressar ao Codex, esta
 * constante volta a "Codex Lead" — nunca se aceitam ambos em simultâneo.
 * O pipeline nunca corre `--write` e nunca re-pina sozinho.
 *
 * Uso: node scripts/source-freeze.mjs [--verify] [--json]
 *      node scripts/source-freeze.mjs --write --approval <ficheiro.json>
 * Códigos: 0 = ok, 1 = divergente/ilegível/manifesto inválido, 2 = uso.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = 1;
export const ALGORITHM = "sha256";
export const APPROVER = "Codex Lead";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, "..");
export const DEFAULT_MANIFEST = path.join(HERE, "source-freeze.approved.json");

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "release",
  "logs",
  "coverage",
  "build",
  "output",
  ".git",
  ".vite",
  "__pycache__",
]);
const EXCLUDED_FILES = [/\.log$/i, /\.tmp$/i, /\.tsbuildinfo$/i];
const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE"]);
/* `product-version.json` é a fonte única da versão que vai no instalador
   (`app-version.mjs`, `package-windows.mjs` e `stage-renderer.mjs` leem-na).
   Fora do conjunto congelado, um `--verify` verde não dizia nada sobre a versão
   distribuída — a aprovação tem de a cobrir, ou o congelamento aprova um binário
   cuja identidade ninguém aprovou.
   `vendor/yara` pelo mesmo motivo e com mais peso: os executáveis clássicos do
   YARA (yara64/yarac64/vcruntime140 + COPYING.txt) estão versionados neste repo,
   são usados pelo serviço para compilar regras e vão no pacote. Ficar de fora do
   digest era aprovar o código que os invoca sem aprovar o que é invocado. O
   `vendor/clamav` mantém-se por `VENDOR.json` (133 MB não versionados; a âncora
   correta é o SHA-256 do arquivo oficial que esse registo guarda). */
const ROOTS_REQUIRED = ["package.json", "package-lock.json", "product-version.json", "scripts", "packages", "assets", "vendor/yara"];
const ROOTS_OPTIONAL = [/^tsconfig(\..+)?\.json$/i, /^vite\.config\..+$/i, /^\.npmrc$/i];
const ROOTS_EXTRA = ["packages/native-engine/build/Release/scan-engine.exe", "vendor/clamav/VENDOR.json"];
/** Roots que têm de ser FICHEIROS: um link/pasta com esse nome nunca é fonte válida. */
const FILE_ROOTS = new Set(["package.json", "package-lock.json", "product-version.json", ...ROOTS_EXTRA]);
const isFileRoot = (rel) => FILE_ROOTS.has(rel) || ROOTS_OPTIONAL.some((re) => re.test(path.posix.basename(rel)));
const SAMPLE_LIMIT = 20;

/**
 * Recursos distribuídos que TÊM de estar no congelamento. Um manifesto gerado
 * sem eles nasceria incompleto e um `--verify` verde só provaria que a árvore
 * (já sem os textos) não mudou. São os mesmos dois ficheiros que o
 * `package-windows.mjs` exige no preflight.
 */
const REQUIRED_ASSETS = ["assets/licenses/THIRD-PARTY-NOTICES.txt", "assets/licenses/PROVENANCE.json"];

/**
 * Entradas que nunca podem ser congeladas como fonte em `assets/`: segredos,
 * perfis e dados de runtime. Fixá-las no manifesto não as torna publicáveis,
 * por isso a presença falha FECHADO em vez de ser ignorada.
 */
const FORBIDDEN_ASSET = [
  /(^|\/)\.env([^/]*)$/i,
  /\.(pfx|p12|pem|key|kdbx|jks)(\.[^/]*)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)([._-][^/]*)?$/i,
  /(^|\/)(profiles?|runtime-data|user-data|cache|tmp|logs?)(\/|$)/i,
];

/** Verdadeiro para caminhos debaixo de `assets/` (recursos publicados). */
export const isPublishedAsset = (rel) => rel === "assets" || rel.startsWith("assets/");

/** Motivo pelo qual uma entrada de `assets/` não pode ser congelada, ou null. */
export function forbiddenAssetEntry(rel) {
  if (!isPublishedAsset(rel)) return null;
  const hit = FORBIDDEN_ASSET.find((re) => re.test(rel));
  return hit ? "segredo/perfil/runtime não é fonte publicada" : null;
}

/** Recursos obrigatórios ausentes ou vazios, a partir das entries coletadas. */
export function requiredAssetProblems(entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const problems = [];
  for (const rel of REQUIRED_ASSETS) {
    const entry = byPath.get(rel);
    if (!entry) problems.push({ kind: "required-missing", path: rel, detail: "recurso obrigatório ausente da árvore" });
    else if (entry.bytes === 0) problems.push({ kind: "required-empty", path: rel, detail: "recurso obrigatório vazio" });
  }
  return problems;
}

export const DEFAULT_DEPS = {
  statSync: (file) => fs.statSync(file),
  lstatSync: (file) => fs.lstatSync(file),
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  readdirSync: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
  realpathSync: (file) => fs.realpathSync(file),
  existsSync: (file) => fs.existsSync(file),
  sleep: (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* espera curta e síncrona (o CLI é síncrono de propósito) */
    }
  },
};

const io = (deps) => ({ ...DEFAULT_DEPS, ...deps });

export class FreezeError extends Error {
  constructor(message, report = null) {
    super(message);
    this.name = "FreezeError";
    this.report = report;
  }
}

/** Caminho do manifesto: rejeita absolutos, traversal e separadores Windows. */
export function validateEntryPath(rel) {
  if (typeof rel !== "string" || rel.length === 0) return "empty";
  if (rel.includes("\\")) return "backslash";
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return "absolute";
  if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) return "traversal";
  return null;
}

/** Digest canónico (independente da ordem das entries). */
export function digestEntries(entries) {
  const canonical = JSON.stringify(
    [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => [entry.path, entry.bytes, entry.sha256]),
  );
  return createHash(ALGORITHM).update(canonical, "utf8").digest("hex");
}

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Roots do contrato; a verificação recalcula-as (manifesto não as pode encolher). */
export function sourceRoots({ root = DEFAULT_ROOT, deps = DEFAULT_DEPS } = {}) {
  const api = io(deps);
  const roots = [...ROOTS_REQUIRED];
  const problems = [];
  try {
    for (const entry of api.readdirSync(root)) {
      // Pelo NOME, não pelo tipo: um `.npmrc`/`tsconfig.json` que seja link ou
      // pasta tem de entrar no contrato para o walk o rejeitar (nunca passar).
      if (ROOTS_OPTIONAL.some((re) => re.test(entry.name))) roots.push(entry.name);
    }
  } catch (error) {
    // Fail-closed: sem conseguir listar a raiz não se sabe que configs existem,
    // por isso o contrato não pode ser dado por completo (nem "encolhido").
    problems.push({ kind: "unreadable", path: ".", detail: error?.code ?? "EACCES" });
  }
  return { roots: [...roots, ...ROOTS_EXTRA].sort(), problems };
}

function walk({ root, relRoot, api, problems }) {
  const files = [];
  const abs = path.join(root, relRoot);
  let stats;
  try {
    stats = api.lstatSync(abs);
  } catch (error) {
    problems.push({ kind: "missing-root", path: relRoot, detail: error?.code ?? "ENOENT" });
    return files;
  }
  if (stats.isSymbolicLink()) {
    problems.push({ kind: "link", path: relRoot, detail: "root é link/junction" });
    return files;
  }
  if (stats.isDirectory() && isFileRoot(relRoot)) {
    problems.push({ kind: "not-file", path: relRoot, detail: "root de ficheiro é pasta" });
    return files;
  }
  if (stats.isFile()) return [relRoot];
  if (!stats.isDirectory()) {
    problems.push({ kind: "not-file", path: relRoot, detail: "entrada especial" });
    return files;
  }
  const pending = [relRoot];
  while (pending.length > 0) {
    const relDir = pending.pop();
    let entries;
    try {
      entries = api.readdirSync(path.join(root, relDir));
    } catch (error) {
      problems.push({ kind: "unreadable", path: relDir, detail: error?.code ?? "EIO" });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        problems.push({ kind: "link", path: rel, detail: "link/junction na árvore" });
      } else if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) pending.push(rel);
        else if (isPublishedAsset(rel)) {
          // `assets/` alimenta recursos publicados (licenças via extraResources,
          // branding via sync-branding). Um diretório que o walker ignora noutros
          // roots não pode viajar para o pacote sem estar no manifesto.
          problems.push({ kind: "forbidden-asset", path: rel, detail: "diretório gerado/privado dentro de assets publicados" });
        }
      } else if (entry.isFile()) {
        if (!EXCLUDED_FILES.some((re) => re.test(entry.name))) files.push(rel);
        else if (isPublishedAsset(rel)) {
          problems.push({ kind: "forbidden-asset", path: rel, detail: "ficheiro gerado dentro de assets publicados" });
        }
      } else {
        problems.push({ kind: "not-file", path: rel, detail: "entrada especial" });
      }
    }
  }
  return files;
}

/** Lê bytes com estabilidade: 1 retry pequeno, nunca atenua mutação real. */
function hashStable({ root, rel, api }) {
  const abs = path.join(root, rel);
  let last = { kind: "unreadable", detail: "sem tentativas" };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const before = api.statSync(abs);
      if (!before.isFile()) return { kind: "not-file" };
      const buffer = api.readFileSync(abs);
      const after = api.statSync(abs);
      if (buffer.length !== before.size) {
        last = { kind: "short-read", detail: `${buffer.length}/${before.size}` };
      } else if (after.size !== before.size || Number(after.mtimeMs) !== Number(before.mtimeMs)) {
        return { kind: "mutated", detail: `${before.size}→${after.size} bytes` };
      } else {
        return { kind: "ok", bytes: buffer.length, sha256: createHash(ALGORITHM).update(buffer).digest("hex") };
      }
    } catch (error) {
      last = { kind: "unreadable", detail: error?.code ?? String(error) };
      if (!RETRYABLE.has(error?.code)) return last;
    }
    if (attempt === 1) api.sleep(40);
  }
  return last;
}

function collect({ root, api, roots, excluded = [] }) {
  const problems = [];
  const files = new Set();
  for (const relRoot of roots) for (const rel of walk({ root, relRoot, api, problems })) files.add(rel);

  const skip = new Set(excluded.filter(Boolean).map((file) => path.resolve(file)));
  const realRoot = api.realpathSync(root);
  const entries = [];
  for (const rel of [...files].sort()) {
    if (skip.has(path.resolve(root, rel))) continue;
    if (validateEntryPath(rel)) {
      problems.push({ kind: "invalid-path", path: rel, detail: validateEntryPath(rel) });
      continue;
    }
    const forbidden = forbiddenAssetEntry(rel);
    if (forbidden) {
      problems.push({ kind: "forbidden-asset", path: rel, detail: forbidden });
      continue;
    }
    try {
      if (!inside(realRoot, api.realpathSync(path.join(root, rel)))) {
        problems.push({ kind: "outside-root", path: rel, detail: "realpath fora da raiz" });
        continue;
      }
    } catch (error) {
      problems.push({ kind: "unreadable", path: rel, detail: error?.code ?? "EREALPATH" });
      continue;
    }
    const hashed = hashStable({ root, rel, api });
    if (hashed.kind !== "ok") problems.push({ kind: hashed.kind, path: rel, detail: hashed.detail });
    else entries.push({ path: rel, bytes: hashed.bytes, sha256: hashed.sha256 });
  }
  return { entries, problems };
}

function manifestProblems(manifest) {
  const problems = [];
  const add = (pathRel, detail) => problems.push({ kind: "manifest-invalid", path: pathRel, detail });
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    add("", "não é um objecto JSON");
    return problems;
  }
  if (manifest.schema !== SCHEMA) add("", `schema ${manifest.schema} ≠ ${SCHEMA}`);
  if (manifest.algorithm !== ALGORITHM) add("", `algorithm ${manifest.algorithm} ≠ ${ALGORITHM}`);
  const approval = manifest.approval;
  if (!approval || typeof approval !== "object") {
    add("", "approval ausente");
  } else {
    if (approval.approvedBy !== APPROVER) add("", `approvedBy "${approval.approvedBy}" ≠ "${APPROVER}"`);
    if (typeof approval.candidateId !== "string" || !approval.candidateId.trim()) add("", "candidateId vazio");
    if (typeof approval.approvedAt !== "string" || Number.isNaN(Date.parse(approval.approvedAt))) add("", "approvedAt inválido");
  }
  if (!Array.isArray(manifest.entries)) {
    add("", "entries não é array");
    return problems;
  }
  const exact = new Set();
  const folded = new Map();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object") {
      add("", "entry não é objecto");
      continue;
    }
    const bad = validateEntryPath(entry.path);
    if (bad) add(String(entry.path), bad);
    else if (exact.has(entry.path)) add(entry.path, "duplicado");
    else if (folded.has(entry.path.toLowerCase())) add(entry.path, `colisão de maiúsculas com ${folded.get(entry.path.toLowerCase())}`);
    else {
      exact.add(entry.path);
      folded.set(entry.path.toLowerCase(), entry.path);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) add(String(entry.path), "bytes inválido");
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) add(String(entry.path), "sha256 inválido");
  }
  if (typeof manifest.digest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.digest)) add("", "digest inválido");
  else if (problems.length === 0 && manifest.digest !== digestEntries(manifest.entries)) add("", "digest não corresponde às entries");
  if (!Array.isArray(manifest.roots) || manifest.roots.some((rootRel) => validateEntryPath(rootRel))) add("", "roots inválidos");
  return problems;
}

export function buildManifest({ root = DEFAULT_ROOT, approval, approvalPath = null, manifestPath = DEFAULT_MANIFEST, deps = DEFAULT_DEPS } = {}) {
  const api = io(deps);
  const { roots, problems: rootProblems } = sourceRoots({ root, deps: api });
  if (rootProblems.length > 0) throw new FreezeError("source-freeze: raiz ilegível", { problems: rootProblems });
  const { entries, problems } = collect({ root, api, roots, excluded: [manifestPath, approvalPath] });
  if (problems.length > 0) throw new FreezeError("source-freeze: árvore não legível por inteiro", { problems });
  const required = requiredAssetProblems(entries);
  if (required.length > 0) throw new FreezeError("source-freeze: recursos obrigatórios ausentes", { problems: required });
  return { schema: SCHEMA, algorithm: ALGORITHM, generatedAt: new Date().toISOString(), approval, roots, entries, digest: digestEntries(entries) };
}

export function validateApproval(approval, { root = DEFAULT_ROOT, approvalPath = "" } = {}) {
  const problems = [];
  const add = (detail) => problems.push({ kind: "approval-invalid", path: approvalPath, detail });
  if (!approval || typeof approval !== "object") return [{ kind: "approval-invalid", path: approvalPath, detail: "não é objecto" }];
  if (approval.approvedBy !== APPROVER) add(`approvedBy "${approval.approvedBy}" ≠ "${APPROVER}"`);
  if (typeof approval.candidateId !== "string" || !approval.candidateId.trim()) add("candidateId vazio");
  if (typeof approval.approvedAt !== "string" || Number.isNaN(Date.parse(approval.approvedAt))) add("approvedAt inválido");
  if (approvalPath && inside(path.resolve(root), path.resolve(approvalPath))) add("approval dentro da raiz");
  return problems;
}

export function verifySourceFreeze({ root = DEFAULT_ROOT, manifestPath = DEFAULT_MANIFEST, deps = DEFAULT_DEPS } = {}) {
  const api = io(deps);
  const report = {
    ok: false,
    mode: "verify",
    root,
    manifestPath,
    manifestPresent: api.existsSync(manifestPath),
    manifestDigest: null,
    treeDigest: null,
    counts: { manifest: 0, tree: 0, added: 0, removed: 0, modified: 0, unreadable: 0, links: 0, mutated: 0, required: 0 },
    problems: [],
    samples: { added: [], removed: [], modified: [], unreadable: [], links: [], mutated: [], required: [] },
  };
  if (!report.manifestPresent) {
    report.problems.push({ kind: "manifest-missing", path: manifestPath, detail: "sem manifesto aprovado" });
    return report;
  }
  let manifest;
  try {
    manifest = JSON.parse(api.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    report.problems.push({ kind: "manifest-invalid", path: manifestPath, detail: error?.message ?? "JSON inválido" });
    return report;
  }
  report.problems.push(...manifestProblems(manifest));
  if (report.problems.length > 0) return report;
  report.manifestDigest = manifest.digest;

  const { roots, problems: rootProblems } = sourceRoots({ root, deps: api });
  if (rootProblems.length > 0) {
    for (const problem of rootProblems) {
      report.problems.push(problem);
      report.counts.unreadable += 1;
      report.samples.unreadable.push({ path: problem.path, detail: problem.detail });
    }
    return report;
  }
  const declared = [...manifest.roots].sort();
  if (declared.length !== roots.length || declared.some((rel, index) => rel !== roots[index])) {
    report.problems.push({ kind: "roots-divergentes", path: "", detail: `manifesto=${declared.length}, contrato=${roots.length}` });
    return report;
  }

  const { entries, problems } = collect({ root, api, roots, excluded: [manifestPath] });
  for (const problem of problems) {
    const bucket = problem.kind === "link" || problem.kind === "outside-root" ? "links" : problem.kind === "mutated" ? "mutated" : "unreadable";
    report.problems.push(problem);
    report.counts[bucket] += 1;
    report.samples[bucket].push({ path: problem.path, detail: problem.detail });
  }
  if (problems.length > 0) return report;

  const required = requiredAssetProblems(entries);
  if (required.length > 0) {
    for (const problem of required) {
      report.problems.push(problem);
      report.counts.required += 1;
      report.samples.required.push({ path: problem.path, detail: problem.detail });
    }
    return report;
  }

  const tree = new Map(entries.map((entry) => [entry.path, entry]));
  const approved = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  report.counts.manifest = approved.size;
  report.counts.tree = tree.size;
  report.treeDigest = digestEntries(entries);
  for (const [rel, entry] of tree) {
    const expected = approved.get(rel);
    if (!expected) {
      report.counts.added += 1;
      report.samples.added.push({ path: rel, detail: `${entry.bytes} B` });
    } else if (expected.bytes !== entry.bytes || expected.sha256 !== entry.sha256) {
      report.counts.modified += 1;
      report.samples.modified.push({ path: rel, detail: `${expected.sha256.slice(0, 12)}→${entry.sha256.slice(0, 12)}` });
    }
  }
  for (const rel of approved.keys()) {
    if (!tree.has(rel)) {
      report.counts.removed += 1;
      report.samples.removed.push({ path: rel, detail: "ausente no disco" });
    }
  }
  for (const key of Object.keys(report.samples)) report.samples[key] = report.samples[key].slice(0, SAMPLE_LIMIT);

  const divergences = report.counts.added + report.counts.removed + report.counts.modified + report.counts.unreadable + report.counts.links + report.counts.mutated + report.counts.required;
  report.ok = divergences === 0;
  return report;
}

const usage = () =>
  [
    "Uso: node scripts/source-freeze.mjs [--verify] [--json] [--root <dir>] [--manifest <ficheiro>]",
    "     node scripts/source-freeze.mjs --write --approval <ficheiro.json> [--root <dir>] [--manifest <ficheiro>]",
    "",
    "  --verify    compara a árvore com o manifesto (por omissão); nunca escreve",
    "  --write     cria o manifesto; exige --approval e nunca é chamado pelo pipeline",
    `  --approval  registo {approvedBy:'${APPROVER}',candidateId,approvedAt}; não é assinatura`,
    "  --json      relatório legível por máquina",
    "",
    "Códigos de saída: 0 = ok, 1 = divergente/ilegível/manifesto inválido, 2 = uso.",
  ].join("\n");

function printReport(report, json) {
  if (json) return process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.ok) return console.log(`source-freeze: árvore conforme (${report.counts.tree} ficheiros, ${report.treeDigest})`);
  console.error("source-freeze: DIVERGENTE — build bloqueado");
  console.error(`  manifesto: ${report.manifestPath}${report.manifestPresent ? "" : " (ausente)"}`);
  for (const problem of report.problems) console.error(`  ${problem.kind}: ${problem.path} ${problem.detail ?? ""}`.trimEnd());
  for (const [kind, list] of Object.entries(report.samples)) {
    for (const item of list) console.error(`  ${kind}: ${item.path} ${item.detail ?? ""}`.trimEnd());
  }
  if (!report.problems.length) {
    const { added, removed, modified, unreadable, links, mutated, required } = report.counts;
    console.error(`  contagens: +${added} -${removed} ~${modified} ilegiveis=${unreadable} links=${links} mutados=${mutated} obrigatorios=${required}`);
  }
}

function main(argv) {
  const valued = new Set(["--approval", "--root", "--manifest"]);
  const known = new Set(["--verify", "--write", "--json", "--help", "-h", ...valued]);
  const options = { mode: "verify", json: false, approval: null, root: DEFAULT_ROOT, manifestPath: DEFAULT_MANIFEST };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!known.has(arg)) {
      console.error(`flag desconhecida: ${arg}`);
      console.error(usage());
      return 2;
    }
    if (valued.has(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`${arg} exige um valor`);
        return 2;
      }
      i += 1;
      if (arg === "--approval") options.approval = value;
      if (arg === "--root") options.root = path.resolve(value);
      if (arg === "--manifest") options.manifestPath = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return 0;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--write") options.mode = "write";
    else if (arg === "--verify") options.mode = "verify";
  }

  if (options.mode === "write") {
    if (!options.approval) {
      console.error("--write exige --approval (nunca há aprovação automática)");
      return 2;
    }
    let approval;
    try {
      approval = JSON.parse(fs.readFileSync(path.resolve(options.approval), "utf8"));
    } catch (error) {
      console.error(`approval ilegível: ${error?.message ?? error}`);
      return 1;
    }
    const problems = validateApproval(approval, { root: options.root, approvalPath: options.approval });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`${problem.kind}: ${problem.path} ${problem.detail}`);
      return 1;
    }
    try {
      const manifest = buildManifest({ root: options.root, approval, approvalPath: options.approval, manifestPath: options.manifestPath });
      const tmp = `${options.manifestPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, options.manifestPath);
      console.log(`source-freeze: ${options.manifestPath} (${manifest.entries.length} ficheiros, ${manifest.digest})`);
      return 0;
    } catch (error) {
      for (const problem of error?.report?.problems ?? []) console.error(`${problem.kind}: ${problem.path} ${problem.detail ?? ""}`.trimEnd());
      if (!error?.report) console.error(`source-freeze: falhou: ${error?.stack ?? error}`);
      return 1;
    }
  }

  const report = verifySourceFreeze({ root: options.root, manifestPath: options.manifestPath });
  printReport(report, options.json);
  return report.ok ? 0 : 1;
}

if (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
