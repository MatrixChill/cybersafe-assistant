#!/usr/bin/env node
/**
 * Geração e configuração da chave Ed25519 de publicação (decisão D2 do
 * proprietário: o procedimento é seu, a chave nunca é minha).
 *
 * O que existe hoje e não é suficiente como processo: `release-trust.json` com
 * `enabled:false` e PEM vazio (falha fechada), e `release-signing.mjs` que assina
 * e verifica desde ficheiros. Faltava o passo humano-controlled: gerar o par,
 * ficar com a privada **fora** do repo, e saber exatamente o que pinar.
 *
 * Regras que este script impõe, porque a consequência de as errar é publicar um
 * atualizador que confia em quem não devia:
 *  - recusa escrever seja que for dentro da raiz do projeto (a privada não entra
 *    no repo nem no instalador, nem por acidente com um `--out` relativo);
 *  - a privada é escrita com modo `0600` e a pública é o único ficheiro destinada
 *    ao repositório — e mesmo essa entra como *conteúdo a colar*, não como commit;
 *  - `--trust` imprime o bloco `release-trust.json` **com os campos que o cliente
 *    lê** (`feedManifestUrl`, `pinnedKeyFingerprint`, `publisherLabel`), validado
 *    antes de ser mostrado, e sempre com `enabled:false`;
 *  - `--verify` confirma que um par que já existe corresponde ao fingerprint
 *    publicado, sem imprimir a privada;
 *  - nada aqui assina nem publica uma release, e nada aqui aceita uma chave
 *    arbitrária como canal de confiança: é ferramenta, não aprovação.
 *
 * Uso:
 *   node scripts/release-key-setup.mjs --generate --dir <fora-do-repo> [--force]
 *   node scripts/release-key-setup.mjs --fingerprint --public <pub.pem>
 *   node scripts/release-key-setup.mjs --verify --public <pub.pem> --expect <fp>
 *   node scripts/release-key-setup.mjs --trust --public <pub.pem>
 */
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fingerprintFromPublicKeyPem } from "./release-signing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ_REPO = path.resolve(HERE, "..");

/**
 * Uma única derivação de fingerprint no projeto: a do assinador. Ter uma segunda
 * cópia «igual» é como o pin divergir em maiúsculas — o gerador dava hex
 * minúsculo, o cliente compara com o formato do `release-signing.mjs`, e o
 * fingerprint que se pina não bateria com o que se assina.
 */
export const dePublicaParaFingerprint = fingerprintFromPublicKeyPem;

/** Ficheiro que o cliente lê: `packages/desktop/src/updater/production.ts:1`. */
export const FICHEIRO_CONFIANÇA = path.join(
  RAIZ_REPO, "packages", "desktop", "src", "updater", "release-trust.json",
);

/** O que o consumidor lê hoje — a fonte desta lista é `production.ts`, não eu. */
function lerConfiançaAtual() {
  try {
    return JSON.parse(fs.readFileSync(FICHEIRO_CONFIANÇA, "utf8"));
  } catch {
    return null;
  }
}

/**
 * O bloco que se cola no repo tem de ser lido por quem o consome. Emitir
 * `{fingerprint, algorithm}` — que é o que esta ferramenta fazia — daria um
 * `release-trust.json` com `pinnedKeyFingerprint` vazio, e o cliente ficaria em
 * `missing-pinned-key` para sempre com a ferramenta a dizer que tinha gerado
 * tudo. As origens por omissão vêm do próprio ficheiro do repo, para a ferramenta
 * não inventar nem feed nem editor.
 */
export function confiança(pemPúblico, fingerprint, opções = {}) {
  const atual = lerConfiançaAtual();
  const bloco = {
    enabled: opções.enabled === true,
    feedManifestUrl: opções.feed ?? atual?.feedManifestUrl ?? "",
    publicKeyPem: pemPúblico,
    pinnedKeyFingerprint: fingerprint,
    publisherLabel: opções.publisher ?? atual?.publisherLabel ?? "",
    reason: opções.reason
      ?? "Chave gerada por release-key-setup.mjs; a privada fica fora do repo. `enabled:true` só depois de a release existir.",
  };
  const problemas = validarConfiança(bloco);
  if (problemas.length > 0) throw new Error(`bloco incompleto: ${problemas.join("; ")}`);
  return bloco;
}

