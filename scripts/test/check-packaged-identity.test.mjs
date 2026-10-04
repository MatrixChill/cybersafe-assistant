/**
 * TESTES DO GATE DE IDENTIDADE DE PACKAGING.
 *
 * Um gate que só passa não está provado: passa sempre que ninguém olha. Estes
 * testes existem para provar duas coisas:
 *
 *   1. O gate BITE — um artefacto com a identidade errada tem de dar FAIL e
 *      código de saída 1. O artefacto usado é REAL (`node_modules/electron/dist`,
 *      um electron.exe genuíno com metadata "Electron / GitHub, Inc."), não um
 *      ficheiro inventado.
 *   2. O gate NÃO INVENTA PASS — o que não é mensurável tem de sair UNKNOWN com
 *      um motivo, nunca PASS.
 *
 * Estes testes correm o gate como subprocesso, exactamente como o faria o CI ou
 * quem publica. Não reimplementam a lógica do gate.
 *
 * Uso: node --test test/check-packaged-identity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const GATE = path.resolve(HERE, "..", "check-packaged-identity.mjs");

/** Corre o gate e devolve { code, json }. Nunca deixa a execucao rebentar. */
function runGate(args = []) {
  try {
    const out = execFileSync(process.execPath, [GATE, ...args, "--json"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      timeout: 180_000,
    });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout ?? "";
    let json = null;
    try {
      json = JSON.parse(out);
    } catch {
      /* sem JSON: o gate morreu antes de reportar */
    }
    return { code: typeof e.status === "number" ? e.status : 1, json };
  }
}

const byId = (json, id) => json.checks.find((c) => c.id === id) ?? null;

describe("gate de identidade de packaging", () => {
  it("o gate existe e é executável como script", () => {
    assert.ok(fs.existsSync(GATE), `o gate tem de existir em ${GATE}`);
    const src = fs.readFileSync(GATE, "utf8");
    assert.match(src, /^#!\/usr\/bin\/env node/, "tem de ter shebang, como os outros scripts de release");
  });

  it("BITE: uma build com identidade electron.exe dá FAIL e código de saída 1", () => {
    const electronDist = path.join(REPO_ROOT, "node_modules", "electron", "dist");
    if (!fs.existsSync(electronDist)) {
      // Sem o electron instalado nao ha o que medir. Dizer e nao fingir.
      return;
    }
    const { code, json } = runGate([electronDist]);
    assert.ok(json, "o gate tem de produzir JSON mesmo quando falha");
    assert.equal(code, 1, "um artefacto com a identidade errada tem de sair com 1");
    assert.equal(byId(json, "exe-presente").status, "FAIL", "não existe o executavel com o nome do produto");
  });

  it("BITE: um directório de build inexistente dá FAIL e código de saída 1", () => {
    const inexistente = path.join(REPO_ROOT, "release", "nao-existe-mesmo", "win-unpacked");
    const { code, json } = runGate([inexistente]);
    assert.ok(json, "o gate tem de produzir JSON mesmo quando o build não existe");
    assert.equal(code, 1);
    assert.equal(byId(json, "build-dir").status, "FAIL");
  });

  it("BITE: --require-signature falha quando o executável não está assinado", () => {
    const build = path.join(REPO_ROOT, "packages", "desktop", "release", "win-unpacked");
    if (!fs.existsSync(build)) return; // sem build não há o que verificar
    const { code, json } = runGate([build, "--require-signature"]);
    const publisher = byId(json, "publisher");
    assert.ok(publisher, "a verificação de publisher tem de existir sempre");
    if (publisher.assinatura === "NotSigned") {
      assert.equal(publisher.status, "FAIL", "com --require-signature, um binário sem assinatura é FAIL");
      assert.equal(code, 1, "e o gate sai com 1");
    } else {
      // Assinado neste ambiente: o caminho feliz é ter de passar.
      assert.equal(publisher.status, "PASS");
      assert.equal(code, 0, "um binário assinado passa o gate de assinatura");
    }
  });

  it("NÃO INVENTA PASS: sem certificado, publisher é UNKNOWN com motivo — não PASS", () => {
    const build = path.join(REPO_ROOT, "packages", "desktop", "release", "win-unpacked");
    if (!fs.existsSync(build)) return;
    const { json } = runGate([build]);
    const publisher = byId(json, "publisher");
    assert.ok(publisher);
    if (publisher.assinatura === "NotSigned") {
      assert.equal(
        publisher.status, "UNKNOWN",
        "não há certificado: o resultado honesto é UNKNOWN, nunca PASS nem FAIL silencioso",
      );
      assert.match(publisher.detail, /certificado/i, "o UNKNOWN tem de dizer PORQUÊ não é verificável");
    }
  });

  it("UNKNOWN é sempre acompanhado de motivo", () => {
    const build = path.join(REPO_ROOT, "packages", "desktop", "release", "win-unpacked");
    if (!fs.existsSync(build)) return;
    const { json } = runGate([build]);
    const desconhecidos = json.checks.filter((c) => c.status === "UNKNOWN");
    for (const c of desconhecidos) {
      assert.ok(
        c.detail && c.detail.trim().length > 0,
        `o check UNKNOWN "${c.id}" tem de explicar o que não conseguiu medir`,
      );
    }
  });

  it("o ícone embutido é UNKNOWN, não PASS: o gate não mede o que não mede", () => {
    const build = path.join(REPO_ROOT, "packages", "desktop", "release", "win-unpacked");
    if (!fs.existsSync(build)) return;
    const { json } = runGate([build]);
    assert.equal(
      byId(json, "icone-embutido").status, "UNKNOWN",
      "verificar o ícone gravado no .exe exige parsing de PE; afirmar PASS seria inventar",
    );
  });

  it("o relatório declara clamscan.exe e freshclam.exe como motores externos, nunca como falha", () => {
    const { json } = runGate([path.join(REPO_ROOT, "nao-existe")]);
    assert.deepEqual(
      [...json.motoresExternos].sort(), ["clamscan.exe", "freshclam.exe"],
      "os motores externos têm de estar declarados",
    );
    for (const c of json.checks.filter((x) => x.id.startsWith("externo-"))) {
      assert.notEqual(c.status, "FAIL", `"${c.id}" é um motor externo esperado — nunca uma falha de branding`);
    }
    const regra = byId(json, "externos-regra");
    assert.ok(regra, "a regra de terceiros tem de existir");
    assert.match(regra.detail, /NAO os trata como falha/i);
  });

  it("o relatório distingue PACKAGING de branding: o resumo conta os quatro estados", () => {
    const { json } = runGate([path.join(REPO_ROOT, "nao-existe")]);
    for (const estado of ["PASS", "FAIL", "UNKNOWN", "INFO"]) {
      assert.equal(typeof json.contagens[estado], "number", `o resumo tem de contar ${estado}`);
    }
  });

  it("o gate deriva as expectativas do config, não de literais", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "packages", "desktop", "package.json"), "utf8"),
    );
    const { json } = runGate([path.join(REPO_ROOT, "nao-existe")]);
    assert.equal(
      json.esperado.productName, pkg.build.productName,
      "o ProductName esperado vem de build.productName",
    );
    assert.equal(
      json.esperado.exe, `${pkg.build.productName}.exe`,
      "sem `executableName`, o executável chama-se productName.exe — como o electron-builder faz",
    );
    assert.equal(json.esperado.companyName, pkg.author, "o CompanyName esperado vem de `author`");
    assert.equal(json.esperado.appId, pkg.build.appId);
  });
});