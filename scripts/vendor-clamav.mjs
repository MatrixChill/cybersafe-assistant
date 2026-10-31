#!/usr/bin/env node
/**
 * VENDORIZAÇÃO DO CLAMAV PORTÁTIL OFICIAL (DIST-CLAMAV13OUT, incremento autorizado).
 *
 * PORQUE É QUE ISTO EXISTE
 * O instalador do CyberSafe não trazia motor nenhum: uma máquina limpa ficava
 * com `clamscan` `unavailable` e o produto não o dizia. Este script prepara
 * `vendor/clamav/` a partir do **pacote portátil OFICIAL** (Cisco/Talos) para
 * que o bundle possa ser empacotado depois (integração/NSIS é um passo
 * separado e NÃO acontece aqui).
 *
 * REGRAS (todas falham FECHADAS — qualquer dúvida = abortar, `vendor/` intacto)
 *  1. Fonte única: `github.com/Cisco-Talos/clamav` (release oficial). Nada de
 *     espelhos, nada de `unstable`, nada de "latest" resolvido em runtime.
 *  2. Versão, bytes, sha256 do ZIP e do `.sig` são CONSTANTES deste ficheiro.
 *     Divergência de bytes OU de digest = abortar.
 *  3. A chave GPG do Talos vem do URL que a documentação oficial do ClamAV
 *     indica, e é confirmada por DOIS caminhos independentes: tamanho/sha1 de
 *     blob do repositório oficial + fingerprint da chave importada. Sem essa
 *     confirmação, o bundle NÃO é usado.
 *  4. A assinatura tem de ser `GOODSIG`+`VALIDSIG` com o fingerprint de uma
 *     chave (primária ou subchave) da chave importada. `BADSIG`/sem status =
 *     abortar.
 *  5. Keyring ISOLADO (homedir próprio em %TEMP%): a chave nunca entra no
 *     keyring global do utilizador.
 *  6. Extração CONTIDA: allow-list explícita, e cada entrada é validada contra
 *     path traversal (absoluto, `..`, letra de unidade, symlink). Fora disso,
 *     abortar.
 *  7. Poda de artefactos de build (`.pdb`, `.lib`, `include/`, `UserManual/`,
 *     ferramentas que o produto não usa) — só na NOSSA staging.
 *  8. NÃO se copia nenhuma base CVD/CLD nem dado de utilizador: o freshclam da
 *     app obtém a base em `%USERPROFILE%\.cyberservice...` (per-user). O
 *     allow-list já REJEITA `.cvd`/`.cld`/`.cud`/`.cuv`.
 *  9. NÃO se corre o freshclam nem nenhuma varredura. Só `clamscan --version`
 *     (isolado, não lê a base, não analisa ficheiros) para provar que o binário
 *     empacotado arranca e reporta a versão fixada.
 * 10. A FONTE CORRESPONDENTE (GPLv2 §3) VAI DENTRO DO BUNDLE: o `tar.gz` oficial
 *     COMPLETO + a sua assinatura, ambos com sha256 fixado em constante e
 *     assinatura GPG verificada com a MESMA chave Talos do ZIP. Depender só de
 *     um URL ou de uma oferta escrita não é distribuição cumprida; o ficheiro
 *     viaja com o binário. Continua a NÃO se copiar base/assinaturas CVD/CLD
 *     nem qualquer dado de utilizador.
 *
 * Uso:
 *   node scripts/vendor-clamav.mjs                → verifica e publica vendor/clamav
 *   node scripts/vendor-clamav.mjs --check        → só pré-verificação local (sem rede)
 *   node scripts/vendor-clamav.mjs --keep-tmp     → mantém a staging para diagnóstico
 *   node scripts/vendor-clamav.mjs --help
 *
 * Códigos de saída: 0 = ok, 1 = verificação falhou (bundle NÃO publicado),
 * 2 = uso/flag inválida.
 *
 * Testabilidade: as decisões (digest, contenção, parsing de status GPG) são
 * funções puras exportadas; `scripts/test/dist-clamav-vendor.test.mjs` mede-as
 * sem rede. O pipeline só corre quando este ficheiro é o programa principal.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor", "clamav");

// ── Especificação fixada (metadados oficiais, 2026-10-13) ────────────────────
export const SPEC = {
  package: {
    name: "ClamAV",
    /** Fixado em 1.5.4 (autorizado). 1.5.2 nunca: afectado por CVEs de 1.5.3/1.5.4. */
    version: "1.5.4",
    platform: "win-x64",
    /** GPL-2.0-only; `COPYING.txt` viaja no bundle. */
    license: "GPL-2.0-only",
    licenseFile: "COPYING.txt",
  },
  archive: {
    name: "clamav-1.5.4.win.x64.zip",
    url: "https://github.com/Cisco-Talos/clamav/releases/download/clamav-1.5.4/clamav-1.5.4.win.x64.zip",
    bytes: 225_774_978,
    sha256: "0d9e0228b2674137ea1a2853566c98a0278ad52ab2582c3d6dbd75373848c395",
  },
  signature: {
    name: "clamav-1.5.4.win.x64.zip.sig",
    url: "https://github.com/Cisco-Talos/clamav/releases/download/clamav-1.5.4/clamav-1.5.4.win.x64.zip.sig",
    bytes: 801,
    sha256: "42189dd43040cd5fe4ba71a963f8d7a402b6cd2284099b653f42ca73f4055f50",
  },
  /**
   * Fonte correspondente (GPLv2 §3) — EMPACOTADA no bundle, com assinatura.
   * sha256/bytes/digest do `.sig` confirmados por METADATA OFICIAL da release
   * (asset `digest` da API de releases do `github.com/Cisco-Talos/clamav`,
   * 2026-10-13): o tar.gz medido bate certo com o que a release publica.
   */
  source: {
    name: "clamav-1.5.4.tar.gz",
    url: "https://github.com/Cisco-Talos/clamav/releases/download/clamav-1.5.4/clamav-1.5.4.tar.gz",
    bytes: 63_702_396,
    sha256: "1af1117a228f1b5bc7fa91a0dabc37848a99e7d25188e9be8043332ce721dfd3",
    /** Assinatura Talos da fonte — mesmo gate do ZIP, não "confiar no HTTPS". */
    sig: {
      name: "clamav-1.5.4.tar.gz.sig",
      url: "https://github.com/Cisco-Talos/clamav/releases/download/clamav-1.5.4/clamav-1.5.4.tar.gz.sig",
      bytes: 801,
      sha256: "8acf5816c3c9dc8b02a2e11f93d90d37b25845a0481e16873454df4a30a375c0",
    },
    /** Directório, dentro do bundle, onde a fonte (e a sua assinatura) vão. */
    dir: "source",
  },
  key: {
    /** URL PUBLICADO pela documentação oficial: src/manual/Installing.md do
     *  repositório Cisco-Talos/clamav-documentation (secção
     *  "Verifying ClamAV.net Downloads with GPG"). */
    url: "https://raw.githubusercontent.com/Cisco-Talos/clamav-documentation/main/src/manual/cisco-talos.gpg",
    /** sha1 de blob do repositório oficial (confirmado pela API de contents). */
    blobSha1: "55837de36413784018702116365d2f061294e7db",
    bytes: 3858,
    fingerprint: "5BADCA2665EF59DCF8A23D8B707F0DB480836771",
    userIdPrefix: "Talos (Talos, Cisco Systems Inc.)",
  },
};

