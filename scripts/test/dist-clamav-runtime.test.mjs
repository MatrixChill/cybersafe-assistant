/**
 * DIST-CLAMAV13OUT — O BUNDLE A CORRER: motor isolado, config isolada.
 *
 * O que este ficheiro prova, com o bundle REAL (só corre se ele existir):
 *   1. AS DLLs CARREGAM de uma cópia RELOCALIZADA em %TEMP%, com PATH limpo e
 *      sem dados pessoais: `clamscan --version` tem de dizer `ClamAV 1.5.4`.
 *      Nada é varrido, nada é analisado — só a versão;
 *   2. o runtime NÃO precisa da fonte correspondente (61 MiB): a cópia que
 *      corre não a leva;
 *   3. o `freshclam` arranca com a config ISOLADA que a própria app gera
 *      (`buildFreshclamConfig`), apontada para um directório de base VAZIO em
 *      %TEMP%. Só se pede `--version`; a base NÃO é actualizada e o directório
 *      fica vazio — nenhum download, nenhum CVD/CLD escrito;
 *   4. sem config o mesmo binário FALHA (exit != 0) — o que prova que o exit 0
 *      do ponto 3 vem da config isolada e não de sorte;
 *   5. nenhuma saída destes processos refere o perfil do utilizador.
 *
 * Uso: node --test scripts/test/dist-clamav-runtime.test.mjs
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as url from "node:url";

import { buildFreshclamArgs, buildFreshclamConfig } from "../../packages/service/dist/clamav-config.js";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const BUNDLE_DIR = path.join(REPO_ROOT, "vendor", "clamav");
const CLAMSCAN = path.join(BUNDLE_DIR, "clamscan.exe");
const FRESHCLAM = path.join(BUNDLE_DIR, "freshclam.exe");
const hasBundle = fs.existsSync(CLAMSCAN) && fs.existsSync(FRESHCLAM);

/**
 * PATH limpo a sério: só o mínimo do Windows. As DLLs do bundle são carregadas
 * do directório do próprio executável, que é exactamente o que se quer provar.
 */
const cleanEnv = (extra = {}) => ({
  PATH: "C:\\Windows\\System32;C:\\Windows",
  SystemRoot: "C:\\Windows",
  windir: "C:\\Windows",
  TEMP: os.tmpdir(),
  TMP: os.tmpdir(),
  ...extra,
});

/** Nenhuma saída pode referir o perfil do utilizador nem o repositório. */
function assertNoPersonalData(...outputs) {
  const text = outputs.filter(Boolean).join("\n");
  for (const personal of [os.homedir(), os.userInfo().username, REPO_ROOT]) {
    assert.ok(!text.includes(personal), `a saída não pode referir ${personal}: ${text.slice(0, 400)}`);
  }
}

let runtimeDir;
let tmpRoot;