/**
 * O mínimo que `production.ts`/`config.ts` exigem para não ficar `unconfigured`.
 * A lista é o que `packages/desktop/src/updater/production.ts` lê como
 * `trust.<campo>` — `reason` não está aqui porque não é lido por ninguém: é
 * contexto para quem abre o ficheiro.
 */
export const CAMPOS_CONFIANÇA = [
  "enabled", "feedManifestUrl", "publicKeyPem", "pinnedKeyFingerprint", "publisherLabel",
];

export function validarConfiança(bloco) {
  const problemas = [];
  const faltantes = CAMPOS_CONFIANÇA.filter((campo) => !(campo in bloco));
  if (faltantes.length > 0) problemas.push(`campos que o cliente lê em falta: ${faltantes.join(",")}`);
  if (!/^[0-9a-fA-F]{64}$/.test(String(bloco.pinnedKeyFingerprint ?? ""))) {
    problemas.push("pinnedKeyFingerprint não é um SHA-256 de 64 hex");
  }
  if (!String(bloco.publicKeyPem ?? "").includes("BEGIN PUBLIC KEY")) {
    problemas.push("publicKeyPem não é uma pública SPKI em PEM");
  }
  let origem = null;
  try {
    const url = new URL(bloco.feedManifestUrl);
    if (url.protocol !== "https:") problemas.push("feedManifestUrl não é https");
    if (url.username || url.password) problemas.push("feedManifestUrl tem credenciais");
    origem = url.host.toLowerCase();
    if (!/(^|\.)github\.com$/.test(origem)) problemas.push(`origem do feed fora de github.com: ${origem}`);
    if (!/\/releases\/(latest\/download\/|[^/]+\/download\/)/.test(url.pathname)) {
      problemas.push("feedManifestUrl não é um caminho de download de release");
    }
  } catch {
    problemas.push("feedManifestUrl ilegível (vazio ou não URL)");
  }
  if (!String(bloco.publisherLabel ?? "").trim()) problemas.push("publisherLabel vazio");
  return problemas;
}

/** Recusa destinos dentro do repo — com explicação, não com um stack trace. */
export function foraDoRepo(caminho, raiz = RAIZ_REPO) {
  const absoluto = path.resolve(raiz, caminho);
  const relativo = path.relative(path.resolve(raiz), absoluto);
  return relativo !== "" && !relativo.startsWith("..") && !path.isAbsolute(relativo) ? null : absoluto;
}

