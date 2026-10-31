/**
 * TESTES DO MANIFESTO EMPACOTADO (forma exata do que vai dentro do pacote).
 *
 * O `--check` mede os inputs do disco; estes testes medem a FORMA do manifesto
 * que o pipeline escreve em `app/package.json`, importando `buildAppManifest`
 * diretamente. É a única maneira de provar isto sem correr um build inteiro.
 *
 * O que fica provado:
 *   1. `productName` viaja no manifesto da app — sem ele, o Electron deriva o
 *      `userData` do `name` do pacote e a instalação grava tudo em
 *      `%APPDATA%\@cybersafe\desktop` (medido no app.asar entregue a 11/10);
 *   2. os módulos nativos ficam fora do asar (better-sqlite3 e o YARA-X);
 *   3. o `@prisma` não entra, apesar de a API o declarar;
 *   4. o ícone, o scan-engine.exe e a pasta de saída são caminhos absolutos e
 *      reais do repo;
 *   5. importar o módulo NÃO corre o pipeline (é importável sem efeitos);
 *   6. o bundle ClamAV (binários verificados + fonte correspondente) entra em
 *      `resources/clamav` — sem ele o pacote não leva motor nenhum;
 *   7. os avisos de terceiros entram em `resources/licenses` — o pacote
 *      distribui Electron, better-sqlite3, ClamAV e o resto da árvore; sem eles o
 *      instalador levaria código de terceiros sem a documentação que o
 *      acompanha (é também um input obrigatório do `--check`).
 *
 * Uso: node --test scripts/test/7h-packaging-manifest.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as url from "node:url";

import { buildAppManifest, preflightChecks } from "../package-windows.mjs";
import { readProductVersion } from "../app-version.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "packages", "desktop");
const SCRIPT = path.resolve(HERE, "..", "package-windows.mjs");

const desktopManifest = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "package.json"), "utf8"));

/** Manifesto construído com tarballs falsos: a forma não depende dos ficheiros. */
function manifest(overrides = {}) {
  const tarballs = {
    "@cybersafe/core": "C:/tmp/staging/tarballs/cybersafe-core-0.1.1.tgz",
    "@cybersafe/shared-types": "C:/tmp/staging/tarballs/cybersafe-shared-types-0.1.1.tgz",
    "@cybersafe/service": "C:/tmp/staging/tarballs/cybersafe-service-0.1.1.tgz",
    api: "C:/tmp/staging/tarballs/api-0.1.1.tgz",
    ...overrides.tarballs,
  };
  return buildAppManifest({
    desktopManifest,
    tarballs,
    electronVersion: "33.4.11",
    scanEngine: path.join(REPO_ROOT, "packages", "native-engine", "build", "Release", "scan-engine.exe"),
    outDir: path.join(DESKTOP_DIR, "release"),
    desktopDir: DESKTOP_DIR,
    productVersion: readProductVersion({ root: REPO_ROOT }).version,
    ...overrides,
    ...(overrides.tarballs ? { tarballs } : {}),
  });
}

function stagingDirs() {
  const tmp = os.tmpdir();
  return fs
    .readdirSync(tmp)
    .filter((entry) => entry.startsWith("cybersafe-package-"));
}

