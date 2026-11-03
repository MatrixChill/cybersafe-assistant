import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DefinitionUpdater, YARA_PIN } from "../dist/updater.js";
import { countReportableYaraRules, YaraEngine } from "@cybersafe/core";

/**
 * PROVENIÊNCIA PUBLICADA — o updater regista o que carregou, e o arranque
 * consegue recuperar de um corpus só de teste sem esperar 6 horas.
 *
 * Nenhum teste toca na rede: o transporte (`downloadText`) é substituído.
 * Nenhum teste toca em ClamAV, hashes, proteção real ou na instalação do
 * utilizador.
 */

const SOURCES = [
  "MALW_Eicar.yar",
  "packer_compiler_signatures.yar",
  "crypto_signatures.yar",
  "RANSOM_MS17-010_Wannacrypt.yar",
];

// Regras sintéticas com conteúdo próprio: um `filesize > 0` dispararia no
// ficheiro benigno e o teste negativo passaria a provar o contrário do que diz.
const EICAR_RULE = 'rule eicar_test { strings: $a = "CYBERSAFE_SYNTH_EICAR_NEEDLE" condition: $a }\n';
const PACKER_RULE = 'rule packer_test { strings: $a = "CYBERSAFE_SYNTH_PACKER_NEEDLE" condition: $a }\n';
const CRYPTO_RULE = 'rule crypto_test { strings: $a = "CYBERSAFE_SYNTH_CRYPTO_NEEDLE" condition: $a }\n';
const RANSOM_RULE = 'rule ransom_test { strings: $a = "CYBERSAFE_SYNTH_RANSOM_NEEDLE" condition: $a }\n';
const REFERENCE_PE_RULE = "rule IsPE64 { condition: true }\n";
const REFERENCE_CRYPTO_RULE = "rule RijnDael_AES { condition: true }\n";
const COUNT_RULES = [
  "rule top { condition: true }",
  " rule indented { condition: true }",
  "private rule helper { condition: true }",
  "global rule global_rule { condition: true }",
].join("\n") + "\n";

const sha256 = (text) => createHash("sha256").update(text, "utf-8").digest("hex");

async function makeUpdater() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-yara-provenance-"));
  await fs.mkdir(path.join(dir, "yara"), { recursive: true });
  const corpusPath = path.join(dir, "yara", "default.yar");
  await fs.writeFile(corpusPath, "// cybersafe-fallback-canary\nrule eicar { condition: filesize > 0 }\n", "utf-8");
  const updater = new DefinitionUpdater(dir);
  updater.updateClamAV = async () => {
    throw new Error("freshclam must not run in this test");
  };
  updater.updateHashFeed = async () => {
    throw new Error("hash feed must not run in this test");
  };
  return { dir, corpusPath, updater };
}

function stubSources(updater, bodies) {
  updater.downloadText = async (url) => {
    const name = SOURCES.find((candidate) => url.endsWith(candidate));
    assert.ok(name, `fonte inesperada: ${url}`);
    const body = bodies.get(name);
    if (body instanceof Error) throw body;
    return body;
  };
  // Desde a decisão D4 o updater recusa conteúdo cujo SHA-256 não bata com o pin
  // revisto. Estas fontes são sintéticas, por isso o fixture pinia exatamente o
  // que serve: nomes, `repo` e classes continuam a vir do pin de produção e só o
  // digest é recomputado. Não é uma asserção afrouxada — é a mesma condição que o
  // produto tem de satisfazer, aplicada ao conteúdo do stub.
  updater.yaraPin = YARA_PIN.map((pino) => ({
    ...pino,
    sha256: sha256(typeof bodies.get(pino.id) === "string" ? bodies.get(pino.id) : ""),
  }));
}