/** Tecto do download (o ZIP oficial tem ~215 MiB; a margem é folgada e FINITA). */
export const MAX_DOWNLOAD_BYTES = 288 * 1024 * 1024;

/** Tecto do download da fonte (o `tar.gz` oficial tem ~61 MiB). */
export const MAX_SOURCE_BYTES = 96 * 1024 * 1024;

/** O único domínio de onde este script descarrega. */
export const ALLOWED_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);

/**
 * Allow-list de extração. Tudo o que não casa é REJEITADO (não "ignorado em
 * silêncio"): assim um pacote com ficheiros a mais falha alto em vez de
 * arrastar superfície para dentro do produto.
 *
 * Ficam de fora, de propósito: `sigtool`/`clambc` (~30 MB cada, não usados),
 * `clamd*`/`clamdscan`/`clamdtop` (o produto usa a bridge do `clamscan`),
 * `clamsubmit`, `*.pdb`/`*.lib`/`include/`/`UserManual/` (artefactos de build)
 * e qualquer base de assinaturas (`*.cvd`/`*.cld`/`*.cud`/`*.cuv`).
 */
const ALLOWED_EXECUTABLES = new Set(["clamscan.exe", "freshclam.exe", "clamconf.exe"]);
const ALLOWED_EXACT = new Set(["copying.txt"]);
/**
 * Prefixos em MINÚSCULAS: a comparação é contra o caminho normalizado em
 * minúsculas. MEDIDO (2026-10-13, primeira corrida): com o prefixo em
 * maiúsculas (`"COPYING/"`), as 12 licenças embutidas de terceiros
 * (`COPYING/COPYING.zlib`, `.curl`, `.llvm`, …) foram REJEITADAS e o bundle
 * saiu sem elas — o ficheiro `COPYING.txt` sozinho não cobre zlib/curl/LLVM.
 * O erro era silencioso (rejeição "fora da allow-list"); agora é impossível:
 * ver a verificação `assertLicensesPreserved` mais abaixo, que FALHA se
 * qualquer entrada de licença do arquivo não for extraída.
 */
const ALLOWED_DIR_PREFIXES = ["certs/", "copying/", "conf_examples/"];
const FORBIDDEN_EXTENSIONS = new Set([".pdb", ".lib", ".cvd", ".cld", ".cud", ".cuv", ".a", ".obj", ".exp"]);

