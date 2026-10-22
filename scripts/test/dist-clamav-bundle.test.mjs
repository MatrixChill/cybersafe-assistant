/**
 * DIST-CLAMAV13OUT — O BUNDLE NO PACOTE: manifesto, integridade REAL e fonte.
 *
 * O que este ficheiro prova:
 *   1. o `--check` deixou de ser uma lista de `existsSync`: exige o manifesto do
 *      bundle (`vendor/clamav/VENDOR.json`) e RE-MEDE cada ficheiro publicado
 *      (bytes + sha256). Basta alterar um byte para o check falhar;
 *   2. a FONTE CORRESPONDENTE (GPLv2 §3) tem de estar DENTRO do bundle, com o
 *      digest registado a bater certo — um bundle só com URL/oferta NÃO passa;
 *   3. o bundle não pode trazer base de assinaturas (`*.cvd`/`*.cld`/…) nem
 *      ficar sem licenças;
 *   4. o `--check` não descarrega nem reescreve nada (a fonte fica com o mesmo
 *      mtime antes e depois);
 *   5. o manifesto do pacote publica o bundle em `resources/clamav` (é onde o
 *      pin `CYBERSAFE_CLAMSCAN_PATH` do desktop o procura) com caminho absoluto.
 *
 * Nenhum processo é lançado: só se lê o disco e se corre `--check` (que não
 * compila, não instala, não empacota e não descarrega). Os cenários negativos
 * usam fixtures próprias em %TEMP% — nunca o bundle real.
 *
 * Uso: node --test scripts/test/dist-clamav-bundle.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as url from "node:url";

import { buildAppManifest, preflightChecks, verifyClamavBundle } from "../package-windows.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.resolve(HERE, "..", "package-windows.mjs");
const BUNDLE_DIR = path.join(REPO_ROOT, "vendor", "clamav");
const MANIFEST_PATH = path.join(BUNDLE_DIR, "VENDOR.json");
/** Chave Talos fixada (a MESMA que o `vendor-clamav.mjs` exige). */
const TALOS_FINGERPRINT = "5BADCA2665EF59DCF8A23D8B707F0DB480836771";

const hasBundle = fs.existsSync(MANIFEST_PATH);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function writeFiles(dir, entries) {
  for (const [rel, data] of entries) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
}

/**
 * Bundle MÍNIMO válido em %TEMP%: binário + licença + fonte correspondente.
 * Os overrides existem para provar cada falha de forma isolada.
 */
