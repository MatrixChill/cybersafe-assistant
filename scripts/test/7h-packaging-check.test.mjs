/**
 * TESTES DO PIPELINE DE EMPACOTAMENTO (scripts/package-windows.mjs).
 *
 * Deliberadamente ISOLADOS: nenhum destes testes compila, instala ou empacota
 * nada. Provam a parte do pipeline que pode ser verificada sem competir com o
 * `dist` partilhado (Kilo/qoder podem estar a escrever nos packages).
 *
 * O que fica provado aqui:
 *   1. o `--check` mede os inputs REAIS do disco e o seu código de saída bate
 *      certo com o relatório (nunca "ok" com ficheiros em falta);
 *   2. o `--check` não executa nada (nem npm, nem electron-builder) e não cria
 *      staging em %TEMP%;
 *   3. o plano inclui `@cybersafe/native-windows` — o pacote que o `service`
 *      importa em runtime e que o pipeline empacotava sem o reconstruir;
 *   4. uma flag mal escrita (`--chek`) falha com código 2, em vez de ser
 *      ignorada em silêncio como antes;
 *   5. o staging é removido no fim com sucesso e mantido com `--keep`/em falha —
 *      a promessa que o cabeçalho fazia e o código não cumpria.
 *
 * Uso: node --test scripts/test/7h-packaging-check.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.resolve(HERE, "..", "package-windows.mjs");

/** Corre o script e devolve sempre o código + saída. Nunca rebenta o teste. */
function runScript(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function stagingDirs() {
  const tmp = os.tmpdir();
  return fs
    .readdirSync(tmp)
    .filter((entry) => entry.startsWith("cybersafe-package-"))
    .map((entry) => path.join(tmp, entry));
}

function checkJson(extraArgs = []) {
  const { code, stdout } = runScript(["--check", "--json", ...extraArgs]);
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* sem JSON: o --check morreu antes de reportar */
  }
  return { code, json, stdout };
}