/** Uma entrada (já sem a raiz do arquivo) é uma licença a preservar? */
export function isLicenseEntry(relPath) {
  const lower = String(relPath ?? "").replace(/\\/g, "/").toLowerCase();
  return lower === "copying.txt" || lower.startsWith("copying/");
}

/** Um caminho relativo (barras normais) está na allow-list? */
export function isEntryAllowed(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  const rel = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel.length === 0 || rel.endsWith("/")) return false;
  const lower = rel.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
  if (FORBIDDEN_EXTENSIONS.has(ext)) return false;
  if (ALLOWED_EXACT.has(lower)) return true;
  if (!lower.includes("/") && ALLOWED_EXECUTABLES.has(lower)) return true;
  if (ext === ".dll" && !lower.includes("/")) return true;
  return ALLOWED_DIR_PREFIXES.some(
    (prefix) => lower.startsWith(prefix) && lower.length > prefix.length,
  );
}

/**
 * Onde é que uma entrada do ZIP pode ser escrita? `null` = rejeitada.
 *
 * A contenção é aqui e é literal: caminho absoluto, letra de unidade, `..`,
 * entrada vazia ou ficheiro que a allow-list não cobre → rejeitado. O
 * consumidor NUNCA junta caminhos sem passar por isto.
 */
export function safeExtractTarget(outDir, entryName) {
  const raw = String(entryName ?? "").replace(/\\/g, "/");
  if (!raw || raw.endsWith("/")) return { ok: false, reason: "entrada de diretório ou vazia" };
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, reason: "caminho absoluto" };
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    return { ok: false, reason: "path traversal" };
  }
  if (/[\u0000-\u001f]/.test(raw)) return { ok: false, reason: "caracteres de controlo" };
  if (!isEntryAllowed(raw)) return { ok: false, reason: "fora da allow-list" };
  const target = path.resolve(outDir, ...segments);
  const rootResolved = path.resolve(outDir);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    return { ok: false, reason: "fora do directório de destino" };
  }
  return { ok: true, target, rel: segments.join("/") };
}

/** Um `mode` de entrada de ZIP é symlink? (bits altos de `externalFileAttributes`) */
export function isSymlinkEntry(attr) {
  if (!Number.isFinite(attr)) return false;
  return ((attr >>> 16) & 0xf000) === 0xa000;
}

/** Digest de um buffer/ficheiro. */
export function sha256Of(input) {
  const hash = createHash("sha256");
  hash.update(input);
  return hash.digest("hex");
}

/**
 * O ficheiro é mesmo um `gzip`? (`1f 8b` + método deflate na 3.ª posição).
 * É uma verificação ESTRUTURAL barata: um ficheiro truncado, um HTML de erro
 * guardado como `.tar.gz`, ou um bloco de zeros não passam por aqui — o sha256
 * fixado já cobre o resto.
 */
export function isGzipBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return false;
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return false;
  if (buf[2] !== 0x08) return false; // método: deflate
  return true;
}