describe("manifesto do corpus YARA — proveniência e classes", () => {
  it("publica manifesto ligado ao corpus, com classes e rejeições, fora da pasta yara/", async () => {
    const { dir, corpusPath, updater } = await makeUpdater();
    stubSources(
      updater,
      new Map([
        ["MALW_Eicar.yar", EICAR_RULE],
        ["packer_compiler_signatures.yar", PACKER_RULE],
        ["crypto_signatures.yar", CRYPTO_RULE],
        ["RANSOM_MS17-010_Wannacrypt.yar", RANSOM_RULE],
      ]),
    );

    try {
      assert.equal(await updater.refreshYaraCorpus(), true);

      const manifest = JSON.parse(await fs.readFile(path.join(dir, ".yara-corpus.json"), "utf-8"));
      const corpus = await fs.readFile(corpusPath, "utf-8");

      assert.equal(manifest.version, 1);
      assert.equal(manifest.corpusSha256, sha256(corpus), "o manifesto tem de descrever ESTE corpus");
      assert.deepEqual(manifest.sources.map((s) => s.name).sort(), [
        "MALW_Eicar.yar",
        "RANSOM_MS17-010_Wannacrypt.yar",
        "crypto_signatures.yar",
        "cybersafe-eicar-control.yar",
        "packer_compiler_signatures.yar",
      ]);
      assert.deepEqual(
        manifest.sources.map((s) => s.ruleClass).sort(),
        ["production", "reference", "reference", "test", "test"],
        "EICAR e o controlo são teste; ransom é produção; packer/crypto são referência",
      );
      assert.deepEqual(manifest.rejected, []);
      assert.ok(!corpus.includes("CYBERSAFE_SYNTH_PACKER_NEEDLE"), "referência não entra no corpus");
      assert.ok(!corpus.includes("CYBERSAFE_SYNTH_CRYPTO_NEEDLE"), "referência não entra no corpus");
      assert.match(corpus, /CYBERSAFE_SYNTH_RANSOM_NEEDLE/);
      assert.deepEqual(await fs.readdir(path.join(dir, "yara")), ["default.yar"], "a pasta yara/ fica só com o corpus");

      // O motor usa o manifesto publicado e distingue produção, teste e referência.
      const engine = new YaraEngine(corpusPath);
      await engine.load(corpusPath);
      assert.equal(engine.health.status, "active");
      assert.equal(engine.health.coverage, "unknown");
      assert.equal(engine.manifest?.sources.length, 5);
      assert.match(engine.health.detail ?? "", /1 production and 2 test source/);
      assert.match(engine.health.detail ?? "", /2 reference source\(s\) excluded/);

      // CONTROL0 POSITIVO — a agulha sintética da fonte de teste é detetada
      // pelo corpus publicado. O EICAR canónico fica para o teste opt-in
      // (`CYBERSAFE_EICAR_MANUAL=1`): o AV do host remove o ficheiro temporário
      // interno do `engine.match` antes de o YARA o abrir, como já foi medido
      // neste ambiente. Trocar aqui a agulha não altera o corpus publicado: a
      // fonte de teste e o controlo continuam no ficheiro.
      const synthetic = Buffer.from("CYBERSAFE_SYNTH_EICAR_NEEDLE", "ascii");
      const scan = engine.match(synthetic);
      assert.ok(
        scan.some((match) => match.ruleId === "eicar_test"),
        "o corpus publicado tem de conter a fonte de teste",
      );

      // E o negativo: conteúdo benigno não dispara nenhuma regra.
      const benign = path.join(dir, "benigno.txt");
      await fs.writeFile(benign, "Relatório benigno, sem assinaturas.\n".repeat(20), "utf-8");
      const clean = await engine.scanFileOutcome(benign);
      assert.equal(clean.status, "ok");
      assert.deepEqual(clean.matches, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("referência PE/crypto não entra no corpus de ameaça nem dispara em ficheiro benigno", async () => {
    const { dir, corpusPath, updater } = await makeUpdater();
    stubSources(
      updater,
      new Map([
        ["MALW_Eicar.yar", EICAR_RULE],
        ["packer_compiler_signatures.yar", REFERENCE_PE_RULE],
        ["crypto_signatures.yar", REFERENCE_CRYPTO_RULE],
        ["RANSOM_MS17-010_Wannacrypt.yar", RANSOM_RULE],
      ]),
    );

    try {
      assert.equal(await updater.refreshYaraCorpus(), true);
      const corpus = await fs.readFile(corpusPath, "utf-8");
      assert.doesNotMatch(corpus, /rule IsPE64\b/);
      assert.doesNotMatch(corpus, /rule RijnDael_AES\b/);

      // 1 KiB de cabeçalho PE64 inerte: se a referência entrasse no corpus,
      // `IsPE64 { condition: true }` dispararia aqui. Não pode haver matches.
      const pe = Buffer.alloc(1024);
      pe.writeUInt16LE(0x5a4d, 0);
      pe.writeUInt32LE(0x80, 0x3c);
      pe.writeUInt32LE(0x4550, 0x80);
      pe.writeUInt16LE(0x8664, 0x84);
      const fixture = path.join(dir, "synthetic-header-only.bin");
      await fs.writeFile(fixture, pe);

      const engine = new YaraEngine(corpusPath);
      await engine.load(corpusPath);
      const outcome = await engine.scanFileOutcome(fixture);
      assert.equal(outcome.status, "ok");
      assert.deepEqual(outcome.matches, [], "referência não pode produzir hits no corpus de ameaça");
      assert.equal(engine.ruleCount, 3, "EICAR + ransom + controlo; referência fica fora");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("manifesto conta regras reportáveis com o parser do core (indentada/global/private)", async () => {
    const { dir, updater } = await makeUpdater();
    stubSources(
      updater,
      new Map([
        ["MALW_Eicar.yar", COUNT_RULES],
        ["packer_compiler_signatures.yar", REFERENCE_PE_RULE],
        ["crypto_signatures.yar", REFERENCE_CRYPTO_RULE],
        ["RANSOM_MS17-010_Wannacrypt.yar", RANSOM_RULE],
      ]),
    );

    try {
      assert.equal(await updater.refreshYaraCorpus(), true);
      const manifest = JSON.parse(await fs.readFile(path.join(dir, ".yara-corpus.json"), "utf-8"));
      const eicar = manifest.sources.find((source) => source.name === "MALW_Eicar.yar");

      assert.equal(countReportableYaraRules(COUNT_RULES), 3);
      assert.equal(
        eicar.rules,
        3,
        "indentada e global contam; private não; o manifesto usa o parser do motor",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("só fonte de teste => manifesto só-teste e motor em degradado", async () => {
    const { dir, corpusPath, updater } = await makeUpdater();
    stubSources(
      updater,
      new Map([
        ["MALW_Eicar.yar", EICAR_RULE],
        ["packer_compiler_signatures.yar", new Error("HTTP 503 ao baixar fonte YARA.")],
        ["crypto_signatures.yar", new Error("HTTP 503 ao baixar fonte YARA.")],
        ["RANSOM_MS17-010_Wannacrypt.yar", new Error("HTTP 503 ao baixar fonte YARA.")],
      ]),
    );

    try {
      assert.equal(await updater.refreshYaraCorpus(), true);
      const manifest = JSON.parse(await fs.readFile(path.join(dir, ".yara-corpus.json"), "utf-8"));
      assert.deepEqual(manifest.sources.map((s) => s.ruleClass), ["test", "test"]);
      assert.equal(manifest.rejected.length, 3);

      const engine = new YaraEngine(corpusPath);
      await engine.load(corpusPath);
      assert.equal(engine.health.status, "degraded", "test-only nunca é motor activo de malware");
      assert.equal(engine.health.coverage, "limited");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("todas as fontes falham => não publica, preserva o corpus e devolve false", async () => {
    const { dir, corpusPath, updater } = await makeUpdater();
    const previous = await fs.readFile(corpusPath, "utf-8");
    stubSources(
      updater,
      new Map(SOURCES.map((name) => [name, new Error("HTTP 500 ao baixar fonte YARA.")])),
    );

    try {
      assert.equal(await updater.refreshYaraCorpus(), false);
      assert.equal(await fs.readFile(corpusPath, "utf-8"), previous, "sem candidato válido o corpus não muda");
      await assert.rejects(() => fs.readFile(path.join(dir, ".yara-corpus.json"), "utf-8"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("a recuperação do arranque só mexe no YARA (sem freshclam nem hashes)", async () => {
    const { dir, updater } = await makeUpdater();
    let clamCalls = 0;
    let hashCalls = 0;
    updater.updateClamAV = async () => {
      clamCalls += 1;
    };
    updater.updateHashFeed = async () => {
      hashCalls += 1;
    };
    stubSources(
      updater,
      new Map([
        ["MALW_Eicar.yar", EICAR_RULE],
        ["packer_compiler_signatures.yar", PACKER_RULE],
        ["crypto_signatures.yar", CRYPTO_RULE],
        ["RANSOM_MS17-010_Wannacrypt.yar", PACKER_RULE.replace(/packer_test|SYNTH_PACKER/, (m) => m === "packer_test" ? "ransom_test" : "SYNTH_RANSOM")],
      ]),
    );

    try {
      assert.equal(await updater.refreshYaraCorpus(), true);
      assert.equal(clamCalls, 0);
      assert.equal(hashCalls, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
