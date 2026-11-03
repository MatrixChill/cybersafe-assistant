#!/usr/bin/env node
/**
 * Produz o `update-manifest.json` que o updater da aplicação consome.
 *
 * Porque isto existe: o updater **valida e consome** o manifesto (schema, canal,
 * versão, `file.url`/`sha256`/`sizeBytes`, assinatura, compatibilidade) mas não
 * havia **nenhum produtor** no repo. Sem produtor, o manifesto é escrito à mão e
 * um `sizeBytes` copiado errado é apanhado pelo cliente como «ficheiro corrompido»
 * — ou pior: passa porque ninguém o conferiu. Aqui o hash e o tamanho vêm do
 * ficheiro real, medidos em fluxo.
 *
 * O que este script **não** faz: assinar. A assinatura é `--sign-manifest` de
 * `release-signing.mjs` e exige a chave pública do proprietário (task #14) — o
 * output é deliberadamente um manifesto **sem** `signature`, e o script di-lo.
 *
 * Uso:
 *   node scripts/release-manifest.mjs --file <instalador.exe> --url <https://…> \
 *        --version 0.2.0 --channel stable --notes <texto|caminho> [--out update-manifest.json] \
 *        [--build-id …] [--source-commit …] [--publisher "CyberSafe"] \
 *        [--requires-elevation] [--min-windows-build 19041] [--from-version 0.1.11]
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { sha256Ficheiro } from "./release-checksums.mjs";

const SCHEMA = "cybersafe.release-manifest/1";
const VERSÃO = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/* O único canal que o cliente sabe ler. `packages/desktop/src/updater/types.ts:16`
   é `UpdateChannel = "stable"` e `release-signing.mjs:68` recusa outro — emitir
   `beta`/`internal` seria produzir um manifesto que o assinador ou o cliente
   chumbam. Uma candidata interna não tem manifesto: o atualizador está
   desligado (decisão D2) e não há nada a prometer a quem ainda não tem release. */
const CANAIS = ["stable"];

/** O contrato do cliente (`packages/desktop/src/updater/types.ts:120`). */
export async function construirManifesto(opções) {
  const {
    ficheiro, url, version, channel, notes,
    buildId = null, sourceCommit = null, publisher = "CyberSafe",
    requiresElevation = true, minWindowsBuild = null, fromVersion = null,
    agora = new Date().toISOString(),
  } = opções;

  if (!ficheiro) throw new Error("falta --file (o instalador cujo hash se publica)");
  if (!CANAIS.includes(channel)) throw new Error(`canal inválido «${channel}»: um de ${CANAIS.join(", ")}`);
  if (!VERSÃO.test(version ?? "")) throw new Error(`versão «${version}» não é SemVer x.y.z[-pré][+build]`);
  // A armadilha medida em #16: o `isUpgrade` do próprio updater trata
  // «0.1.11-internal.pap-r7» como atualização de «0.1.11». Publicar uma string
  // dessas em canal estável é pedir um cliente que se acha atualizado contra
  // algo que nunca foi estável.
  if (channel === "stable" && version.includes("-")) {
    throw new Error(`versão pré-liberta «${version}» não pode ser publicada como stable — decisão #16`);
  }

  let estatuto;
  try {
    estatuto = await fs.stat(ficheiro);
  } catch {
    throw new Error(`ficheiro não legível: ${ficheiro}`);
  }
  if (!estatuto.isFile()) throw new Error(`${ficheiro} não é um ficheiro regular`);

  const https = (() => { try { return new URL(url); } catch { return null; } })();
  if (!https || https.protocol !== "https:" || https.username || https.password) {
    throw new Error("o `url` do manifesto tem de ser HTTPS sem credenciais (mesma regra do transporte)");
  }

  let notas = notes ?? "";
  if (notas && (await fs.stat(notas).catch(() => null))?.isFile()) notas = await fs.readFile(notas, "utf8");
  notas = String(notas).replace(/\r\n/g, "\n").trim();
  if (!notas) throw new Error("faltam notas (--notes texto ou ficheiro): um utilizador tem de ler o que muda");

  const manifesto = {
    schema: SCHEMA,
    channel,
    version,
    publishedAt: agora,
    notes: notas,
    file: {
      url: https.toString(),
      sha256: await sha256Ficheiro(ficheiro),
      sizeBytes: estatuto.size,
    },
    publisher: { name: publisher },
    requiresElevation,
  };
  if (buildId) manifesto.buildId = String(buildId);
  if (sourceCommit) manifesto.sourceCommit = String(sourceCommit);
  if (minWindowsBuild !== null || fromVersion !== null) {
    manifesto.compatibility = {
      minWindowsBuild: minWindowsBuild === null ? null : Number(minWindowsBuild),
      fromVersion: fromVersion === null ? null : String(fromVersion),
    };
  }
  return manifesto;
}

function parseArgs(argv) {
  const opções = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--requires-elevation") { opções.requiresElevation = true; continue; }
    const chave = {
      "--file": "ficheiro", "--url": "url", "--version": "version", "--channel": "channel",
      "--notes": "notes", "--out": "out", "--build-id": "buildId", "--source-commit": "sourceCommit",
      "--publisher": "publisher", "--min-windows-build": "minWindowsBuild", "--from-version": "fromVersion",
    }[flag];
    if (!chave) throw new Error(`argumento desconhecido: ${flag}`);
    opções[chave] = argv[++i];
    if (opções[chave] === undefined) throw new Error(`${flag} exige valor`);
  }
  return opções;
}

async function main(argv) {
  try {
    const opções = parseArgs(argv);
    const manifesto = await construirManifesto(opções);
    const saida = opções.out ?? "update-manifest.json";
    await fs.writeFile(saida, `${JSON.stringify(manifesto, null, 2)}\n`, "utf8");
    process.stdout.write(
      `manifesto escrito em ${path.resolve(saida)} — ${manifesto.version} (${manifesto.channel}), `
      + `${manifesto.file.sizeBytes} bytes, sha256 ${manifesto.file.sha256.slice(0, 12)}…\n`
      + "SEM ASSINATURA: falta a chave pública do proprietário (#14); "
      + "assinar depois com `node scripts/release-signing.mjs --sign-manifest …`.\n",
    );
    return 0;
  } catch (erro) {
    process.stderr.write(`release-manifest: ${erro.message}\n`);
    return 1;
  }
}

const argv0 = process.argv[1];
if (argv0 && path.resolve(argv0) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
