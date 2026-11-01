import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefinitionUpdater } from "../dist/updater.js";

/**
 * Transação YARA do updater (TP-HUMAN-YARA-NEXT).
 *
 * O corpus instalado é servido por este caminho. Estes testes usam um diretório
 * temporário e um transporte falso: nunca tocam `~/.cyberservice`, nunca fazem
 * rede e nunca executam ClamAV/hashes.
 *
 * Contrato verificado:
 *  - candidato vazio/inválido NÃO substitui o corpus anterior;
 *  - o erro de cada fonte chega a `UpdateResult.errors` (o `definitions.update`
 *    publica esse resultado no evento `engine.health`);
 *  - quando há fontes válidas, o corpus é substituído e a fonte que falhou
 *    continua reportada — sem esconder a falha parcial atrás de `yaraUpdated`.
 */

const SOURCE_NAMES = [
  "MALW_Eicar.yar",
  "packer_compiler_signatures.yar",
  "crypto_signatures.yar",
  "RANSOM_MS17-010_Wannacrypt.yar",
];

/* Desde a decisão D4 o updater só aceita uma fonte cujo conteúdo corresponda ao
   SHA-256 pinado no commit. Estes casos são a transacção YARA, não a verificação
   do pin (essa tem ficheiro próprio): por isso o fixture pinia o conteúdo que ele
   próprio serve, e o que continua a ser exercitado é «inválido não substitui o
   corpus». A função abaixo é só isso — o digest do que o mock devolve. */
const ARQUIVOS = {
  "MALW_Eicar.yar": "malware/MALW_Eicar.yar",
  "packer_compiler_signatures.yar": "packers/packer_compiler_signatures.yar",
  "crypto_signatures.yar": "crypto/crypto_signatures.yar",
  "RANSOM_MS17-010_Wannacrypt.yar": "malware/RANSOM_MS17-010_Wannacrypt.yar",
};
const CLASSES = {
  "MALW_Eicar.yar": "test",
  "packer_compiler_signatures.yar": "reference",
  "crypto_signatures.yar": "reference",
  "RANSOM_MS17-010_Wannacrypt.yar": "production",
};
const REVISÃO_FIXTURE = "0".repeat(40);

function pinDe(conteúdos) {
  return SOURCE_NAMES.map((nome) => ({
    id: nome,
    repo: "fixture/yara",
    file: ARQUIVOS[nome],
    revision: REVISÃO_FIXTURE,
    sha256: createHash("sha256").update(conteúdos.get(nome) ?? "", "utf8").digest("hex"),
    ruleClass: CLASSES[nome],
  }));
}

async function makeUpdater(conteúdos = new Map()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-human-yara-update-"));
  const yaraDir = path.join(dir, "yara");
  await fs.mkdir(yaraDir, { recursive: true });
  const corpusPath = path.join(yaraDir, "default.yar");
  const previous = "rule previous_corpus { condition: filesize > 0 }\n";
  await fs.writeFile(corpusPath, previous, "utf-8");

  const updater = new DefinitionUpdater(dir, { yaraPin: pinDe(conteúdos) });
  // Sem ClamAV/hashes reais: este lote é só a transação YARA.
  updater.updateClamAV = async () => {
    throw new Error("freshclam disabled in isolated test");
  };
  updater.updateHashFeed = async () => {
    throw new Error("hash feed disabled in isolated test");
  };
  return { dir, yaraDir, corpusPath, previous, updater };
}

async function readCorpus(corpusPath) {
  return fs.readFile(corpusPath, "utf-8");
}