function minimalBundle(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-clamav-bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const bin = Buffer.from("MZ-fake-clamscan", "utf8");
  const license = Buffer.from("GPL-2.0-only", "utf8");
  const source = Buffer.from("fake-tar-gz-source", "utf8");

  const files = [["clamscan.exe", bin]];
  if (overrides.withLicense !== false) files.push(["COPYING.txt", license]);
  if (overrides.withSourceFile !== false) files.push(["source/clamav-1.5.4.tar.gz", source]);
  // Metadados gerados pelo `vendor-clamav.mjs` que TÊM de estar no bundle.
  if (overrides.withOffer !== false) files.push(["SOURCE-OFFER.txt", Buffer.from("oferta de fonte")]);
  for (const pair of overrides.extraOnDisk ?? []) files.push(pair);
  writeFiles(dir, files);

  // O binário é reescrito DEPOIS de o manifesto ser calculado: é o cenário
  // "ficheiro alterado no disco depois de publicado".
  //  • `tamperBinary`    → MESMO tamanho, conteúdo diferente: só o sha256 o apanha;
  //  • `truncateBinary`  → tamanho diferente: apanha-o a verificação de bytes.
  if (overrides.tamperBinary) {
    writeFiles(dir, [["clamscan.exe", Buffer.from("MZ-fake-CLAMSCAN", "utf8")]]);
  }
  if (overrides.truncateBinary) {
    writeFiles(dir, [["clamscan.exe", Buffer.from("MZ", "utf8")]]);
  }

  const extracted = [{ path: "clamscan.exe", bytes: bin.length, sha256: sha256(bin) }];
  if (overrides.withLicense !== false) {
    extracted.push({ path: "COPYING.txt", bytes: license.length, sha256: sha256(license) });
  }
  if (overrides.withCvdEntry) {
    const cvd = Buffer.from("base-de-assinaturas", "utf8");
    writeFiles(dir, [[`${overrides.withCvdEntry}`, cvd]]);
    extracted.push({ path: overrides.withCvdEntry, bytes: cvd.length, sha256: sha256(cvd) });
  }

  const manifest = {
    schema: 1,
    package: { name: "ClamAV", version: "1.5.4", platform: "win-x64" },
    signature: {
      verified: true,
      keyFingerprint: TALOS_FINGERPRINT,
      signedByFingerprint: overrides.binarySigner ?? TALOS_FINGERPRINT,
    },
    extracted: { fileCount: extracted.length, totalBytes: extracted.reduce((n, f) => n + f.bytes, 0), files: extracted },
  };

  if (overrides.source !== null) {
    manifest.correspondingSource = {
      name: "clamav-1.5.4.tar.gz",
      bytes: source.length,
      sha256: sha256(source),
      verified: true,
      bundled: overrides.sourceBundled ?? true,
      bundledPath: overrides.sourcePath ?? "source/clamav-1.5.4.tar.gz",
      signature: {
        verified: overrides.sourceSignatureVerified ?? true,
        keyFingerprint: TALOS_FINGERPRINT,
        signedByFingerprint: overrides.sourceSigner ?? TALOS_FINGERPRINT,
      },
      ...(overrides.sourceExtra ?? {}),
    };
  }

  fs.writeFileSync(path.join(dir, "VENDOR.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

describe("verifyClamavBundle — integridade real, FALHA FECHADO", () => {
  it("aceita um bundle completo: ficheiros, licenças e fonte correspondente", (t) => {
    const dir = minimalBundle(t);
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, true, `devia ser válido: ${result.problems.join("; ")}`);
    assert.deepEqual(result.problems, []);
    assert.equal(result.version, "1.5.4");
    assert.equal(result.filesChecked, 3, "binário + licença + fonte");
    assert.equal(result.licenses, 1);
    assert.equal(result.sourceBundled, true);
  });

  it("sem manifesto ⇒ NÃO passa (o check deixou de confiar no nome dos ficheiros)", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-clamav-vazio-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeFiles(dir, [["clamscan.exe", Buffer.from("MZ")]]);
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /VENDOR\.json/, "tem de dizer qual é o manifesto em falta");
  });

  it("BITE: conteúdo alterado com o MESMO tamanho ⇒ só o sha256 o apanha", (t) => {
    const dir = minimalBundle(t, { tamperBinary: true });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false, "um binário alterado não pode passar");
    const problems = result.problems.join(" ");
    assert.match(problems, /clamscan\.exe/, "o problema tem de nomear o ficheiro");
    assert.match(problems, /sha256/, "e tem de ser a verificação de digest a apanhá-lo (o tamanho é o mesmo)");
  });

  it("ficheiro truncado ⇒ a verificação de bytes apanha-o", (t) => {
    const dir = minimalBundle(t, { truncateBinary: true });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /clamscan\.exe: 2 B no disco != 16 B no manifesto/);
  });

  it("sem licenças ⇒ recusado (redistribuir GPLv2 sem licença)", (t) => {
    const dir = minimalBundle(t, { withLicense: false });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /licen/i);
  });

  it("sem a fonte correspondente ⇒ recusado (GPLv2 §3 não cumprida)", (t) => {
    const dir = minimalBundle(t, { source: null });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /fonte correspondente/i);
    assert.equal(result.sourceBundled, false);
  });

  it("fonte registada mas NÃO incluída (`bundled:false`) ⇒ recusado", (t) => {
    const dir = minimalBundle(t, { sourceBundled: false });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /correspondingSource\.bundled/);
  });

  it("fonte incluída mas com o digest errado ⇒ recusado", (t) => {
    const dir = minimalBundle(t, { sourceExtra: { sha256: "0".repeat(64) } });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /fonte correspondente não confere/);
  });

  it("fonte sem assinatura verificada ⇒ recusado", (t) => {
    const dir = minimalBundle(t, { sourceSignatureVerified: false });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /assinatura/i);
  });

  it("binário assinado por OUTRO fingerprint ⇒ recusado", (t) => {
    const dir = minimalBundle(t, { binarySigner: "A".repeat(40) });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /fingerprint/i);
  });

  it("base de assinaturas listada no manifesto ⇒ recusado", (t) => {
    const dir = minimalBundle(t, { withCvdEntry: "daily.cvd" });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /base de assinaturas/i);
  });

  it("base de assinaturas SOLTA no disco (fora do manifesto) ⇒ recusado na mesma", (t) => {
    const dir = minimalBundle(t, { extraOnDisk: [["daily.cld", Buffer.from("x")]] });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false, "a varredura é ao disco, não só à lista do manifesto");
    assert.match(result.problems.join(" "), /daily\.cld/);
  });

  it("BITE: ficheiro EXTRA não listado ⇒ recusado (o extraResources publicá-lo-ia)", (t) => {
    // Reproduzido em %TEMP% antes do patch: com `unexpected.exe` no bundle e
    // nada mais errado, `ok` era `true` — o ficheiro era publicado no produto.
    const dir = minimalBundle(t, { extraOnDisk: [["unexpected.exe", Buffer.from("MZ-nao-verificado")]] });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false, "um ficheiro que ninguém verificou NÃO pode entrar no pacote");
    assert.match(result.problems.join(" "), /unexpected\.exe: ficheiro NÃO listado no manifesto/);
  });

  it("ficheiro extra escondido numa subpasta também é recusado", (t) => {
    const dir = minimalBundle(t, { extraOnDisk: [["source/personal.txt", Buffer.from("dados")]] });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false, "a allow-list é do disco inteiro, não só da raiz");
    assert.match(result.problems.join(" "), /source\/personal\.txt: ficheiro NÃO listado/);
  });

  it("sem a oferta de fonte gerada (SOURCE-OFFER.txt) ⇒ recusado", (t) => {
    const dir = minimalBundle(t, { withOffer: false });
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /SOURCE-OFFER\.txt/);
  });

  it("symlink dentro do bundle ⇒ recusado antes de ser lido (não se segue para fora)", (t) => {
    const dir = minimalBundle(t);
    const outside = path.join(os.tmpdir(), `cs-fora-${Date.now()}.txt`);
    fs.writeFileSync(outside, "fora do bundle");
    t.after(() => fs.rmSync(outside, { force: true }));
    // No Windows um symlink de FICHEIRO exige privilégio/Modo de Programador,
    // mas uma JUNCTION de directório não — e o lstat reporta-a como symlink na
    // mesma (medido: isSymbolicLink() true). Por isso há dois planos: se o
    // symlink falhar, a junction prova o mesmo contrato (reparse recusado e
    // NÃO seguido); se ambos falharem, o cenário é declarado não observável.
    let created = null;
    try {
      fs.symlinkSync(outside, path.join(dir, "atalho.txt"));
      created = "atalho.txt";
    } catch {
      // O alvo fica FORA do bundle: é isso que torna o cenário "um link que
      // puxa para dentro do pacote conteúdo que ninguém verificou".
      const alvo = fs.mkdtempSync(path.join(os.tmpdir(), "cs-alvo-fora-"));
      t.after(() => fs.rmSync(alvo, { recursive: true, force: true }));
      fs.writeFileSync(path.join(alvo, "extra.exe"), "conteúdo fora do bundle");
      try {
        fs.symlinkSync(alvo, path.join(dir, "liga"), "junction");
        created = "liga";
      } catch (error) {
        t.skip(`não foi possível criar symlink nem junction nesta máquina: ${error.message}`);
        return;
      }
    }
    const result = verifyClamavBundle({ bundleDir: dir });
    assert.equal(result.ok, false, "um link para fora do bundle não pode passar");
    assert.match(
      result.problems.join(" "),
      new RegExp(`${created}: symlink/reparse`),
      "o link tem de ser recusado pelo seu próprio nome",
    );
    // E o conteúdo do alvo NÃO pode ter sido lido/contado: nada de fora do
    // bundle entra na verificação (nem a ficheiros que o bundle "mostra").
    assert.deepEqual(
      result.problems,
      [`${created}: symlink/reparse dentro do bundle — recusado sem ser lido (não se segue para fora)`],
      "o único problema é o link: se o alvo tivesse sido lido, apareceriam mais",
    );
  });

  it("BITE: caminho LISTADO sob um link ⇒ recusado SEM ser lido (o alvo não é hasheado)", (t) => {
    // Este é o lado que a varredura ANTES das leituras tem de garantir: um
    // caminho que o manifesto LISTA e que, no disco, está sob um link para fora.
    // O alvo externo tem conteúdo DIFERENTE do registado, por isso uma leitura
    // através do link deixaria rasto observável ("não confere"/sha256). Sem
    // leitura, o rasto que fica é outro: o caminho "ausente" + o link recusado.
    const dir = minimalBundle(t);
    const fora = fs.mkdtempSync(path.join(os.tmpdir(), "cs-alvo-listado-"));
    t.after(() => fs.rmSync(fora, { recursive: true, force: true }));
    fs.writeFileSync(path.join(fora, "clamav-1.5.4.tar.gz"), "conteudo DIFERENTE do manifesto");
    fs.rmSync(path.join(dir, "source"), { recursive: true, force: true });
    try {
      fs.symlinkSync(fora, path.join(dir, "source"), "junction");
    } catch (error) {
      t.skip(`não foi possível criar a junction nesta máquina: ${error.message}`);
      return;
    }

    // Sinais de que o caminho LISTADO foi MEDIDO (lido através do link). O
    // antigo código media-o antes de recusar: com o alvo de tamanho diferente
    // isso aparecia como "N B no disco != M B no manifesto", e com o mesmo
    // tamanho como "sha256 ... != ...". Qualquer dos dois = leitura.
    // O sinal de leitura aparece sob duas formas conforme o percurso: no ficheiro
    // LISTADO é `<rel>: <B> no disco != <B> no manifesto` / `sha256 ... != ...`;
    // na fonte é `fonte correspondente não confere (<B>, sha256 ...)`. Ambas são
    // "o caminho foi medido".
    const measured = (r) => r.problems.filter((problem) => /não confere|no disco != |sha256 /.test(problem));

    const result = verifyClamavBundle({ bundleDir: dir });

    assert.equal(result.ok, false);
    assert.equal(result.sourceBundled, false, "a fonte não pode ser dada como verificada");
    assert.deepEqual(
      measured(result),
      [],
      `o caminho listado foi medido — logo lido através do link: ${result.problems.join("; ")}`,
    );
    assert.ok(
      result.problems.some((problem) => problem.startsWith("source: symlink/reparse")),
      `o link tem de ser reportado pelo seu próprio nome: ${result.problems.join("; ")}`,
    );
    assert.ok(
      result.problems.some((problem) => problem.startsWith("fonte correspondente ausente do bundle: source/")),
      `a fonte listada tem de ser dada como ausente (nunca como lida): ${result.problems.join("; ")}`,
    );
    // `filesChecked` conta só o que foi REALMENTE lido: binário + licença.
    assert.equal(result.filesChecked, 2, "a fonte sob o link não pode contar como verificada");

    // ── CONTROLO POSITIVO, no MESMO fixture ────────────────────────────────
    // Trocando a junction por um ficheiro REAL com conteúdo errado, o detector
    // TEM de disparar. Sem isto, o `deepEqual([])` acima podia passar por o
    // detector simplesmente não existir.
    fs.rmSync(path.join(dir, "source"), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "source"));
    fs.writeFileSync(path.join(dir, "source", "clamav-1.5.4.tar.gz"), "conteudo DIFERENTE do manifesto");
    const control = verifyClamavBundle({ bundleDir: dir });
    assert.equal(control.ok, false);
    assert.ok(
      measured(control).length > 0,
      `o detector de leitura tem de disparar num ficheiro real: ${control.problems.join("; ")}`,
    );
  });

  it("o MANIFESTO sob um link ancestral ⇒ recusado sem ser lido (não se lê de fora)", (t) => {
    // O manifesto era lido depois de se recusar o PRÓPRIO nome, mas não depois
    // de se saber que os seus ANCESTRAIS sobreviveram à travessia. Com um
    // directório ancestral linkado, a travessia recusa o ancestral (não desce)
    // e o manifesto não está na árvore aprovada: lê-lo seria ler através do
    // link exactamente o que o passo 0 proíbe.
    const dir = minimalBundle(t);
    const fora = fs.mkdtempSync(path.join(os.tmpdir(), "cs-manifesto-fora-"));
    t.after(() => fs.rmSync(fora, { recursive: true, force: true }));
    fs.copyFileSync(path.join(dir, "VENDOR.json"), path.join(fora, "VENDOR.json"));
    fs.rmSync(path.join(dir, "VENDOR.json"));
    try {
      fs.symlinkSync(fora, path.join(dir, "meta"), "junction");
    } catch (error) {
      t.skip(`não foi possível criar a junction nesta máquina: ${error.message}`);
      return;
    }

    const result = verifyClamavBundle({ bundleDir: dir, manifestPath: path.join(dir, "meta", "VENDOR.json") });

    assert.equal(result.ok, false, "um manifesto lido através de um link não pode passar");
    assert.equal(result.filesChecked, 0, "não pode ter verificado ficheiros depois de ler o manifesto de fora");
    assert.deepEqual(
      result.problems,
      ["meta/VENDOR.json: manifesto ausente do bundle ou sob um link/reparse — recusado sem ser lido"],
      `o único problema é o manifesto recusado (nada foi medido): ${result.problems.join("; ")}`,
    );
  });
});

