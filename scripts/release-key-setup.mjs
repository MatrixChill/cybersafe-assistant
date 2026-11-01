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
 *    ao repositório — e mesmo essa entra como *conteúdo a copiar*, não como commit;
 *  - imprime o fingerprint SHA-256 do DER da pública, que é o valor que
 *    `release-trust.json` compara, e o JSON pronto a colar;
 *  - `--verify` confirma que um par que já existe corresponde ao fingerprint
 *    publicado, sem imprimir a privada;
 *  - nada aqui assina nem publica uma release, e nada aqui aceita uma chave
 *    arbitrária como canal de confiança: é ferramenta, não aprovação.
 *
 * Uso:
 *   node scripts/release-key-setup.mjs --generate --dir <fora-do-repo> [--force]
 *   node scripts/release-key-setup.mjs --verify --public <pub.pem> --fingerprint <fp>
 *   node scripts/release-key-setup.mjs --fingerprint --public <pub.pem>
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
 * Uma única derivacão de fingerprint no projeto: a do assinador. Ter uma segunda
 * cópia «igual» é como o pin divergir em maiúsculas — o gerador dava hex
 * minúsculo, o cliente compara com o formato do `release-signing.mjs`, e o
 * fingerprint que se pina não bateria com o que se assina.
 */
export const dePublicaParaFingerprint = fingerprintFromPublicKeyPem;

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

export function confiança(pemPúblico, fingerprint, { enabled = false } = {}) {
  return {
    schema: 1,
    enabled,
    algorithm: "ed25519",
    publicKeyPem: pemPúblico,
    fingerprint,
    note: "Copiar para packages/desktop/src/updater/release-trust.json. A chave privada fica fora do repo; `enabled:true` só faz sentido depois de a release existir.",
  };
}

function parseArgs(argv) {
  const opções = { modo: null, dir: null, public: null, fingerprint: null, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--generate") opções.modo = "generate";
    else if (arg === "--verify") opções.modo = "verify";
    else if (arg === "--fingerprint") opções.modo = "fingerprint";
    else if (arg === "--force") opções.force = true;
    else if (arg === "--dir" || arg === "--public" || arg === "--fingerprint-value") {
      const chave = arg === "--public" ? "public" : arg === "--dir" ? "dir" : "fingerprint";
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
      process.stdout.write("uso: --generate --dir <fora-do-repo> [--force] | --verify --public <pub.pem> --fingerprint <fp> | --fingerprint --public <pub.pem>\n");
      return 2;
    }
    if (opções.modo === "generate") {
      if (!opções.dir) throw new Error("--generate exige --dir");
      const destino = foraDoRepo(opções.dir);
      if (destino === null) throw new Error("--dir tem de ficar FORA da raiz do projeto (a chave privada não entra no repo nem no instalador)");
      fs.mkdirSync(destino, { recursive: true });
      const par = gerar(destino, { force: opções.force });
      const pem = fs.readFileSync(par.público, "utf8");
      process.stdout.write(`gerado:\n  privada (0600, nunca commitar): ${par.privado}\n  pública:                    ${par.público}\n  fingerprint:                ${par.fingerprint}\n`
        + (par.aviso ? `  AVISO: ${par.aviso}\n` : "")
        + `\n`
        + `pinar no release-trust.json:\n${JSON.stringify(confiança(pem, par.fingerprint), null, 2)}\n\n`
        + `e assinar um manifesto assim:\n  node scripts/release-signing.mjs --sign-manifest <manifesto.json> --key ${par.privado} --fingerprint ${par.fingerprint} --out <assinado.json>\n`);
      return 0;
    }
    if (!opções.public) throw new Error(`${opções.modo} exige --public`);
    const pem = fs.readFileSync(opções.public, "utf8");
    const obtido = dePublicaParaFingerprint(pem);
    if (opções.modo === "fingerprint") {
      process.stdout.write(`${obtido}\n`);
      return 0;
    }
    if (!opções.fingerprint) throw new Error("--verify exige --fingerprint");
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
