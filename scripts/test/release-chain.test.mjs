import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { construirManifesto } from "../release-manifest.mjs";
import { gerarSomas, verificarSomas } from "../release-checksums.mjs";
import {
  buildSignedManifest,
  canonicalManifestBytes,
  fingerprintFromPublicKeyPem,
  normalizeForSigning,
  verifyCanonical,
} from "../release-signing.mjs";

/**
 * Cadeia de publicação, de ponta a ponta, sem o instalador.
 *
 * Cada ferramenta desta linha já tinha testes próprios — o produtor de manifesto
 * (`release-manifest`), as somas (`release-checksums`), a assinatura
 * (`release-signing`) — mas **nenhum teste punha as três a falar entre si**. O
 * `release-signing.test.mjs` assina um manifesto escrito à mão pelo teste; se o
 * produtor começar a emitir um campo que o canónico não espera (ou a omitir um que
 * espera), as suítes continuam verdes e a falha aparece no cliente, depois de o
 * utilizador descarregar o instalador.
 *
 * A chave aqui é **efémera e de ensaio**: serve para provar o caminho do código.
 * Não é, e nunca pode ser, a chave pinada em
 * `packages/desktop/src/updater/release-trust.json` — essa é a decisão #14 do
 * proprietário, e gerar uma chave arbitrária para fazer de conta que está aprovada
 * era exatamente o atalho proibido.
 */

function par() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKey, publicPem };
}

async function artifacto(dir) {
  const ficheiro = path.join(dir, "CyberSafeSetup-0.2.0.exe");
  await fs.writeFile(ficheiro, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2048, 0x41)]));
  return ficheiro;
}

describe("cadeia manifesto → assinatura → somas", () => {
  it("o manifesto do produtor é assinável pelo assinador, sem ajuste manual", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-chain-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const ficheiro = await artifacto(dir);
    const manifesto = await construirManifesto({
      ficheiro,
      url: "https://github.com/exemplo/cybersafe/releases/download/v0.2.0/CyberSafeSetup-0.2.0.exe",
      version: "0.2.0",
      channel: "stable",
      notes: "R7 primeira release.",
      buildId: "r7-20261101",
      sourceCommit: "c0ffee0",
    });
    const { privateKey, publicKey, publicPem } = par();
    const impressão = fingerprintFromPublicKeyPem(publicPem);

    const { signed } = buildSignedManifest(manifesto, privateKey, impressão);

    assert.equal(signed.signature.algorithm, "ed25519");
    assert.equal(signed.signature.signedByFingerprint, impressão);
    assert.equal(verifyCanonical(publicKey, canonicalManifestBytes(signed), signed.signature.value), true,
      "o que o produtor emite não canónica como o assinador espera — é aqui que se vê");
    assert.equal(signed.file.sha256, manifesto.file.sha256, "a assinatura não pode reescrever a promessa");
    assert.equal(signed.file.sizeBytes, manifesto.file.sizeBytes);
    assert.equal(signed.requiresElevation, true, "booleano, não string: o cliente recusa o outro");
  });

  it("as somas e o manifesto concordam sobre o mesmo ficheiro, e a divergência é detetada", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-chain-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const ficheiro = await artifacto(dir);
    const manifesto = await construirManifesto({
      ficheiro,
      url: "https://github.com/exemplo/a/CyberSafeSetup-0.2.0.exe",
      version: "0.2.0",
      channel: "stable",
      notes: "R7.",
    });

    await gerarSomas(dir);
    const antes = await verificarSomas(dir);
    assert.equal(antes.ok, true);
    assert.equal(antes.resultados[0].esperado, manifesto.file.sha256,
      "duas ferramentas mediram o mesmo ficheiro e deram hashes diferentes");

    // O que cada camada prova, dito em asserção: a assinatura autenticia a
    // **promessa** (o manifesto); a soma autenticia a **descarga** (o ficheiro).
    // Trocar um byte do instalador não invalida a assinatura — e é por isso que as
    // duas existem.
    await fs.writeFile(ficheiro, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2048, 0x42)]));
    const depois = await verificarSomas(dir);
    assert.equal(depois.ok, false);
    assert.equal(depois.resultados[0].estado, "divergente");
  });

  it("o campo `notes` multilinha sobrevive ao canónico (não é cortado nem escapado à mistura)", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-chain-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const ficheiro = await artifacto(dir);
    const manifesto = await construirManifesto({
      ficheiro,
      url: "https://github.com/exemplo/a/CyberSafeSetup-0.2.0.exe",
      version: "0.2.0",
      channel: "stable",
      notes: "linha um\nlinha dois\n",
    });
    const canónico = canonicalManifestBytes(manifesto);
    assert.match(canónico, /linha um/);
    assert.match(canónico, /linha dois/);
    const normalizado = normalizeForSigning(manifesto);
    assert.equal(typeof normalizado.publishedAt, "string", "a data tem de entrar no que é assinado");
  });
});