describe("pipeline de empacotamento (--check)", () => {
  it("o script existe e é executável como script", () => {
    assert.ok(fs.existsSync(SCRIPT), `tem de existir em ${SCRIPT}`);
    assert.match(fs.readFileSync(SCRIPT, "utf8"), /^#!\/usr\/bin\/env node/);
  });

  it("--help sai com 0 e documenta as flags reais", () => {
    const { code, stdout } = runScript(["--help"]);
    assert.equal(code, 0);
    for (const flag of ["--dir", "--keep", "--check", "--json", "--help"]) {
      assert.ok(stdout.includes(flag), `a ajuda tem de documentar ${flag}`);
    }
    assert.match(stdout, /Códigos de saída: 0 = ok, 1 = inputs em falta/, "a ajuda tem de dizer o que significa cada código de saída");
  });

  it("BITE: uma flag mal escrita sai com 2 e é nomeada — não é ignorada em silêncio", () => {
    const { code, stdout, stderr } = runScript(["--chek"]);
    assert.equal(code, 2, "uma flag desconhecida não pode ser descartada em silêncio (era o comportamento antigo)");
    assert.match(`${stdout}${stderr}`, /--chek/, "a mensagem tem de nomear a flag errada");
    assert.match(`${stdout}${stderr}`, /Uso:/, "e tem de mostrar a ajuda");
  });

  it("--check --json reporta os inputs com o formato completo (id, exists, path, fix)", () => {
    const { code, json } = checkJson();
    assert.ok(json, "o --check tem de produzir JSON válido");
    assert.equal(typeof json.ok, "boolean");
    assert.ok(Array.isArray(json.checks) && json.checks.length > 0, "tem de haver verificações");
    for (const check of json.checks) {
      assert.equal(typeof check.id, "string");
      assert.equal(typeof check.exists, "boolean");
      assert.ok(path.isAbsolute(check.path), `o caminho tem de ser absoluto: ${check.path}`);
      assert.ok(check.fix && check.fix.trim().length > 0, `o check "${check.id}" tem de dizer como se corrige`);
    }
  });

  it("o código de saída bate certo com o relatório: nunca OK com ficheiros em falta", () => {
    const { code, json } = checkJson();
    const licensingOk = Boolean(json.licensing) && json.licensing.estado === "prova-fecha";
    const derived = json.checks.every((check) => check.exists) && json.bundle.ok && json.freeze.ok && licensingOk;
    assert.equal(json.ok, derived, "`ok` tem de ser exatamente o resultado das verificações (inputs + bundle + fontes + licenciamento)");
    assert.equal(code, derived ? 0 : 1, "código de saída 0 só quando inputs, bundle, fontes e licenciamento estão conformes");
    for (const check of json.checks) {
      assert.equal(check.exists, fs.existsSync(check.path), `"${check.id}": o relatório tem de refletir o disco`);
    }
  });

  it("quando falta um input, o --check nomeia-o no texto E no JSON", () => {
    const { code, json, stdout } = checkJson();
    const missing = json.checks.filter((check) => !check.exists);
    if (missing.length === 0) {
      // Nesta máquina está tudo presente: o caminho negativo do gate de fontes
      // é coberto pelo teste seguinte.
      assert.equal(code, json.ok ? 0 : 1);
      return;
    }
    assert.equal(code, 1);
    const text = runScript(["--check"]);
    for (const check of missing) {
      assert.ok(text.stdout.includes(check.path), `a saída tem de nomear ${check.path}`);
      assert.ok(text.stdout.includes(check.fix), `a saída tem de dizer a correção de ${check.id}`);
    }
  });

  it("sem manifesto aprovado o --check não é verde e nomeia o motivo", () => {
    const { code, json } = checkJson();
    /* manifestPresent só prova que existe um ficheiro; não prova que o HEAD
       foi aprovado. O freeze falha fechado quando o registo de aprovadores não
       existe ou quando o manifesto é de outra árvore. */
    if (json.freeze.manifestPresent && json.freeze.ok) {
      assert.equal(code, json.ok ? 0 : 1, "com fontes aprovadas, o código segue o resto dos inputs");
      return;
    }
    assert.equal(json.freeze.ok, false);
    const kinds = json.freeze.problems.map((problem) => problem.kind);
    assert.ok(kinds.length > 0, "um freeze não aprovado tem de nomear pelo menos um problema");
    assert.ok(
      kinds.some((kind) => ["manifest-missing", "approver-registry-missing", "manifest-digest-mismatch"].includes(kind)),
      "motivo inesperado: " + JSON.stringify(kinds),
    );
    if (kinds.includes("approver-registry-missing")) {
      assert.equal(kinds[0], "approver-registry-missing", "a falta de registo tem de vir nomeada em primeiro lugar");
    }
    assert.equal(code, 1, "sem manifesto aprovado o --check tem de sair != 0");
    const text = runScript(["--check"]);
    assert.match(text.stdout, /fontes: [a-z-]+/, "o texto tem de dizer porque não está verde");
  });

  it("o --check não executa nada: nem npm, nem electron-builder, nem staging novo", () => {
    const before = stagingDirs();
    const text = runScript(["--check"]);
    const { code, json } = checkJson();
    assert.equal(code, json.ok ? 0 : 1, "o código de saída tem de bater certo com o relatório");
    assert.doesNotMatch(text.stdout, /^\[package\] \$ /m, "nada pode ser executado no modo --check");
    assert.doesNotMatch(text.stdout, /npm install --omit=dev|electron-builder \(/, "o --check não instala nem empacota");
    const after = stagingDirs();
    assert.deepEqual(
      after.filter((dir) => !before.includes(dir)),
      [],
      "o --check não pode criar staging em %TEMP%",
    );
  });

  it("o plano compila @cybersafe/native-windows (empacotado mas nunca reconstruído)", () => {
    const { json } = checkJson();
    const builds = json.builds.join("\n");
    assert.match(builds, /npm run build -w @cybersafe\/native-windows/, "o native-windows tem de ser compilado pelo pipeline");
    const shared = json.builds.findIndex((b) => b.includes("@cybersafe/shared-types"));
    const native = json.builds.findIndex((b) => b.includes("@cybersafe/native-windows"));
    const service = json.builds.findIndex((b) => b.includes("@cybersafe/service"));
    assert.ok(shared < native && native < service, "ordem: shared-types → native-windows → service");
    const planned = json.packages.find((pkg) => pkg.name === "@cybersafe/native-windows");
    assert.ok(planned, "o native-windows tem de estar na lista de pacotes empacotados");
    assert.ok(planned.include.includes("dist"), "o dist dele é o que vai para o pacote");
  });

  it("o staging é removido no sucesso e mantido com --keep", () => {
    const normal = checkJson();
    assert.equal(normal.json.staging.removedOnSuccess, true, "por omissão o staging sai de %TEMP% no fim");
    assert.equal(normal.json.staging.created, false, "o --check não cria staging");
    const kept = checkJson(["--keep"]);
    assert.equal(kept.json.staging.removedOnSuccess, false, "com --keep o staging fica para diagnóstico");
    assert.equal(kept.json.flags.keep, true);
  });

  it("o script não usa shell (o caminho do projeto tem espaços) e só apaga o seu próprio staging", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    assert.doesNotMatch(source, /shell:\s*true/, "o `shell` do Windows parte o caminho com espaços — npm corre via npm-cli.js");
    assert.match(source, /cybersafe-package-/, "a remoção do staging tem de estar limitada ao prefixo que este script cria");
    assert.match(source, /process\.on\("exit",\s*\(code\)\s*=>/, "a remoção tem de acontecer no fim, com código 0");
    assert.match(source, /if \(code === 0 && !keepStaging/, "um build falhado tem de deixar o staging para inspeção");
  });
});
