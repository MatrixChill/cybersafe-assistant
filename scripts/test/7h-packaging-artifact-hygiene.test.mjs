/**
 * TESTES DE HIGIENE DO ARTEFACTO EMPACOTADO (só leitura).
 *
 * Isto é a parte do instalador que um build VERDADEIRO prova e que um relatório
 * não prova: o que está DENTRO do `app.asar` que vai ser distribuído. Não
 * compila, não instala e não abre janelas — abre o `app.asar` do último
 * `win-unpacked` e conta o que lá está.
 *
 * Regras que ficam provadas:
 *   1. o runtime que a aplicação precisa está dentro do asar (main, preload,
 *      renderer, api, service, core, shared-types e as definições YARA/hashes);
 *   2. os módulos nativos estão FORA do asar (não podem ser carregados de lá);
 *   3. não há segredos, bases de dados, logs, sourcemaps nem vestígios de DEV no
 *      pacote (o `@prisma` é declarado pela API mas não é usado em runtime);
 *   4. nenhum caminho do build (staging em %TEMP%) nem da máquina que construiu
 *      viaja dentro do pacote — em NENHUM manifesto, não só no raiz. Este é o
 *      teste que fica vermelho até a próxima build: medido a 13/10, o artefacto
 *      de 11/10 levava 10 referências a caminhos de staging em cinco ficheiros.
 *
 * Sem artefacto, os testes dizem que SALTARAM — nunca PASS. Um PASS que não
 * mediu nada é pior do que uma ausência declarada.
 *
 * Uso: node --test scripts/test/7h-packaging-artifact-hygiene.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const WIN_UNPACKED = path.join(REPO_ROOT, "packages", "desktop", "release", "win-unpacked");
const ASAR = path.join(WIN_UNPACKED, "resources", "app.asar");

const hasArtifact = fs.existsSync(ASAR);

/** Lista as entradas do asar normalizadas para POSIX e sem `/` inicial. */
async function asarEntries() {
  const { listPackage } = await import("@electron/asar");
  return new Set(
    listPackage(ASAR).map((entry) => entry.replace(/\\/g, "/").replace(/^\//, "")),
  );
}

/**
 * Ficheiros do asar cujo CONTEÚDO contém um dos marcadores procurados.
 * O Windows do `@electron/asar` lista com `\` inicial, que não é caminho válido
 * para `extractFile`: normaliza-se antes de extrair.
 */
async function filesContainingMarkers(markers) {
  const asar = await import("@electron/asar");
  const entries = asar.listPackage(ASAR).map((entry) =>
    entry.startsWith("\\") ? entry.slice(1) : entry,
  );
  const hits = [];
  for (const entry of entries) {
    let content;
    try {
      content = asar.extractFile(ASAR, entry);
    } catch {
      continue; // diretórios não são extraíveis
    }
    const text = content.toString("latin1");
    const found = markers.filter((marker) => text.includes(marker));
    if (found.length > 0) hits.push({ entry: entry.replace(/\\/g, "/"), markers: found });
  }
  return hits;
}

// ── O que o runtime da aplicação precisa de encontrar DENTRO do asar ─────────
const REQUIRED_IN_ASAR = [
  "dist/main.js",
  "dist/preload.cjs",
  "dist/index.html",
  "node_modules/api/dist/index.js",
  "node_modules/@cybersafe/service/dist/index.js",
  "node_modules/@cybersafe/service/definitions/yara/default.yar",
  "node_modules/@cybersafe/service/definitions/hashes/default.json",
  "node_modules/@cybersafe/core/dist/index.js",
  "node_modules/@cybersafe/shared-types/dist/index.js",
  "node_modules/@cybersafe/native-windows/dist/index.js",
  // Manifestos dos pacotes internos de RUNTIME: provam que a inclusão das
  // dependências do workspace é real no pacote (e não só declarada no config).
  "node_modules/@cybersafe/core/package.json",
  "node_modules/@cybersafe/service/package.json",
  "node_modules/@cybersafe/shared-types/package.json",
  "node_modules/@cybersafe/native-windows/package.json",
  "node_modules/api/package.json",
];

/**
 * Marcadores que NÃO podem existir no pacote: caminhos do build e da máquina.
 * `cybersafe-package-` é o prefixo do staging em %TEMP%; os outros vêm do
 * ambiente onde a build corre, por isso são derivados aqui (não escritos à mão).
 */
const BUILD_PATH_MARKERS = [
  "cybersafe-package-",
  os.tmpdir(),
  os.tmpdir().replace(/\\/g, "/"),
  os.homedir(),
  os.homedir().replace(/\\/g, "/"),
  REPO_ROOT,
  REPO_ROOT.replace(/\\/g, "/"),
];

// ── O que NÃO pode viajar para o computador de outra pessoa ─────────────────
// Lista escrita de propósito de forma independente da do probe: um erro numa
// das cópias não pode esconder-se na outra.
const FORBIDDEN_IN_ASAR = [
  { id: "segredo (.env)", re: /(^|\/)\.env(\.|$|\/)/i },
  { id: "base de dados (.sqlite/.db)", re: /\.(sqlite3?|db)$/i },
  { id: "logs de runtime (logs/)", re: /(^|\/)logs?\//i },
  { id: "ficheiro de log (*.log)", re: /\.log$/i },
  { id: "sourcemap de dev (*.map)", re: /\.map$/i },
  { id: "prisma (declarado mas não usado em runtime)", re: /(^|\/)(@prisma|prisma)(\/|$)/i },
  // Os NOSSOS pacotes viajam só como dist. Uma dependência de terceiros pode
  // publicar o próprio src (o `openai` publica `node_modules/openai/src/**/*.ts`,
  // medido a 13/10: 298 ficheiros) — isso é peso morto, reportado no handoff,
  // não uma violação deste invariante.
  { id: "fontes dos nossos pacotes (@cybersafe/*/src)", re: /(^|\/)node_modules\/@cybersafe\/[^/]+\/src\//i },
];

describe("higiene do artefacto empacotado", () => {
  it("o app.asar do último build é legível", (t) => {
    if (!hasArtifact) {
      t.skip(`sem artefacto em ${WIN_UNPACKED} — corre \`npm run dist:dir -w @cybersafe/desktop\` (janela de build) antes de medir`);
      return;
    }
    assert.ok(fs.statSync(ASAR).isFile(), `${ASAR} tem de ser um ficheiro`);
  });

  it("o runtime que a aplicação precisa está dentro do asar", async (t) => {
    if (!hasArtifact) {
      t.skip("sem artefacto para inspecionar");
      return;
    }
    const entries = await asarEntries();
    const missing = REQUIRED_IN_ASAR.filter((entry) => !entries.has(entry));
    assert.deepEqual(missing, [], `entradas em falta no app.asar: ${missing.join(", ")}`);
  });

  it("os módulos nativos estão FORA do asar (não podem ser carregados de dentro dele)", (t) => {
    if (!hasArtifact) {
      t.skip("sem artefacto para inspecionar");
      return;
    }
    const unpacked = path.join(WIN_UNPACKED, "resources", "app.asar.unpacked");
    for (const entry of [
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    ]) {
      assert.ok(fs.existsSync(path.join(unpacked, entry)), `tem de estar desempacotado: ${entry}`);
    }
    assert.ok(
      fs.existsSync(path.join(WIN_UNPACKED, "resources", "scan-engine.exe")),
      "o scan-engine.exe vem por extraResources, fora do asar",
    );
  });

  it("BITE (esperado RED até à próxima build): nenhum caminho do build nem da máquina dentro do pacote", async (t) => {
    if (!hasArtifact) {
      t.skip("sem artefacto para inspecionar");
      return;
    }
    // MEDIDO no artefacto de 11/10: 10 referências a
    // `file:C:/Users/<user>/AppData/Local/Temp/cybersafe-package-XXX/tarballs/*.tgz`
    // em cinco manifestos: o raiz e os de @cybersafe/core, @cybersafe/service,
    // @cybersafe/native-windows e api. Este teste exige a ausência; a
    // normalização que a produz entra em vigor só na próxima build.
    const hits = await filesContainingMarkers(BUILD_PATH_MARKERS);
    assert.deepEqual(
      hits,
      [],
      `o pacote não pode levar caminhos do build: ${hits.map((h) => `${h.entry} [${h.markers.join(", ")}]`).join(" | ")}`,
    );
  });

  it("não há segredos, bases de dados, logs nem sourcemaps no pacote", async (t) => {
    if (!hasArtifact) {
      t.skip("sem artefacto para inspecionar");
      return;
    }
    const entries = await asarEntries();
    for (const { id, re } of FORBIDDEN_IN_ASAR) {
      const matches = [...entries].filter((entry) => re.test(entry));
      assert.deepEqual(matches.slice(0, 5), [], `o pacote não pode conter ${id}: ${matches.slice(0, 5).join(", ")}`);
    }
  });
});