/** sha1 no formato de blob do git — a identidade com que a API oficial reporta o ficheiro. */
export function gitBlobSha1(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/**
 * Verificação de um artefacto contra um contrato fixado. Um campo em falta é
 * uma falha, não "não aplicável".
 */
export function verifyArtifact({ label, actualBytes, actualSha256, expectedBytes, expectedSha256 }) {
  const problems = [];
  if (typeof actualBytes !== "number" || !Number.isFinite(actualBytes)) problems.push(`${label}: bytes não medidos`);
  else if (actualBytes !== expectedBytes) problems.push(`${label}: ${actualBytes} B != ${expectedBytes} B`);
  if (typeof actualSha256 !== "string" || actualSha256.length === 0) problems.push(`${label}: sha256 não medido`);
  else if (actualSha256.toLowerCase() !== String(expectedSha256).toLowerCase()) {
    problems.push(`${label}: sha256 ${actualSha256} != ${expectedSha256}`);
  }
  return { ok: problems.length === 0, problems };
}

/** O URL é oficial (HTTPS + host na allow-list)? */
export function isOfficialUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Interpreta o `--status-fd=1` do gpg.
 *
 * Regra: `VALIDSIG` com um fingerprint da chave esperada (primária ou
 * subchave) E sem `BADSIG`/`REVKEYSIG`/`EXPKEYSIG`. Qualquer ambiguidade
 * (sem VALIDSIG, fingerprint estranho, assinatura má) é falha.
 */
export function checkSignatureStatus(statusText, expectedKeyFingerprints) {
  const expected = new Set((expectedKeyFingerprints ?? []).map((f) => String(f).toUpperCase()));
  const lines = String(statusText ?? "").split(/\r?\n/);
  const fields = (line) => {
    const match = /^\[GNUPG:\]\s+(\S+)\s*(.*)$/.exec(line.trim());
    return match ? { tag: match[1], rest: match[2].trim() } : null;
  };
  const tags = lines.map(fields).filter(Boolean);
  if (tags.some((entry) => entry.tag === "BADSIG")) return { ok: false, reason: "BADSIG: a assinatura não é válida para esta chave" };
  for (const bad of ["REVKEYSIG", "EXPKEYSIG", "EXPSIG"]) {
    if (tags.some((entry) => entry.tag === bad)) return { ok: false, reason: `${bad}: chave/assinatura revogada ou expirada` };
  }
  const good = tags.find((entry) => entry.tag === "GOODSIG");
  const valid = tags.find((entry) => entry.tag === "VALIDSIG");
  if (!good) return { ok: false, reason: "sem GOODSIG: a assinatura não foi confirmada" };
  if (!valid) return { ok: false, reason: "sem VALIDSIG: o gpg não confirmou o fingerprint do assinante" };
  const fpr = (valid.rest.split(/\s+/)[0] ?? "").toUpperCase();
  if (!fpr) return { ok: false, reason: "VALIDSIG sem fingerprint" };
  if (!expected.has(fpr)) return { ok: false, reason: `VALIDSIG de ${fpr}, fora das chaves esperadas` };
  return { ok: true, fingerprint: fpr, userId: good.rest.replace(/^\S+\s*/, "") };
}

/**
 * Extrai o prefixo comum de todas as entradas (o ZIP oficial traz uma pasta
 * raiz). Devolve `""` quando não há prefixo único — nesse caso não se tira nada.
 */
export function commonRootPrefix(entryNames) {
  const firsts = new Set();
  for (const name of entryNames) {
    const segments = String(name).replace(/\\/g, "/").split("/");
    if (segments.length < 2) return "";
    firsts.add(segments[0]);
    if (firsts.size > 1) return "";
  }
  const only = [...firsts][0] ?? "";
  return only ? `${only}/` : "";
}

// ── Processo (só corre quando este ficheiro é o programa principal) ─────────

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function findGpg() {
  const envPath = process.env.CYBERSAFE_GPG_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  const winGpg = "C:\\Program Files\\Git\\usr\\bin\\gpg.exe";
  if (process.platform === "win32" && fs.existsSync(winGpg)) return winGpg;
  const which = process.platform === "win32" ? "where.exe" : "which";
  try {
    const out = execFileSync(which, ["gpg"], { encoding: "utf8", windowsHide: true });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) return first;
  } catch {
    /* sem gpg */
  }
  return null;
}

/**
 * O `gpg` do Git/MSYS interpreta `--homedir` como caminho POSIX: passar-lhe
 * `C:\Users\…\Temp\x` fazia-o procurar `…/C:\Users\…\Temp\x` e abortar com
 * "no writable keyring found" (medido). Convertemos para `/c/Users/…` quando o
 * binário é MSYS; um GnuPG nativo continua a receber o caminho do Windows.
 */