describe("o bundle REAL publicado por vendor-clamav.mjs", () => {
  it("está íntegro segundo o manifesto (bytes + sha256 de cada ficheiro)", (t) => {
    if (!hasBundle) {
      t.skip("bundle não vendorizado nesta máquina (node scripts/vendor-clamav.mjs)");
      return;
    }
    const result = verifyClamavBundle();
    assert.equal(result.ok, true, `bundle inválido: ${result.problems.join("; ")}`);
    assert.equal(result.version, "1.5.4", "a versão fixada é 1.5.4");
    assert.equal(result.sourceBundled, true, "a fonte correspondente tem de estar dentro do bundle");
    assert.ok(result.licenses >= 13, `licenças presentes: ${result.licenses} (esperado >= 13)`);
    assert.ok(result.filesChecked >= 44, `ficheiros verificados: ${result.filesChecked} (43 do arquivo + a fonte)`);
    // Allow-list FECHADA: o que está no disco tem de ser EXACTAMENTE o conjunto
    // esperado (43 do arquivo + VENDOR.json + SOURCE-OFFER.txt + fonte + sig).
    // Se alguém largar um ficheiro a mais no bundle, `ok` deixa de ser true.
    const onDisk = (function walk(dir) {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    })(BUNDLE_DIR).length;
    assert.equal(
      onDisk,
      result.filesChecked + 2,
      "o disco tem de ser exactamente a allow-list: ficheiros verificados + VENDOR.json + SOURCE-OFFER.txt",
    );
  });

  it("a fonte correspondente casa com o digest medido INDEPENDENTEMENTE no teste", (t) => {
    if (!hasBundle) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const source = manifest.correspondingSource;
    assert.equal(source.bundled, true);
    const file = path.join(BUNDLE_DIR, ...String(source.bundledPath).split("/"));
    assert.ok(fs.existsSync(file), `fonte ausente: ${source.bundledPath}`);
    const data = fs.readFileSync(file);
    assert.equal(data.length, source.bytes, "tamanho da fonte");
    assert.equal(sha256(data), source.sha256, "sha256 da fonte");
    assert.equal(data[0], 0x1f);
    assert.equal(data[1], 0x8b, "a fonte é um gzip (1f 8b)");
    assert.equal(source.signature.verified, true);
    assert.equal(source.signature.signedByFingerprint, TALOS_FINGERPRINT, "assinada pela chave Talos fixada");
    // A assinatura da fonte também viaja no bundle.
    const sig = path.join(BUNDLE_DIR, "source", source.signature.name);
    assert.ok(fs.existsSync(sig), `assinatura da fonte ausente: ${sig}`);
  });

  it("não traz base de assinaturas, traz as licenças e não refere dados pessoais", (t) => {
    if (!hasBundle) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    const files = walk(BUNDLE_DIR).map((file) => path.relative(BUNDLE_DIR, file).split(path.sep).join("/"));
    assert.deepEqual(
      files.filter((file) => /\.(cvd|cld|cud|cuv)$/i.test(file)),
      [],
      "nenhuma base de assinaturas pode viajar no bundle",
    );
    assert.ok(files.includes("COPYING.txt"), "a licença do ClamAV tem de estar presente");
    assert.ok(
      files.filter((file) => file.startsWith("COPYING/")).length >= 12,
      "as licenças das bibliotecas embutidas (zlib/curl/LLVM/…) têm de estar presentes",
    );
    const text = `${fs.readFileSync(MANIFEST_PATH, "utf8")}${fs.readFileSync(path.join(BUNDLE_DIR, "SOURCE-OFFER.txt"), "utf8")}`;
    for (const personal of [os.homedir(), os.userInfo().username, REPO_ROOT]) {
      assert.ok(!text.includes(personal), `o bundle não pode referir ${personal}`);
    }
    assert.ok(
      fs.readFileSync(path.join(BUNDLE_DIR, "SOURCE-OFFER.txt"), "utf8").includes("source/clamav-1.5.4.tar.gz"),
      "a oferta de fonte tem de apontar para o ficheiro REALMENTE incluído no bundle",
    );
  });

  it("o --check reporta o bundle como íntegro e NÃO descarrega nem reescreve nada", (t) => {
    if (!hasBundle) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    const source = path.join(BUNDLE_DIR, "source", "clamav-1.5.4.tar.gz");
    const before = fs.statSync(source);
    const stdout = execFileSync(process.execPath, [SCRIPT, "--check", "--json"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      timeout: 120_000,
    });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.bundle.ok, true, `bundle com problemas: ${report.bundle.problems.join("; ")}`);
    assert.equal(report.bundle.sourceBundled, true);
    assert.equal(report.bundle.version, "1.5.4");
    assert.equal(report.staging.created, false, "o --check não cria staging");
    const after = fs.statSync(source);
    assert.equal(after.mtimeMs, before.mtimeMs, "o --check não pode reescrever a fonte (nem descarregar nada)");
    assert.equal(after.size, before.size);
  });
});

