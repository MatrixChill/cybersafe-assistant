/**
 * Sonda de runtime do STAGING (TP-QA2-PACKAGING-ENGINES).
 *
 * Corre DENTRO do Electron da versão empacotada (`ELECTRON_RUN_AS_NODE=1`), por
 * isso mede a ABI e os binários que o utilizador vai realmente carregar, não os
 * do Node do host. Recebe a árvore de staging e um caminho de base de dados em
 * %TEMP%; nunca abre o perfil do utilizador, nunca toca em U nem em Stable.
 *
 * Prova:
 *   1. better-sqlite3 da versão fixada carrega na ABI do Electron e faz
 *      CREATE/INSERT/SELECT, e o registo persiste depois de reabrir;
 *   2. @litko/yara-x (wrapper + binário nativo) carrega e COMPILA uma regra
 *      explícita de teste, que casa com um ficheiro benigno marcado.
 *
 * A regra de teste usa um marcador próprio (`CYBERSAFE_QA2_BENIGN_MARKER`).
 * Não usa a amostra padrão de teste de antivírus nem a regra-canário do
 * produto: o objectivo é provar o encadeamento do motor, não detecção.
 *
 * Uso: electron.exe --experimental-... probe.mjs <appDir> <dbPath> <benignFile>
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const [appDir, dbPath, benignFile] = process.argv.slice(2);
const requireFromApp = createRequire(path.join(appDir, "package.json"));
const result = {
  electronVersion: process.versions.electron ?? null,
  nodeVersion: process.versions.node,
  abi: process.versions.modules ? Number(process.versions.modules) : null,
  cwd: process.cwd(),
  betterSqlite3: { version: null, sqliteVersion: null, addonSha256: null, created: false, selected: false, persistedAfterReopen: null },
  yara: { wrapperVersion: null, nativeVersion: null, compiled: false, matched: false, matchedRules: [], error: null },
  error: null,
};

try {
  if (!appDir || !dbPath || !benignFile) throw new Error("uso: probe.mjs <appDir> <dbPath> <benignFile>");

  // ── SQLite real ────────────────────────────────────────────────────────────
  const sqliteModuleDir = path.join(appDir, "node_modules", "better-sqlite3");
  const sqlitePkg = JSON.parse(fs.readFileSync(path.join(sqliteModuleDir, "package.json"), "utf8"));
  result.betterSqlite3.version = sqlitePkg.version;
  const addon = path.join(sqliteModuleDir, "build", "Release", "better_sqlite3.node");
  result.betterSqlite3.addonSha256 = crypto.createHash("sha256").update(fs.readFileSync(addon)).digest("hex");
  const Database = requireFromApp("better-sqlite3");
  const db = new Database(dbPath);
  result.betterSqlite3.sqliteVersion = db.prepare("select sqlite_version() as v").get().v;
  db.exec("create table qa2_engines (id integer primary key, label text not null)");
  db.prepare("insert into qa2_engines (label) values (?)").run("qa2-packaging-engines");
  result.betterSqlite3.created = true;
  result.betterSqlite3.selected = Boolean(db.prepare("select id, label from qa2_engines").get());
  db.close();
  const reopened = new Database(dbPath, { readonly: true });
  result.betterSqlite3.persistedAfterReopen = reopened.prepare("select count(*) as n from qa2_engines").get().n;
  reopened.close();
  result.betterSqlite3.dbBytes = fs.statSync(dbPath).size;

  // ── YARA-X: motor carrega e compila uma regra de teste ─────────────────────
  const yaraDir = path.join(appDir, "node_modules", "@litko", "yara-x");
  result.yara.wrapperVersion = JSON.parse(fs.readFileSync(path.join(yaraDir, "package.json"), "utf8")).version;
  for (const candidate of [
    path.join(yaraDir, "node_modules", "@litko", "yara-x-win32-x64-msvc", "package.json"),
    path.join(appDir, "node_modules", "@litko", "yara-x-win32-x64-msvc", "package.json"),
  ]) {
    if (fs.existsSync(candidate)) {
      result.yara.nativeVersion = JSON.parse(fs.readFileSync(candidate, "utf8")).version;
      break;
    }
  }
  const { compile } = requireFromApp("@litko/yara-x");
  const testRule = [
    "rule cybersafe_qa2_benign_marker {",
    "  meta:",
    '    description = "Regra explicita de teste; nao e cobertura de malware"',
    "  strings:",
    '    $marker = "CYBERSAFE_QA2_BENIGN_MARKER"',
    "  condition:",
    "    $marker",
    "}",
  ].join("\n");
  const rules = compile(testRule);
  result.yara.compiled = true;
  const matches = rules.scanFile(benignFile);
  result.yara.matchedRules = matches.map((match) => match.ruleIdentifier ?? match.rule ?? match.identifier ?? "?").filter(Boolean);
  result.yara.matched = matches.length === 1;
} catch (error) {
  if (!result.error) result.error = error?.message ?? String(error);
  if (result.yara.compiled === false && /yara/i.test(String(error?.message))) {
    result.yara.error = error?.message ?? String(error);
  }
}

console.log(JSON.stringify(result));