export function toGpgHomedir(nativePath, gpgPath) {
  if (process.platform !== "win32") return nativePath;
  const isMsys = /[\\/]usr[\\/]bin[\\/]gpg(\.exe)?$/i.test(gpgPath) || /git[\\/]/i.test(gpgPath);
  if (!isMsys) return nativePath;
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(nativePath);
  if (!match) return nativePath;
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function findCurl() {
  const which = process.platform === "win32" ? "where.exe" : "which";
  for (const name of process.platform === "win32" ? ["curl.exe"] : ["curl"]) {
    try {
      const out = execFileSync(which, [name], { encoding: "utf8", windowsHide: true });
      const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (first) return first;
    } catch {
      /* tenta o próximo */
    }
  }
  return null;
}

function fail(message) {
  process.stderr.write(`[vendor-clamav] FALHA: ${message}\n`);
  process.exit(1);
}

function download(url, destFile, label, limit) {
  if (!isOfficialUrl(url)) fail(`${label}: URL não oficial ou não-HTTPS: ${url}`);
  const curl = findCurl();
  if (!curl) fail("curl não encontrado — sem downloader HTTPS confiável");
  process.stdout.write(`[vendor-clamav] a descarregar ${label}…\n`);
  try {
    execFileSync(
      curl,
      [
        "-sS", "-L", "--fail", "--proto", "=https", "--tlsv1.2",
        "--max-time", "900",
        "--max-filesize", String(limit),
        "-o", destFile, url,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 960_000, windowsHide: true },
    );
  } catch (error) {
    fail(`${label}: download falhou (${String(error?.stderr ?? error?.message ?? error).slice(0, 300)})`);
  }
  const bytes = fs.statSync(destFile).size;
  if (bytes > limit) fail(`${label}: ${bytes} B excede o limite de ${limit} B`);
  return bytes;
}

function importKey(gpg, homedir, keyFile) {
  const env = { ...process.env, GNUPGHOME: homedir };
  try {
    execFileSync(gpg, ["--homedir", homedir, "--batch", "--no-tty", "--quiet", "--import", keyFile], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    fail(`importação da chave falhou: ${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`);
  }
  const colonOut = execFileSync(gpg, ["--homedir", homedir, "--batch", "--with-colons", "--fingerprint", "--list-keys"], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  const primaryFingerprints = [];
  const subkeyFingerprints = [];
  let currentIsPrimary = false;
  for (const line of colonOut.split(/\r?\n/)) {
    const parts = line.split(":");
    if (parts[0] === "pub") {
      currentIsPrimary = true;
    } else if (parts[0] === "sub") {
      currentIsPrimary = false;
    } else if (parts[0] === "fpr" && parts[9]) {
      (currentIsPrimary ? primaryFingerprints : subkeyFingerprints).push(parts[9].toUpperCase());
    }
  }
  const userIds = colonOut
    .split(/\r?\n/)
    .filter((line) => line.startsWith("uid:"))
    .map((line) => line.split(":")[9] ?? "");
  return { primaryFingerprints, subkeyFingerprints, userIds };
}

function verifySignature(gpg, homedir, sigFile, zipFile, keyFingerprints) {
  const env = { ...process.env, GNUPGHOME: homedir };
  let status = "";
  try {
    status = execFileSync(
      gpg,
      ["--homedir", homedir, "--batch", "--no-tty", "--status-fd=1", "--verify", sigFile, zipFile],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
  } catch (error) {
    status = String(error?.stdout ?? "");
    if (!status) fail(`gpg --verify falhou sem status: ${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`);
  }
  return checkSignatureStatus(status, keyFingerprints);
}

export function main(argv) {
  if (argv.includes("--help")) {
    process.stdout.write(
      [
        "Uso: node scripts/vendor-clamav.mjs [--check] [--keep-tmp] [--help]",
        "",
        `Prepara ${path.relative(root, vendorDir)} a partir do ClamAV portátil oficial ${SPEC.package.version}.`,
        "Sem GPG válido, sem digest correcto ou com entrada fora da allow-list, NÃO publica nada.",
        "",
        "  --check      só pré-verificação local (ferramentas + spec), sem rede",
        "  --keep-tmp   mantém a staging em %TEMP% para diagnóstico",
        "  --help       esta ajuda",
        "",
        "Códigos de saída: 0 = ok, 1 = verificação falhou, 2 = uso inválido.",
      ].join("\n") + "\n",
    );
    return 0;
  }

  const known = new Set(["--check", "--keep-tmp"]);
  const unknown = argv.filter((arg) => arg.startsWith("--") && !known.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(`[vendor-clamav] flag desconhecida: ${unknown.join(", ")}\nUso: node scripts/vendor-clamav.mjs [--check] [--keep-tmp] [--help]\n`);
    return 2;
  }    const checkOnly = argv.includes("--check");
  const keepTmp = argv.includes("--keep-tmp");

  const gpg = findGpg();
  const curl = findCurl();
  const specProblems = [];
  if (!isOfficialUrl(SPEC.archive.url) || !isOfficialUrl(SPEC.signature.url) || !isOfficialUrl(SPEC.key.url)) {
    specProblems.push("URL não oficial na especificação");
  }
  for (const [label, value] of [["archive.sha256", SPEC.archive.sha256], ["signature.sha256", SPEC.signature.sha256], ["key.blobSha1", SPEC.key.blobSha1]]) {
    if (!/^[0-9a-f]{40,64}$/i.test(value)) specProblems.push(`${label} não parece um digest`);
  }
  if (!/^[0-9A-F]{40}$/i.test(SPEC.key.fingerprint)) specProblems.push("key.fingerprint inválida");

  process.stdout.write(
    [
      "[vendor-clamav] pré-verificação",
      `  versão fixada : ${SPEC.package.version} (${SPEC.package.platform})`,
      `  arquivo       : ${SPEC.archive.name} (${SPEC.archive.bytes} B)`,
      `  fonte (GPL)   : ${SPEC.source.name} (${SPEC.source.bytes} B) — incluída no bundle`,
      `  chave Talos   : ${SPEC.key.fingerprint}`,
      `  gpg           : ${gpg ?? "(não encontrado)"}`,
      `  curl          : ${curl ?? "(não encontrado)"}`,
      `  destino       : ${vendorDir}`,
    ].join("\n") + "\n",
  );
  if (specProblems.length > 0) fail(`especificação inválida: ${specProblems.join("; ")}`);
  if (checkOnly) {
    if (!gpg) fail("gpg não encontrado — sem ele o bundle não pode ser verificado");
    if (!curl) fail("curl não encontrado — sem ele o bundle não pode ser descarregado");
    process.stdout.write("[vendor-clamav] --check: ferramentas e especificação ok (nada descarregado).\n");
    return 0;
  }
  if (!gpg) fail("gpg não encontrado — sem verificação de assinatura o bundle não é usado");
  if (!curl) fail("curl não encontrado — sem downloader HTTPS");

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-clamav-vendor-"));
  const keyHomedir = path.join(staging, "gnupg");
  fs.mkdirSync(keyHomedir, { recursive: true, mode: 0o700 });
  // Keyring ISOLADO: `--homedir` (e `GNUPGHOME`) apontam para a nossa staging —
  // a chave nunca toca no keyring do utilizador.
  const gpgHome = toGpgHomedir(keyHomedir, gpg);
  const outDir = path.join(staging, "extract");
  fs.mkdirSync(outDir, { recursive: true });

  const cleanup = () => {
    if (keepTmp) {
      process.stdout.write(`[vendor-clamav] staging preservada: ${staging}\n`);
      return;
    }
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    // 1. Chave Talos, do URL que a documentação oficial indica.
    const keyFile = path.join(staging, "cisco-talos.gpg");
    const keyBytes = download(SPEC.key.url, keyFile, "chave Talos", 64 * 1024);
    const keyContent = fs.readFileSync(keyFile);
    const keyCheck = verifyArtifact({
      label: "chave Talos",
      actualBytes: keyBytes,
      actualSha256: gitBlobSha1(keyContent),
      expectedBytes: SPEC.key.bytes,
      expectedSha256: SPEC.key.blobSha1,
    });
    if (!keyCheck.ok) fail(`chave Talos não confere com o blob oficial: ${keyCheck.problems.join("; ")}`);
    const imported = importKey(gpg, gpgHome, keyFile);
    if (!imported.primaryFingerprints.includes(SPEC.key.fingerprint)) {
      fail(`chave Talos com fingerprint inesperada: ${imported.primaryFingerprints.join(",") || "(nenhuma)"} != ${SPEC.key.fingerprint}`);
    }
    if (!imported.userIds.some((uid) => uid.startsWith(SPEC.key.userIdPrefix))) {
      fail(`chave Talos sem o uid oficial esperado (${SPEC.key.userIdPrefix}); uid(s): ${imported.userIds.join(" | ")}`);
    }
    process.stdout.write(`[vendor-clamav] chave Talos confirmada: ${SPEC.key.fingerprint}\n`);

    // 2. Assinatura.
    const sigFile = path.join(staging, SPEC.signature.name);
    const sigBytes = download(SPEC.signature.url, sigFile, "assinatura .sig", 64 * 1024);
    const sigCheck = verifyArtifact({
      label: ".sig",
      actualBytes: sigBytes,
      actualSha256: sha256Of(fs.readFileSync(sigFile)),
      expectedBytes: SPEC.signature.bytes,
      expectedSha256: SPEC.signature.sha256,
    });
    if (!sigCheck.ok) fail(`assinatura não confere: ${sigCheck.problems.join("; ")}`);

    // 3. ZIP.
    const zipFile = path.join(staging, SPEC.archive.name);
    const zipBytes = download(SPEC.archive.url, zipFile, "ZIP oficial", MAX_DOWNLOAD_BYTES);
    const zipCheck = verifyArtifact({
      label: "ZIP",
      actualBytes: zipBytes,
      actualSha256: sha256Of(fs.readFileSync(zipFile)),
      expectedBytes: SPEC.archive.bytes,
      expectedSha256: SPEC.archive.sha256,
    });
    if (!zipCheck.ok) fail(`ZIP não confere: ${zipCheck.problems.join("; ")}`);
    process.stdout.write(`[vendor-clamav] ZIP: ${zipBytes} B, sha256 ok\n`);

    // 4. Assinatura GPG sobre o ZIP.
    const keyFingerprints = [...imported.primaryFingerprints, ...imported.subkeyFingerprints];
    const signature = verifySignature(gpg, gpgHome, sigFile, zipFile, keyFingerprints);
    if (!signature.ok) fail(`assinatura do ZIP rejeitada: ${signature.reason}`);
    process.stdout.write(`[vendor-clamav] assinatura VALIDSIG ${signature.fingerprint} — ${signature.userId}\n`);

    // 4b. FONTE CORRESPONDENTE (GPLv2 §3): o `tar.gz` oficial COMPLETO e a sua
    // assinatura. Mesmos três gates do ZIP — bytes, sha256 fixado e assinatura
    // Talos com o fingerprint exigido — porque "descarregado por HTTPS" não é
    // prova de nada. Sem este passo o bundle sairia só com um URL/oferta escrita.
    const srcFile = path.join(staging, SPEC.source.name);
    const srcBytes = download(SPEC.source.url, srcFile, "fonte oficial (tar.gz)", MAX_SOURCE_BYTES);
    const srcCheck = verifyArtifact({
      label: "fonte .tar.gz",
      actualBytes: srcBytes,
      actualSha256: sha256Of(fs.readFileSync(srcFile)),
      expectedBytes: SPEC.source.bytes,
      expectedSha256: SPEC.source.sha256,
    });
    if (!srcCheck.ok) fail(`fonte correspondente não confere: ${srcCheck.problems.join("; ")}`);
    if (!isGzipBuffer(fs.readFileSync(srcFile).subarray(0, 10))) {
      fail("fonte correspondente não é um gzip válido (assinatura estrutural do ficheiro)");
    }
    const srcSigFile = path.join(staging, SPEC.source.sig.name);
    const srcSigBytes = download(SPEC.source.sig.url, srcSigFile, "assinatura da fonte", 64 * 1024);
    const srcSigCheck = verifyArtifact({
      label: "fonte .sig",
      actualBytes: srcSigBytes,
      actualSha256: sha256Of(fs.readFileSync(srcSigFile)),
      expectedBytes: SPEC.source.sig.bytes,
      expectedSha256: SPEC.source.sig.sha256,
    });
    if (!srcSigCheck.ok) fail(`assinatura da fonte não confere: ${srcSigCheck.problems.join("; ")}`);
    const srcSignature = verifySignature(gpg, gpgHome, srcSigFile, srcFile, keyFingerprints);
    if (!srcSignature.ok) fail(`assinatura da fonte rejeitada: ${srcSignature.reason}`);
    process.stdout.write(
      `[vendor-clamav] fonte: ${srcBytes} B, sha256 ok, assinatura VALIDSIG ${srcSignature.fingerprint}\n`,
    );
    const sourceOutDir = path.resolve(outDir, SPEC.source.dir);
    if (!sourceOutDir.startsWith(path.resolve(outDir) + path.sep)) {
      fail(`destino da fonte fora do bundle: ${sourceOutDir}`);
    }
    fs.mkdirSync(sourceOutDir, { recursive: true });
    fs.copyFileSync(srcFile, path.join(sourceOutDir, SPEC.source.name));
    fs.copyFileSync(srcSigFile, path.join(sourceOutDir, SPEC.source.sig.name));

    // 5. Extração contida + poda.
    const zip = new AdmZip(zipFile);
    const entries = zip.getEntries();
    const prefix = commonRootPrefix(entries.map((entry) => entry.entryName));
    const written = [];
    const rejected = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const rel = prefix && entry.entryName.replace(/\\/g, "/").startsWith(prefix)
        ? entry.entryName.replace(/\\/g, "/").slice(prefix.length)
        : entry.entryName;
      const target = safeExtractTarget(outDir, rel);
      if (!target.ok) {
        rejected.push({ entry: entry.entryName, reason: target.reason });
        continue;
      }
      if (isSymlinkEntry(entry.header?.attr)) {
        rejected.push({ entry: entry.entryName, reason: "symlink" });
        continue;
      }
      fs.mkdirSync(path.dirname(target.target), { recursive: true });
      const data = entry.getData();
      fs.writeFileSync(target.target, data);
      written.push({ path: target.rel, bytes: data.length, sha256: sha256Of(data) });
    }
    if (written.length === 0) fail("extração não produziu ficheiros (allow-list vazia?)");
    const required = ["clamscan.exe", "freshclam.exe", "COPYING.txt"];
    for (const name of required) {
      if (!written.some((file) => file.path.toLowerCase() === name.toLowerCase())) {
        fail(`bundle sem ficheiro obrigatório: ${name}`);
      }
    }
    if (written.some((file) => /\.(cvd|cld|cud|cuv)$/i.test(file.path))) {
      fail("bundle contém base de assinaturas — nunca deve ser copiada");
    }
    // Garantia de licenças: TODA a entrada de licença do arquivo tem de ter
    // sido extraída. Sem isto, um erro na allow-list publicava em silêncio um
    // bundle sem as licenças das bibliotecas embutidas (zlib/curl/LLVM/…).
    const licenseEntries = entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => {
        const normalized = prefix && entry.entryName.replace(/\\/g, "/").startsWith(prefix)
          ? entry.entryName.replace(/\\/g, "/").slice(prefix.length)
          : entry.entryName;
        return normalized;
      })
      .filter((rel) => isLicenseEntry(rel));
    const missingLicenses = licenseEntries.filter(
      (rel) => !written.some((file) => file.path.toLowerCase() === rel.toLowerCase()),
    );
    if (missingLicenses.length > 0) {
      fail(`licenças embutidas não extraídas: ${missingLicenses.join(", ")}`);
    }
    const totalBytes = written.reduce((sum, file) => sum + file.bytes, 0);
    process.stdout.write(
      `[vendor-clamav] extraídos ${written.length} ficheiros, ${totalBytes} B (${(totalBytes / 1024 / 1024).toFixed(1)} MiB); rejeitados ${rejected.length}\n`,
    );

    // 6. Prova de que o binário arranca — SÓ `--version` (não lê base, não analisa nada).
    let versionOutput = "";
    try {
      versionOutput = execFileSync(path.join(outDir, "clamscan.exe"), ["--version"], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
    } catch (error) {
      fail(`clamscan do bundle não arrancou: ${String(error?.message ?? error).slice(0, 200)}`);
    }
    if (!versionOutput.includes(`ClamAV ${SPEC.package.version}`)) {
      fail(`clamscan do bundle reportou "${versionOutput.trim()}" e não ClamAV ${SPEC.package.version}`);
    }
    process.stdout.write(`[vendor-clamav] clamscan --version → ${versionOutput.trim()}\n`);

    // 7. Prova de que o bundle publicado tem a fonte COMPLETA e as licenças.
    const sourceBundleFiles = [
      { path: `${SPEC.source.dir}/${SPEC.source.name}`, bytes: srcBytes, sha256: SPEC.source.sha256 },
      { path: `${SPEC.source.dir}/${SPEC.source.sig.name}`, bytes: srcSigBytes, sha256: SPEC.source.sig.sha256 },
    ];
    for (const file of sourceBundleFiles) {
      if (!fs.existsSync(path.join(outDir, file.path))) fail(`bundle sem a fonte correspondente: ${file.path}`);
    }

    // 8. Publicação: staging completa primeiro, só depois substitui vendor/clamav.
    const manifest = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      tool: "scripts/vendor-clamav.mjs",
      package: SPEC.package,
      archive: { ...SPEC.archive, verified: true, downloadedBytes: zipBytes },
      signature: {
        ...SPEC.signature,
        verified: true,
        keyUrl: SPEC.key.url,
        keyBlobSha1: SPEC.key.blobSha1,
        keyFingerprint: SPEC.key.fingerprint,
        keyUserIds: imported.userIds,
        signedByFingerprint: signature.fingerprint,
        signedByUserId: signature.userId,
      },
      correspondingSource: {
        ...SPEC.source,
        verified: true,
        bundled: true,
        bundledPath: `${SPEC.source.dir}/${SPEC.source.name}`,
        signature: {
          ...SPEC.source.sig,
          verified: true,
          signedByFingerprint: srcSignature.fingerprint,
          signedByUserId: srcSignature.userId,
        },
      },
      extracted: { fileCount: written.length, totalBytes, files: written.sort((a, b) => a.path.localeCompare(b.path)) },
      rejectedEntries: rejected,
    };
    fs.writeFileSync(path.join(outDir, "VENDOR.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.writeFileSync(
      path.join(outDir, "SOURCE-OFFER.txt"),
      [
        `CyberSafe Assistant — ClamAV ${SPEC.package.version} (${SPEC.package.platform})`,
        "",
        "Este pacote redistribui binários do ClamAV, licenciados sob GPL-2.0-only.",
        `Licença incluída: ${SPEC.package.licenseFile} (e COPYING/ para as bibliotecas embutidas).`,
        "",
        "Correspondente fonte oficial do binário redistribuído (INCLUÍDA no bundle):",
        `  ${SPEC.source.name}`,
        `  ${SPEC.source.url}`,
        `  sha256 ${SPEC.source.sha256}`,
        `  ${SPEC.source.bytes} bytes`,
        `  ficheiro : ${SPEC.source.dir}/${SPEC.source.name}`,
        `  verificação: sha256 fixado + assinatura GPG Talos ${srcSignature.fingerprint}`,
        `  assinatura: ${SPEC.source.dir}/${SPEC.source.sig.name}`,
        "",
        "Origem do binário:",
        `  ${SPEC.archive.name}`,
        `  ${SPEC.archive.url}`,
        `  sha256 ${SPEC.archive.sha256}`,
        "",
        "Assinatura verificada contra a chave pública Talos:",
        `  ${SPEC.key.url}`,
        `  fingerprint ${SPEC.key.fingerprint}`,
        "",
        "Base de assinaturas (CVD/CLD): NÃO incluída — é obtida por freshclam, por utilizador.",
      ].join("\n") + "\n",
      "utf8",
    );

    const previous = fs.existsSync(vendorDir) ? `${vendorDir}.previous-${Date.now()}` : null;
    if (previous) fs.renameSync(vendorDir, previous);
    fs.mkdirSync(path.dirname(vendorDir), { recursive: true });
    fs.renameSync(outDir, vendorDir);
    if (previous) fs.rmSync(previous, { recursive: true, force: true });        process.stdout.write(
      [
        "[vendor-clamav] PUBLICADO",
        `  destino : ${vendorDir}`,
        `  ficheiros: ${written.length} (+2 da fonte correspondente)`,
        `  tamanho : ${totalBytes + srcBytes + srcSigBytes} B (${((totalBytes + srcBytes + srcSigBytes) / 1024 / 1024).toFixed(1)} MiB)`,
        `  versão  : ${versionOutput.trim()}`,
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    cleanup();
  }
}

if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