export function gerar(dir, { force = false } = {}) {
  const privado = path.join(dir, "cybersafe-publish-ed25519.pem");
  const público = path.join(dir, "cybersafe-publish-ed25519.pub.pem");
  if (!force && (fs.existsSync(privado) || fs.existsSync(público))) {
    throw new Error("já existe um par neste diretório; usar --force sobrescreve e INVALIDA a assinatura do que foi publicado antes");
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pemPrivado = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pemPúblico = publicKey.export({ type: "spki", format: "pem" }).toString();
  fs.writeFileSync(privado, pemPrivado, { mode: 0o600 });
  fs.writeFileSync(público, pemPúblico, { mode: 0o644 });
  return {
    privado,
    público,
    fingerprint: dePublicaParaFingerprint(pemPúblico),
    /* Em Windows o `mode` POSIX não é aplicado (o ficheiro fica 0666), e dizer o
       contrário seria uma falsa garantia de confidencialidade. O aviso vai no
       resultado e no output: a proteção real da privada é ACL/volume cifrado. */
    aviso: process.platform === "win32"
      ? "o modo 0600 não é aplicado em NTFS por Node; proteger a privada exige ACL restrita (icacls) ou volume cifrado"
      : null,
  };
}

function parseArgs(argv) {
  const opções = {
    modo: null, dir: null, public: null, fingerprint: null,
    feed: null, publisher: null, force: false,
  };
  const VALORES = new Map([
    ["--dir", "dir"], ["--public", "public"], ["--expect", "fingerprint"],
    ["--feed", "feed"], ["--publisher", "publisher"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--generate") opções.modo = "generate";
    else if (arg === "--verify") opções.modo = "verify";
    else if (arg === "--trust") opções.modo = "trust";
    else if (arg === "--fingerprint") opções.modo = "fingerprint";
    else if (arg === "--force") opções.force = true;
    else if (VALORES.has(arg)) {
      const chave = VALORES.get(arg);
      opções[chave] = argv[++i];
      if (opções[chave] === undefined) throw new Error(`${arg} exige valor`);
    } else throw new Error(`argumento desconhecido: ${arg}`);
  }
  return opções;
}

function main(argv) {
  try {
    const opções = parseArgs(argv);
    if (!opções.modo) {
      process.stdout.write(
        "uso:\n"
        + "  --generate --dir <fora-do-repo> [--force]\n"
        + "  --fingerprint --public <pub.pem>\n"
        + "  --verify --public <pub.pem> --expect <fingerprint>\n"
        + "  --trust --public <pub.pem> [--feed <url>] [--publisher <nome>]\n"
        + "(--trust imprime o bloco release-trust.json validado; nunca escreve no repo)\n");
      return 2;
    }
    if (opções.modo === "generate") {
      if (!opções.dir) throw new Error("--generate exige --dir");
      const destino = foraDoRepo(opções.dir);
      if (destino === null) throw new Error("--dir tem de ficar FORA da raiz do projeto (a chave privada não entra no repo nem no instalador)");
      fs.mkdirSync(destino, { recursive: true });
      const par = gerar(destino, { force: opções.force });
      const pem = fs.readFileSync(par.público, "utf8");
      const bloco = confiança(pem, par.fingerprint, { feed: opções.feed, publisher: opções.publisher });
      process.stdout.write(`gerado:\n  privada (0600, nunca commitar): ${par.privado}\n  pública:                    ${par.público}\n  fingerprint:                ${par.fingerprint}\n`
        + (par.aviso ? `  AVISO: ${par.aviso}\n` : "")
        + `\n`
        + `bloco para ${path.relative(RAIZ_REPO, FICHEIRO_CONFIANÇA)} (desligado por omissão):\n${JSON.stringify(bloco, null, 2)}\n\n`
        + `e assinar um manifesto assim:\n  node scripts/release-signing.mjs --sign-manifest <manifesto.json> --key ${par.privado} --fingerprint ${par.fingerprint} --out <assinado.json>\n`
        + `e confirmar o pin depois:\n  node scripts/release-key-setup.mjs --verify --public ${par.público} --expect ${par.fingerprint}\n`);
      return 0;
    }
    if (!opções.public) throw new Error(`${opções.modo} exige --public`);
    const pem = fs.readFileSync(opções.public, "utf8");
    const obtido = dePublicaParaFingerprint(pem);
    if (opções.modo === "fingerprint") {
      process.stdout.write(`${obtido}\n`);
      return 0;
    }
    if (opções.modo === "trust") {
      const bloco = confiança(pem, obtido, { feed: opções.feed, publisher: opções.publisher });
      process.stdout.write(`${JSON.stringify(bloco, null, 2)}\n`);
      return 0;
    }
    if (!opções.fingerprint) throw new Error("--verify exige --expect");
    const bate = obtido.toLowerCase() === String(opções.fingerprint).trim().toLowerCase();
    process.stdout.write(`${bate ? "OK  " : "FALHA"} fingerprint ${obtido.slice(0, 16)}… ${bate ? "=" : "≠"} ${opções.fingerprint.slice(0, 16)}…\n`);
    return bate ? 0 : 1;
  } catch (erro) {
    process.stderr.write(`release-key-setup: ${erro.message}\n`);
    return 1;
  }
}

const argv0 = process.argv[1];
if (argv0 && path.resolve(argv0) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