describe("manifesto da aplicação empacotada", () => {
  it("uses stock assisted NSIS without custom scripts/hooks and preserves installation contracts", () => {
    const m = manifest();
    const n = m.build.nsis;
    assert.equal(n.include, undefined);
    assert.equal(n.script, undefined);
    assert.equal(Object.keys(n).some(key => /custom|hook/i.test(key)), false);
    assert.equal(n.oneClick, false);
    assert.equal(n.perMachine, false);
    assert.equal(n.deleteAppDataOnUninstall, false);
    assert.equal(n.createDesktopShortcut, true);
    assert.equal(n.createStartMenuShortcut, true);
    assert.equal(n.runAfterFinish, true);
    assert.equal(n.language, undefined, 'do not force language as part of the stock correction');
    assert.equal(m.build.appId, 'com.cybersafe.assistant');
    assert.equal(m.version, readProductVersion({ root: REPO_ROOT }).version);
    assert.equal(m.build.win.icon, path.join(DESKTOP_DIR, 'src', 'assets', 'icon.ico'));
    assert.equal(n.installerSidebar, path.join(DESKTOP_DIR, 'build', 'installer', 'installerSidebar.bmp'));
    assert.equal(n.uninstallerSidebar, path.join(DESKTOP_DIR, 'build', 'installer', 'uninstallerSidebar.bmp'));
    const raw = desktopManifest.build.nsis;
    assert.equal(raw.include, undefined, 'direct electron-builder use must also remain stock');
    assert.equal(raw.script, undefined);
  });

  it("leva productName: sem ele o userData cai em %APPDATA%\\@cybersafe\\desktop", () => {
    const m = manifest();
    assert.equal(m.productName, desktopManifest.build.productName, "o productName tem de vir do config do builder");
    assert.notEqual(m.productName, m.name, "o productName não pode ser o name do pacote (@cybersafe/desktop)");
    assert.doesNotMatch(String(m.productName), /[@/]/, "um nome de pasta com @ ou / no %APPDATA% é o defeito que isto corrige");
  });

  it("copia a identidade e o ponto de entrada do shell", () => {
    const m = manifest();
    const canonical = readProductVersion({ root: REPO_ROOT }).version;
    assert.equal(m.name, desktopManifest.name);
    assert.equal(m.version, canonical);
    assert.notEqual(m.version, desktopManifest.version, "o build não pode cair para a versão interna do desktop");
    assert.equal(m.main, desktopManifest.main);
    assert.equal(m.type, desktopManifest.type);
    assert.equal(m.private, true);
  });

  it("instala as dependências do workspace a partir dos tarballs locais", () => {
    const m = manifest();
    assert.deepEqual(Object.keys(m.dependencies).sort(), ["@cybersafe/core", "@cybersafe/service", "@cybersafe/shared-types", "api"]);
    for (const [dep, spec] of Object.entries(m.dependencies)) {
      assert.match(spec, /^file:.+\.tgz$/, `${dep} tem de apontar para o tarball local`);
      assert.doesNotMatch(spec, /\\/, `${dep}: o npm recebe barras normais em Windows`);
    }
  });

  it("empacota dist + node_modules e exclui prisma, logs e sourcemaps", () => {
    const m = manifest();
    assert.ok(m.build.files.includes("dist/**/*"), "o shell compilado tem de entrar");
    assert.ok(m.build.files.includes("node_modules/**/*"), "as dependências reais têm de entrar");
    assert.ok(
      m.build.files.some((pattern) => pattern.includes("@prisma")),
      "o @prisma (declarado, não usado em runtime) tem de ficar excluído",
    );
    assert.ok(m.build.files.includes("!**/*.log"));
    assert.ok(m.build.files.includes("!**/*.map"));
  });

  it("mantém os módulos nativos fora do asar", () => {
    const m = manifest();
    for (const pattern of ["**/*.node", "**/node_modules/better-sqlite3/**"]) {
      assert.ok(m.build.asarUnpack.includes(pattern), `o asarUnpack tem de cobrir ${pattern}`);
    }
    assert.ok(
      !m.build.asarUnpack.some((pattern) => pattern.includes("@litko")),
      "o YARA-X saiu do grafo: não pode voltar ao asarUnpack",
    );
  });

  it("publica scan-engine.exe, ClamAV e licenças em resources/ além do ícone e da saída", () => {
    const m = manifest();
    assert.ok(path.isAbsolute(m.build.win.icon) && m.build.win.icon.endsWith(path.join("assets", "icon.ico")));
    // DIST-CLAMAV13OUT (2026-10-13): passaram a ser DOIS extraResources — o
    // scan-engine.exe (como antes) e o bundle ClamAV, que o electron-builder
    // copia para `resources/clamav`. É exactamente aí que o pin
    // CYBERSAFE_CLAMSCAN_PATH do desktop o procura.
    // CONTRATO-ASSETS (2026-10-25): o terceiro destino é `resources/licenses`.
    // O `buildAppManifest` publica o directório revisto `assets/licenses`
    // (THIRD-PARTY-NOTICES.txt + PROVENANCE.json, ambos exigidos pelo `--check`)
    // porque o instalador distribui código de terceiros. O contrato e o teste
    // dizem agora o mesmo que a implementação; nenhum recurso foi retirado.
    assert.equal(
      m.build.extraResources.length,
      4,
      "scan-engine.exe + YARA clássico + ClamAV + licenças: o número tem de vir do contrato, não de uma contagem permissiva",
    );
    assert.equal(m.build.extraResources[0].to, "scan-engine.exe");
    assert.equal(path.basename(m.build.extraResources[0].from), "scan-engine.exe");
    const yaraEntry = m.build.extraResources.find((entry) => entry.to === "yara");
    assert.ok(yaraEntry, "os binários do YARA clássico têm de ser publicados em resources/yara");
    assert.ok(path.isAbsolute(yaraEntry.from), "o `from` do YARA tem de ser absoluto: o staging vive fora do repo");
    assert.equal(path.basename(yaraEntry.from), "yara");
    assert.equal(path.basename(path.dirname(yaraEntry.from)), "vendor");
    const clamavEntry = m.build.extraResources.find((entry) => entry.to === "clamav");
    assert.ok(clamavEntry, "o bundle ClamAV tem de ser publicado em resources/clamav");
    assert.ok(path.isAbsolute(clamavEntry.from), "a árvore de staging vive fora do repo: o `from` tem de ser absoluto");
    assert.equal(path.basename(clamavEntry.from), "clamav");
    assert.equal(path.basename(path.dirname(clamavEntry.from)), "vendor");
    const licensesEntry = m.build.extraResources.find((entry) => entry.to === "licenses");
    assert.ok(licensesEntry, "os avisos de terceiros têm de ser publicados em resources/licenses");
    assert.ok(path.isAbsolute(licensesEntry.from), "o `from` das licenças tem de ser absoluto: a árvore vive fora do repo");
    assert.equal(path.basename(licensesEntry.from), "licenses");
    assert.equal(path.basename(path.dirname(licensesEntry.from)), "assets");
    assert.equal(m.build.directories.output, path.join(DESKTOP_DIR, "release"));
    assert.equal(m.build.electronVersion, "33.4.11", "a versão do Electron tem de ser a realmente instalada");
  });

  it("exige productVersion explícita; não há fallback silencioso para 0.1.2", () => {
    assert.throws(() => manifest({ productVersion: undefined }), /productVersion/);
  });

  it("o alvo do instalador continua a ser o NSIS do config do desktop", () => {
    const m = manifest();
    assert.deepEqual(m.build.win.target, desktopManifest.build.win.target);
    assert.equal(m.build.nsis.deleteAppDataOnUninstall, false, "desinstalar não pode apagar os dados da instalação");
  });

  it("importar o módulo não corre o pipeline", () => {
    const before = stagingDirs();
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(`file:///${SCRIPT.replace(/\\/g, "/")}`)}).then((m) => { console.log("imported", typeof m.buildAppManifest); })`,
      ],
      { encoding: "utf8", cwd: REPO_ROOT, timeout: 60_000 },
    );
    assert.match(out, /imported function/, "o módulo tem de ser importável");
    assert.deepEqual(stagingDirs().filter((dir) => !before.includes(dir)), [], "importar não pode criar staging");
  });
});

describe("pré-verificação dos inputs", () => {
  it("cobre todos os pacotes empacotados e diz como corrigir cada falta", () => {
    const checks = preflightChecks();
    for (const pkg of ["@cybersafe/shared-types", "@cybersafe/core", "@cybersafe/native-windows", "@cybersafe/service", "api"]) {
      assert.ok(checks.some((check) => check.id.startsWith(`workspace:${pkg}/`)), `${pkg} tem de ser verificado`);
    }
    assert.ok(checks.some((check) => check.id === "binario:scan-engine.exe"));
    for (const id of ["binario:yara64.exe", "binario:yarac64.exe", "binario:yara/vcruntime140.dll", "licenca:yara/COPYING.txt"]) {
      assert.ok(checks.some((check) => check.id === id), `${id} tem de ser verificado antes do build`);
    }
    assert.ok(checks.some((check) => check.id === "icone:icon.ico"));
    for (const check of checks) {
      assert.ok(check.fix && check.fix.trim().length > 0, `"${check.id}" tem de dizer como se corrige`);
      assert.equal(check.exists, fs.existsSync(check.path), `"${check.id}": o resultado tem de vir do disco`);
    }
  });
});