describe("publicação do bundle no pacote", () => {
  it("a pré-verificação exige o manifesto e a fonte correspondente", () => {
    const checks = preflightChecks();
    const ids = checks.map((check) => check.id);
    assert.ok(ids.includes("bundle-clamav:VENDOR.json"), "o manifesto do bundle tem de ser verificado");
    assert.ok(ids.includes("bundle-clamav:clamscan.exe"));
    const source = checks.find((check) => check.id === "bundle-clamav:fonte-correspondente");
    assert.ok(source, "a fonte correspondente tem de ser verificada");
    assert.ok(source.fix.includes("vendor-clamav.mjs"), "e o check tem de dizer como se regenera");
    if (hasBundle) {
      assert.equal(path.basename(source.path), "clamav-1.5.4.tar.gz", "o caminho vem do manifesto, não de um literal");
      assert.equal(source.exists, true);
    }
    for (const check of checks.filter((c) => c.id.startsWith("bundle-clamav:"))) {
      assert.equal(check.exists, fs.existsSync(check.path), `"${check.id}": o resultado tem de vir do disco`);
    }
  });

  it("o manifesto do pacote publica o bundle em resources/clamav (caminho absoluto)", () => {
    const desktopManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages", "desktop", "package.json"), "utf8"));
    const manifest = buildAppManifest({
      desktopManifest,
      tarballs: {
        "@cybersafe/core": "C:/tmp/staging/tarballs/core.tgz",
        "@cybersafe/shared-types": "C:/tmp/staging/tarballs/shared.tgz",
        "@cybersafe/service": "C:/tmp/staging/tarballs/service.tgz",
        api: "C:/tmp/staging/tarballs/api.tgz",
      },
      electronVersion: "33.4.11",
      scanEngine: path.join(REPO_ROOT, "packages", "native-engine", "build", "Release", "scan-engine.exe"),
      outDir: path.join(REPO_ROOT, "packages", "desktop", "release"),
      desktopDir: path.join(REPO_ROOT, "packages", "desktop"),
    });
    const entry = manifest.build.extraResources.find((resource) => resource.to === "clamav");
    assert.ok(entry, "o bundle ClamAV tem de ser publicado (to: \"clamav\" ⇒ resources/clamav)");
    assert.equal(entry.from, BUNDLE_DIR, "a origem é o bundle verificado do repositório");
    assert.ok(path.isAbsolute(entry.from), "a árvore de staging vive fora do repo: o `from` tem de ser absoluto");
    // E o `to` continua a ser relativo a `resources/` — é isso que põe o motor
    // em `process.resourcesPath/clamav/clamscan.exe`, o caminho do pin.
    assert.ok(!path.isAbsolute(entry.to));
  });

  it("o extraResources do desktop aponta para o MESMO bundle (uso directo do electron-builder)", () => {
    const desktopManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages", "desktop", "package.json"), "utf8"));
    const entry = (desktopManifest.build.extraResources ?? []).find((resource) => resource.to === "clamav");
    assert.ok(entry, "packages/desktop/package.json tem de listar o bundle");
    const expected = path.resolve(path.join(REPO_ROOT, "packages", "desktop"), entry.from);
    assert.equal(expected, BUNDLE_DIR, "o `from` relativo tem de resolver para vendor/clamav");
  });
});