before(() => {
  if (!hasBundle) return;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-clamav-runtime-"));
  runtimeDir = path.join(tmpRoot, "motor");
  fs.mkdirSync(runtimeDir, { recursive: true });
  // Cópia RELOCALIZADA: executáveis + DLLs + certs + licença. A fonte
  // correspondente NÃO vai — provar que o runtime não depende dela.
  for (const entry of fs.readdirSync(BUNDLE_DIR, { withFileTypes: true })) {
    const full = path.join(BUNDLE_DIR, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "certs") fs.cpSync(full, path.join(runtimeDir, entry.name), { recursive: true });
      continue;
    }
    if (/\.(exe|dll)$/i.test(entry.name) || entry.name === "COPYING.txt") {
      fs.copyFileSync(full, path.join(runtimeDir, entry.name));
    }
  }
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("motor relocalizado em %TEMP%, PATH limpo", () => {
  it("as DLLs carregam: clamscan --version diz ClamAV 1.5.4 numa cópia fora do repo", (t) => {
    if (!hasBundle) {
      t.skip("bundle não vendorizado nesta máquina (node scripts/vendor-clamav.mjs)");
      return;
    }
    const result = spawnSync(path.join(runtimeDir, "clamscan.exe"), ["--version"], {
      encoding: "utf8",
      cwd: runtimeDir,
      env: cleanEnv(),
      timeout: 60_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
    assert.match(String(result.stdout), /ClamAV 1\.5\.4/, "o motor relocalizado tem de reportar a versão fixada");
    assertNoPersonalData(result.stdout, result.stderr);
    const missing = String(result.stderr).match(/cannot find|não foi possível|not found/i);
    assert.equal(missing, null, `não pode haver DLL em falta: ${result.stderr}`);
  });

  it("o runtime não leva a fonte correspondente (61 MiB) e continua a arrancar", (t) => {
    if (!hasBundle) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    assert.equal(fs.existsSync(path.join(runtimeDir, "source")), false, "a fonte não pode estar na cópia que corre");
    assert.ok(fs.readdirSync(runtimeDir).filter((file) => file.endsWith(".dll")).length >= 20, "as DLLs têm de estar lá");
    const result = spawnSync(path.join(runtimeDir, "clamconf.exe"), ["--version"], {
      encoding: "utf8",
      cwd: runtimeDir,
      env: cleanEnv(),
      timeout: 60_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
    assert.match(String(result.stdout), /1\.5\.4/);
    assertNoPersonalData(result.stdout, result.stderr);
  });
});

describe("freshclam com configuração ISOLADA (sem actualizar a base)", () => {
  it("config gerada pela app + base vazia ⇒ --version arranca e a base fica INTACTA", (t) => {
    if (!hasBundle) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-freshclam-cfg-"));
    t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
    const databaseDirectory = path.join(workDir, "clamav");
    fs.mkdirSync(databaseDirectory, { recursive: true });

    // A MESMA função que o serviço usa em produção gera a config — não um
    // ficheiro escrito à mão no teste (isso testaria outra coisa).
    const configFile = path.join(workDir, "freshclam.conf");
    fs.writeFileSync(configFile, buildFreshclamConfig({ databaseDirectory }));
    const args = [...buildFreshclamArgs({ configFile, databaseDirectory }), "--version"];

    const result = spawnSync(FRESHCLAM, args, {
      encoding: "utf8",
      cwd: workDir,
      env: cleanEnv(),
      timeout: 60_000,
      windowsHide: true,
    });

    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
    assert.match(String(result.stdout), /ClamAV 1\.5\.4/);
    assertNoPersonalData(result.stdout, result.stderr);
    // A base continua VAZIA: nenhum `main.cvd`/`daily.cld` foi descarregado e
    // nenhum `freshclam.dat` foi escrito. Isto corre offline por construção.
    assert.deepEqual(fs.readdirSync(databaseDirectory), [], "o --version não pode actualizar nem tocar na base");
    // E só existem os ficheiros que o próprio teste criou.
    assert.deepEqual(fs.readdirSync(workDir).sort(), ["clamav", "freshclam.conf"]);
  });

  it("BITE: sem config o mesmo binário FALHA — o exit 0 acima vem da config isolada", (t) => {
    if (!hasBundle) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-freshclam-nocfg-"));
    t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
    const result = spawnSync(FRESHCLAM, ["--version"], {
      encoding: "utf8",
      cwd: workDir,
      env: cleanEnv(),
      timeout: 60_000,
      windowsHide: true,
    });
    assert.notEqual(result.status, 0, "sem config o freshclam não arranca (é o defeito que a config do serviço fecha)");
    // MEDIDO: nesta falha o PRÓPRIO binário ecoa o caminho onde procurou a
    // config (o directório do executável). É diagnóstico dele — o produto nunca
    // o lança sem `--config-file` — por isso a asserção é sobre o MODO de
    // falha (config em falta), não sobre "zero caminhos na saída".
    assert.match(`${result.stdout}${result.stderr}`, /config file/i, "a falha tem de ser a config em falta");
    assert.match(`${result.stdout}${result.stderr}`, /freshclam\.conf/);
    assert.ok(
      fs.readdirSync(workDir).length === 0,
      "mesmo a falhar, nada pode ser escrito no directório de trabalho",
    );
  });
});