describe("transação YARA — corpus anterior preservado quando não há candidato válido", () => {
  it("todas as fontes vazias: mantém o corpus, yaraUpdated=false e reporta o detalhe", async () => {
    const { yaraDir, corpusPath, previous, updater } = await makeUpdater();
    updater.downloadText = async (url) => {
      assert.ok(SOURCE_NAMES.some((name) => url.endsWith(name)), `fonte inesperada: ${url}`);
      return "";
    };

    try {
      const result = await updater.checkAndUpdate(true);

      assert.equal(result.yaraUpdated, false);
      assert.equal(await readCorpus(corpusPath), previous, "o corpus anterior não pode ser substituído");
      assert.deepEqual(await fs.readdir(yaraDir), ["default.yar"], "não podem ficar ficheiros temporários");
      for (const name of SOURCE_NAMES) {
        assert.ok(
          result.errors.some((error) => error.includes(name)),
          `o erro de ${name} tem de chegar ao resultado`,
        );
      }
    } finally {
      await fs.rm(dir_of(corpusPath), { recursive: true, force: true });
    }
  });

  it("todas as fontes inválidas (HTML/incompletas): mantém o corpus e reporta cada fonte", async () => {
    const servido = new Map([
      ["MALW_Eicar.yar", "<!DOCTYPE html><html>404</html>"],
      ["packer_compiler_signatures.yar", "texto sem regras"],
      ["crypto_signatures.yar", "texto sem regras"],
      ["RANSOM_MS17-010_Wannacrypt.yar", "texto sem regras"],
    ]);
    const { corpusPath, previous, updater } = await makeUpdater(servido);
    updater.downloadText = async (url) => {
      const nome = SOURCE_NAMES.find((candidato) => url.endsWith(candidato));
      return servido.get(nome);
    };

    try {
      const result = await updater.checkAndUpdate(true);

      assert.equal(result.yaraUpdated, false);
      assert.equal(await readCorpus(corpusPath), previous);
      assert.ok(result.errors.some((error) => error.includes("não parece ser YARA válido")));
      assert.ok(result.errors.filter((error) => error.startsWith("YARA source:")).length >= 4);
    } finally {
      await fs.rm(dir_of(corpusPath), { recursive: true, force: true });
    }
  });
});

describe("transação YARA — sucesso parcial publica o válido e não esconde a falha", () => {
  it("reference com 404 não impede production/test; reference válida fica fora do corpus", async () => {
    const valid = new Map([
      ["MALW_Eicar.yar", "rule source_eicar { condition: true }\n"],
      ["packer_compiler_signatures.yar", "rule source_packer { condition: true }\n"],
      ["crypto_signatures.yar", "rule source_crypto { condition: true }\n"],
      ["RANSOM_MS17-010_Wannacrypt.yar", "rule source_ransomware { condition: true }\n"],
    ]);
    const { corpusPath, updater } = await makeUpdater(valid);
    updater.downloadText = async (url) => {
      const name = SOURCE_NAMES.find((candidate) => url.endsWith(candidate));
      assert.ok(name, `fonte inesperada: ${url}`);
      if (name === "packer_compiler_signatures.yar") {
        throw new Error("HTTP 404 ao baixar fonte YARA.");
      }
      return valid.get(name);
    };

    try {
      const result = await updater.checkAndUpdate(true);

      assert.equal(result.yaraUpdated, true);
      const corpus = await readCorpus(corpusPath);
      for (const name of ["MALW_Eicar.yar", "RANSOM_MS17-010_Wannacrypt.yar"]) {
        assert.ok(corpus.includes(valid.get(name).trim()), `o corpus publicado tem de conter ${name}`);
      }
      assert.ok(!corpus.includes("source_packer"), "reference não entra no corpus de ameaça");
      assert.ok(!corpus.includes("source_crypto"), "reference não entra no corpus de ameaça");
      assert.ok(!corpus.includes("previous_corpus"), "o corpus anterior foi substituído por production/test válidos");
      assert.ok(
        result.errors.some((error) => error.includes("packer_compiler_signatures.yar") && error.includes("404")),
        "a fonte reference que falhou continua reportada apesar de yaraUpdated=true",
      );
    } finally {
      await fs.rm(dir_of(corpusPath), { recursive: true, force: true });
    }
  });
});

function dir_of(corpusPath) {
  return path.dirname(path.dirname(corpusPath));
}
