import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import {
  RAIZ_REPO,
    CAMPOS_CONFIANÇA,
    confiança,
    dePublicaParaFingerprint,
    foraDoRepo,
    gerar,
    validarConfiança,
} from "../release-key-setup.mjs";
import {
  buildSignedManifest,
  canonicalManifestBytes,
  fingerprintFromPublicKeyPem,
  verifyCanonical,
} from "../release-signing.mjs";

/**
 * O procedimento de chaves da D2 tem de ser verificável sem ser executado por
 * ninguém da equipa: o par é do proprietário, a privada nunca entra no repo, e o
 * fingerprint que se pina é derivado da pública — se esse elo estiver errado, o
 * atualizador confia em quem não devia.
 */

const temporários = [];
async function diretório() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-keysetup-"));
  temporários.push(dir);
  return dir;
}
after(async () => {
  for (const dir of temporários) await fs.rm(dir, { recursive: true, force: true });
});

describe("geração e configuração da chave de publicação", () => {
  it("recusa destinos dentro do repo, aceita fora", () => {
    assert.equal(foraDoRepo(path.join(RAIZ_REPO, "packages", "desktop", "chave.pem"), RAIZ_REPO), null,
      "a privada não pode ser escrita dentro do projeto");
    assert.equal(foraDoRepo("packages/desktop/chave.pem", RAIZ_REPO), null, "caminho relativo dentro do repo é recusado");
    assert.ok(foraDoRepo("/tmp/fora/chave.pem", RAIZ_REPO), "fora do repo é aceite");
  });

  it("gera o par, com a privada só legível ao dono e o fingerprint da pública", async () => {
    const dir = await diretório();
    const par = gerar(dir);
    const modo = (await fs.stat(par.privado)).mode & 0o777;
    if (process.platform === "win32") {
      // O teste afirma o que é verdade nesta plataforma em vez de fingir que o
      // modo POSIX se aplica: aqui a confidencialidade vem de ACL, e o aviso é
      // obrigatório precisamente para isso não se perder de vista.
      assert.equal(modo, 0o666, `NTFS costuma reportar ${modo.toString(8)}`);
      assert.match(String(par.aviso), /ACL|icacls/, "sem aviso, a ferramenta estaria a prometer 0600 que não entrega");
    } else {
      assert.equal(modo, 0o600, `privada com modo ${modo.toString(8)}; tinha de ser 0600`);
    }
    assert.ok(par.privado.startsWith(dir) && !par.privado.startsWith(RAIZ_REPO));

    const pública = await fs.readFile(par.público, "utf8");
    assert.equal(dePublicaParaFingerprint(pública), par.fingerprint, "o fingerprint publicado não deriva da pública entregue");
    assert.equal(par.fingerprint, fingerprintFromPublicKeyPem(pública),
      "o fingerprint do gerador diverge do que o assinador usa — o pin não bateria");
  });

  it("não sobrescreve um par existente sem --force", async () => {
    const dir = await diretório();
    const primeiro = gerar(dir);
    assert.throws(() => gerar(dir), /já existe um par/);
    const segundo = gerar(dir, { force: true });
    assert.notEqual(segundo.fingerprint, primeiro.fingerprint, "--force gera um par novo, e isso invalida o que foi assinado antes");
  });

  it("o bloco de pin tem os campos que o cliente lê, e vem desligado", async () => {
    const dir = await diretório();
    const par = gerar(dir);
    const pública = await fs.readFile(par.público, "utf8");
    const config = confiança(pública, par.fingerprint);
    assert.equal(config.enabled, false, "gerar a chave não liga o atualizador: isso é decisão e precisa release existente");
    assert.equal(config.publicKeyPem, pública);
    assert.equal(config.pinnedKeyFingerprint, par.fingerprint);
    assert.deepEqual(validarConfiança(config), [], `bloco impresso pela ferramenta não validaria no cliente: ${JSON.stringify(validarConfiança(config))}`);

    // A lista de campos não é minha: é o que `production.ts` lê do JSON. Foi
    // exatamente aqui que a ferramenta errou uma primeira vez — emitia
    // `{fingerprint, algorithm}` enquanto o cliente pede `pinnedKeyFingerprint`,
    // e o resultado era um `release-trust.json` colado à letra mas `unconfigured`.
    const origem = await fs.readFile(
      path.join(RAIZ_REPO, "packages", "desktop", "src", "updater", "production.ts"), "utf8");
    // `trust.json` aparece no import `from './release-trust.json'` e não é um
    // campo lido; o resto são todos acessos reais do objeto.
    const lidos = [...new Set([...origem.matchAll(/\btrust\.([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((m) => m[1]).filter((campo) => campo !== "json"))];
    assert.ok(lidos.length >= 4, `produção.ts deveria ler vários campos do ficheiro, li ${lidos.length}`);
    for (const campo of lidos) {
      assert.ok(campo in config, `o cliente lê trust.${campo} e o bloco emitido não o tem`);
    }
    assert.deepEqual(CAMPOS_CONFIANÇA.slice().sort(), lidos.slice().sort(),
      "CAMPOS_CONFIANÇA divergiu do que production.ts lê — a lista tem de ser reancorada no consumidor");
  });

  it("recusa blocos que o cliente chumaria, em vez de os imprimir", async () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAxQ\n-----END PUBLIC KEY-----\n";
    const base = {
      enabled: false, publicKeyPem: pem, pinnedKeyFingerprint: "a".repeat(64),
      publisherLabel: "CyberSafe", reason: "x",
    };
    assert.deepEqual(validarConfiança({ ...base, feedManifestUrl: "https://github.com/o/e/releases/latest/download/update-manifest.json" }), []);
    assert.ok(validarConfiança({ ...base, feedManifestUrl: "" }).length > 0, "feed vazio é configured-out, não é omissão");
    assert.ok(validarConfiança({ ...base, feedManifestUrl: "http://github.com/o/e/releases/latest/download/m.json" })
      .some((p) => /https/.test(p)), "feed não-https tem de ser nomeado");
    assert.ok(validarConfiança({ ...base, feedManifestUrl: "https://github.com/o/e/releases/download/v1/outro-ficheiro.exe" })
      .some((p) => /download de release/.test(p)), "URL de release que não é um manifesto tem de ser recusado");
    assert.ok(validarConfiança({ ...base, feedManifestUrl: "https://exemplo.com/m.json" })
      .some((p) => /github\.com/.test(p)), "origem fora de github.com não é canal de confiança do cliente");
    assert.ok(validarConfiança({ ...base, pinnedKeyFingerprint: "abc" })
      .some((p) => /64 hex/.test(p)));
    assert.ok(validarConfiança({ ...base, publicKeyPem: "nada" })
      .some((p) => /SPKI/.test(p)));
    assert.ok(validarConfiança({ ...base, publisherLabel: "  " })
      .some((p) => /publisherLabel/.test(p)), "sem editor o config fica unconfigured — a ferramenta diz porquê");
    assert.throws(() => confiança(pem, "abc"), /bloco incompleto/,
      "a ferramenta não imprime um bloco que o cliente chumaria");
  });

  it("um manifesto assinado com esta chave é verificado pela pública correspondente", async () => {
    const dir = await diretório();
    const par = gerar(dir);
    const privada = createPrivateKey(await fs.readFile(par.privado, "utf8"));
    const pública = createPublicKey(await fs.readFile(par.público, "utf8"));
    const manifesto = {
      schema: "cybersafe.release-manifest/1",
      channel: "stable",
      version: "0.2.0",
      publishedAt: "2026-11-01T00:00:00.000Z",
      notes: "candidata R7",
      file: { url: "https://example.invalid/CyberSafeSetup.exe", sha256: "a".repeat(64), sizeBytes: 1 },
      publisher: { name: "CyberSafe" },
      requiresElevation: true,
    };
    const { signed } = buildSignedManifest(manifesto, privada, par.fingerprint);
    assert.equal(signed.signature.signedByFingerprint, par.fingerprint);
    assert.equal(verifyCanonical(pública, canonicalManifestBytes(signed), signed.signature.value), true,
      "a chave que o procedimento gera não assina o que o cliente verifica");
  });
});
