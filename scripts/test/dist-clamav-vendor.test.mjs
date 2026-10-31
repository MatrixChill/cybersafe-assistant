/**
 * DIST-CLAMAV13OUT — TESTES DO VENDOR Oficial do ClamAV (scripts/vendor-clamav.mjs).
 *
 * O que este ficheiro prova, SEM REDE, SEM GPG, SEM EXTRAIR NADA:
 *   1. um digest ou tamanho errado é REJEITADO (a verificação não é decorativa);
 *   2. a extração é CONTIDA: `..`, caminhos absolutos, letra de unidade,
 *      symlink e tudo o que está fora da allow-list é rejeitado;
 *   3. as LICENÇAS embutidas (`COPYING/COPYING.*`) contam como licença — o bug
 *      real medido na primeira corrida foi a allow-list comparar `COPYING/` em
 *      maiúsculas e deixar cair 12 licenças em silêncio;
 *   4. nada de bases de assinaturas entra no bundle (`.cvd`/`.cld`/`.cud`/`.cuv`);
 *   5. o parsing do status GPG só aceita GOODSIG+VALIDSIG com um fingerprint
 *      esperado — `BADSIG`, chave expirada/revogada ou ausência de status falham;
 *   6. só URLs HTTPS de hosts oficiais são aceites como fonte de download;
 *   7. o keyring do gpg é isolado (o homedir é convertido para a forma que o
 *      gpg do Git/MSYS entende, em vez do caminho do Windows que ele recusa).
 *
 * Uso: node --test scripts/test/dist-clamav-vendor.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SPEC,
  MAX_DOWNLOAD_BYTES,
  isEntryAllowed,
  isLicenseEntry,
  isOfficialUrl,
  isSymlinkEntry,
  commonRootPrefix,
  safeExtractTarget,
  checkSignatureStatus,
  verifyArtifact,
  toGpgHomedir,
  gitBlobSha1,
} from "../vendor-clamav.mjs";

const OUT = "C:\\out\\clamav";
const target = (entry) => safeExtractTarget(OUT, entry);

describe("especificação fixada do pacote oficial", () => {
  it("fixa 1.5.4 (nunca 1.5.2) e digests em forma", () => {
    assert.equal(SPEC.package.version, "1.5.4");
    assert.equal(SPEC.package.platform, "win-x64");
    assert.equal(SPEC.archive.name, `clamav-${SPEC.package.version}.win.x64.zip`);
    assert.match(SPEC.archive.sha256, /^[0-9a-f]{64}$/);
    assert.match(SPEC.signature.sha256, /^[0-9a-f]{64}$/);
    assert.match(SPEC.source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(SPEC.signature.name, `${SPEC.archive.name}.sig`);
  });

  it("só aceita fontes oficiais por HTTPS", () => {
    assert.ok(isOfficialUrl(SPEC.archive.url));
    assert.ok(isOfficialUrl(SPEC.signature.url));
    assert.ok(isOfficialUrl(SPEC.key.url));
    assert.equal(isOfficialUrl("http://github.com/x"), false, "HTTP simples não serve");
    assert.equal(isOfficialUrl("https://evil.example/clamav.zip"), false);
    assert.equal(isOfficialUrl("https://github.com.evil.example/x.zip"), false);
    assert.equal(isOfficialUrl("não é um url"), false);
  });

  it("o tecto de download é finito e cobre o arquivo conhecido", () => {
    assert.ok(MAX_DOWNLOAD_BYTES > SPEC.archive.bytes, "o tecto tem de cobrir o ZIP oficial");
    assert.ok(MAX_DOWNLOAD_BYTES < 1024 * 1024 * 1024, "e tem de ser um tecto, não um infinito");
  });
});

describe("verifyArtifact — digest errado é REJEITADO", () => {
  const real = {
    label: "ZIP",
    actualBytes: SPEC.archive.bytes,
    actualSha256: SPEC.archive.sha256,
    expectedBytes: SPEC.archive.bytes,
    expectedSha256: SPEC.archive.sha256,
  };

  it("aceita quando bytes e sha256 batem", () => {
    assert.deepEqual(verifyArtifact(real), { ok: true, problems: [] });
  });

  it("rejeita sha256 diferente (mesmo com bytes certos)", () => {
    const out = verifyArtifact({ ...real, actualSha256: "f".repeat(64) });
    assert.equal(out.ok, false);
    assert.match(out.problems.join(" "), /sha256/);
  });

  it("rejeita tamanho diferente (mesmo com sha256 certo)", () => {
    const out = verifyArtifact({ ...real, actualBytes: SPEC.archive.bytes + 1 });
    assert.equal(out.ok, false);
    assert.match(out.problems.join(" "), /B !=/);
  });

  it("rejeita quando não há medição nenhuma (não é 'não aplicável')", () => {
    const out = verifyArtifact({ label: "x", expectedBytes: 1, expectedSha256: "a".repeat(64) });
    assert.equal(out.ok, false);
    assert.equal(out.problems.length, 2);
  });

  it("compara sha256 sem depender de maiúsculas", () => {
    assert.equal(verifyArtifact({ ...real, actualSha256: SPEC.archive.sha256.toUpperCase() }).ok, true);
  });
});

describe("extração contida — contenção de caminhos", () => {
  const dangerous = [
    "../evil.dll",
    "..\\..\\evil.dll",
    "a/../../b.dll",
    "/etc/passwd",
    "C:\\evil.dll",
    "c:/evil.dll",
    "\\\\servidor\\share\\evil.dll",
    "clamscan.exe\x00.dll",
    "",
    "sub/",
  ];
  for (const entry of dangerous) {
    it(`rejeita ${JSON.stringify(entry)}`, () => {
      const result = safeExtractTarget(OUT, entry);
      assert.equal(result.ok, false, `${entry} não pode ser escrito`);
      assert.ok(result.target === undefined);
    });
  }

  it("rejeita uma tentativa de saída com um segmento '..' a meio", () => {
    assert.equal(target("certs/../../../evil.dll").ok, false);
    assert.equal(target("certs/..//evil.dll").ok, false);
  });

  it("aceita apenas a allow-list, dentro do destino", () => {
    for (const allowed of [
      "clamscan.exe",
      "freshclam.exe",
      "clamconf.exe",
      "libclamav.dll",
      "certs/clamav.crt",
      "COPYING.txt",
      "COPYING/COPYING.zlib",
      "conf_examples/freshclam.conf.sample",
    ]) {
      const result = target(allowed);
      assert.equal(result.ok, true, `${allowed} devia ser aceite`);
      assert.ok(result.target.startsWith("C:\\out\\clamav"), "tem de ficar dentro do destino");
    }
  });

  it("rejeita tudo o que o produto não usa (poda de artefactos de build)", () => {
    for (const rejected of [
      "sigtool.exe",
      "clambc.exe",
      "clamd.exe",
      "clamdscan.exe",
      "clamdtop.exe",
      "clamsubmit.exe",
      "sigtool.pdb",
      "libclamav.pdb",
      "clamav.lib",
      "clamav_rust.lib",
      "include/clamav.h",
      "UserManual/index.html",
      "README.md",
      "NEWS.md",
    ]) {
      assert.equal(target(rejected).ok, false, `${rejected} não pode entrar no bundle`);
    }
  });

  it("NUNCA deixa entrar uma base de assinaturas", () => {
    for (const db of ["daily.cld", "main.cvd", "bytecode.cud", "x.cuv", "sub/daily.cld"]) {
      assert.equal(target(db).ok, false, `${db} é base de assinaturas e não pode ser copiada`);
      assert.equal(isEntryAllowed(db), false);
    }
  });

  it("detecta entradas symlink pelo modo externo", () => {
    assert.equal(isSymlinkEntry(0xa1ff0000), true);
    assert.equal(isSymlinkEntry(0x81a40000), false, "ficheiro regular não é symlink");
    assert.equal(isSymlinkEntry(undefined), false);
  });
});

describe("licenças embutidas (o bug real da primeira corrida)", () => {
  it("isLicenseEntry reconhece maiúsculas/minúsculas", () => {
    for (const path of ["COPYING.txt", "copying.txt", "COPYING/COPYING.zlib", "copying/COPYING.curl", "Copying/Copying.llvm"]) {
      assert.equal(isLicenseEntry(path), true, `${path} é licença`);
    }
    for (const path of ["clamscan.exe", "COPYINGX.txt", "copying", "conf_examples/x"]) {
      assert.equal(isLicenseEntry(path), false, `${path} não é licença`);
    }
  });

  it("as licenças embutidas PASSAM a allow-list (eram rejeitadas por casing)", () => {
    const licenses = [
      "COPYING/COPYING.bzip2",
      "COPYING/COPYING.curl",
      "COPYING/COPYING.file",
      "COPYING/COPYING.getopt",
      "COPYING/COPYING.LGPL",
      "COPYING/COPYING.llvm",
      "COPYING/COPYING.lzma",
      "COPYING/COPYING.pcre",
      "COPYING/COPYING.regex",
      "COPYING/COPYING.unrar",
      "COPYING/COPYING.YARA",
      "COPYING/COPYING.zlib",
    ];
    for (const license of licenses) {
      assert.equal(isEntryAllowed(license), true, `${license} tem de ser preservada`);
      assert.equal(target(license).ok, true, `${license} tem de ser extraível`);
    }
  });
});

describe("checkSignatureStatus — só GOODSIG+VALIDSIG com fingerprint esperado", () => {
  const FPR = SPEC.key.fingerprint;
  const good = (fpr) =>
    [
      "[GNUPG:] NEWSIG",
      "[GNUPG:] KEY_CONSIDERED 5BADCA2665EF59DCF8A23D8B707F0DB480836771 0",
      `[GNUPG:] GOODSIG 707F0DB480836771 Talos (Talos, Cisco Systems Inc.) <research@sourcefire.com>`,
      `[GNUPG:] VALIDSIG ${fpr} 2026-08-07 1786118400 0 4 0 1 10 00 ${fpr}`,
    ].join("\n");

  it("aceita uma assinatura válida da chave esperada (primária ou subchave)", () => {
    assert.equal(checkSignatureStatus(good(FPR), [FPR]).ok, true);
    const sub = "69853AB2972F0C9970A842FBF567B6B2D1F17126";
    const result = checkSignatureStatus(good(sub), [FPR, sub]);
    assert.equal(result.ok, true);
    assert.equal(result.fingerprint, sub);
    assert.match(result.userId, /Talos/);
  });

  it("rejeita VALIDSIG de um fingerprint que não é o esperado", () => {
    const other = "A".repeat(40);
    const result = checkSignatureStatus(good(other), [FPR]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /fora das chaves esperadas/);
  });

  it("rejeita BADSIG mesmo com VALIDSIG presente", () => {
    const text = `${good(FPR)}\n[GNUPG:] BADSIG 707F0DB480836771 Talos`;
    assert.equal(checkSignatureStatus(text, [FPR]).ok, false);
  });

  it("rejeita chave expirada/revogada", () => {
    for (const tag of ["EXPKEYSIG", "REVKEYSIG", "EXPSIG"]) {
      const text = `${good(FPR)}\n[GNUPG:] ${tag} 707F0DB480836771 Talos`;
      const result = checkSignatureStatus(text, [FPR]);
      assert.equal(result.ok, false, `${tag} tem de falhar`);
    }
  });

  it("rejeita quando falta o status (silêncio não é aprovação)", () => {
    assert.equal(checkSignatureStatus("", [FPR]).ok, false);
    assert.equal(checkSignatureStatus("[GNUPG:] NEWSIG\n", [FPR]).ok, false);
    assert.equal(checkSignatureStatus("[GNUPG:] GOODSIG 1 Talos\n", [FPR]).ok, false, "GOODSIG sem VALIDSIG não chega");
  });
});

describe("keyring isolado + prefixo do arquivo", () => {
  it("converte o homedir para a forma que o gpg do Git/MSYS aceita", () => {
    const gpgMsys = "C:\\Program Files\\Git\\usr\\bin\\gpg.exe";
    assert.equal(
      toGpgHomedir("C:\\Users\\u\\AppData\\Local\\Temp\\x\\gnupg", gpgMsys),
      "/c/Users/u/AppData/Local/Temp/x/gnupg",
    );
    const gpgNative = "C:\\Program Files\\GnuPG\\bin\\gpg.exe";
    assert.equal(
      toGpgHomedir("C:\\Users\\u\\Temp\\x\\gnupg", gpgNative),
      "C:\\Users\\u\\Temp\\x\\gnupg",
      "um gpg nativo recebe o caminho do Windows",
    );
  });

  it("identifica a pasta raiz única do ZIP oficial", () => {
    assert.equal(commonRootPrefix(["r/a.txt", "r/b/c.txt", "r/"]), "r/");
    assert.equal(commonRootPrefix(["a.txt", "r/b.txt"]), "");
    assert.equal(commonRootPrefix(["r/a.txt", "s/b.txt"]), "");
  });

  it("gitBlobSha1 corresponde à identidade usada pela API oficial", () => {
    // Blob vazio do git é o vector conhecido: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
    assert.equal(gitBlobSha1(Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});
