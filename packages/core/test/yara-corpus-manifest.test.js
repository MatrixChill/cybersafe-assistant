import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { countReportableYaraRules, YaraEngine } from "../dist/yara.js";

/**
 * PROVENIÊNCIA DO CORPUS — o manifesto diz de onde veio cada regra.
 *
 * Contrato:
 *  - o manifesto está ligado ao corpus por `corpusSha256`; se não bater, é
 *    ignorado (um manifesto velho não descreve o ficheiro que está em disco);
 *  - o manifesto só pode BAIXAR a cobertura: uma fonte marcada `production`
 *    não transforma um corpus só-EICAR em cobertura normal;
 *  - fontes rejeitadas ficam registadas com motivo curto, sem URLs;
 *  - um corpus de produção real continua `unknown` (proveniência ≠ eficácia).
 */

const tmpRoots = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yara-manifest-"));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

const sha256 = (text) => createHash("sha256").update(text, "utf-8").digest("hex");

/**
 * Regra de teste com agulha SINTÉTICA, não a assinatura EICAR canónica.
 *
 * Este ficheiro grava o corpus em disco (`writeCorpus`) sem qualquer gate, e é
 * precisamente isso que o `eicar-manual-opt-in.test.js` proíbe: a assinatura
 * real só pode ser escrita por ficheiros atrás de CYBERSAFE_EICAR_MANUAL=1
 * (antecedente: `engine-integrity.test.js` usa PROBE_MARKER pela mesma razão).
 * O contrato aqui é o do manifesto, e a classificação de cobertura lê o nome da
 * regra e a descrição (`TEST_SIGNATURE` em yara.ts), nunca o literal — portanto
 * trocar o literal não muda nenhuma asserção deste ficheiro.
 */
const EICAR_RULE = `rule eicar
{
  meta:
    description = "Rule to detect Eicar pattern"
  strings:
    $s1 = "CybersafeSyntheticTestNeedleNotASignature" fullword ascii
  condition:
    all of them
}
`;

const PRODUCTION_RULE = `rule MALW_Test_Family
{
  meta:
    description = "Synthetic malware-family signature for tests"
  strings:
    $a = "CybersafeSyntheticMalwareNeedle" ascii
  condition:
    $a
}
`;

function writeCorpus(dir, content) {
  const yaraDir = path.join(dir, "yara");
  fs.mkdirSync(yaraDir, { recursive: true });
  const rulesPath = path.join(yaraDir, "default.yar");
  fs.writeFileSync(rulesPath, content, "utf-8");
  return rulesPath;
}

function writeManifest(dir, content, overrides = {}) {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    corpusSha256: sha256(content),
    sources: [
      { name: "packer_compiler_signatures.yar", ruleClass: "production", rules: 1, sha256: sha256(PRODUCTION_RULE) },
      { name: "MALW_Eicar.yar", ruleClass: "test", rules: 1, sha256: sha256(EICAR_RULE) },
    ],
    rejected: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, ".yara-corpus.json"), JSON.stringify(manifest), "utf-8");
  return manifest;
}

describe("manifesto de proveniência do corpus YARA", () => {
  test("M1: produção + teste com manifesto válido => coverage 'unknown' e detalhe com fontes", async () => {
    const dir = tmpdir();
    const content = `${PRODUCTION_RULE}\n${EICAR_RULE}`;
    const rulesPath = writeCorpus(dir, content);
    writeManifest(dir, content);

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.health.status, "active", "o corpus compila: o motor está operacional");
    assert.equal(engine.health.coverage, "unknown", "proveniência não é eficácia");
    assert.equal(engine.manifest?.sources.length, 2, "o manifesto usado tem de ficar observável");
    assert.match(engine.health.detail ?? "", /1 production and 1 test source/);
  });

  test("M2: manifesto NUNCA sobe a cobertura acima do conteúdo (só-EICAR marcado produção)", async () => {
    const dir = tmpdir();
    const content = EICAR_RULE;
    const rulesPath = writeCorpus(dir, content);
    // Manifesto MENTIROSO/errado: diz que o corpus é produção.
    writeManifest(dir, content, {
      sources: [{ name: "MALW_Eicar.yar", ruleClass: "production", rules: 1, sha256: sha256(EICAR_RULE) }],
    });

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.health.coverage, "limited", "o conteúdo só-teste continua a decidir o mínimo");
    assert.notEqual(engine.health.status, "active");
    assert.match(engine.health.detail ?? "", /teste/i);
  });

  test("M3: manifesto de OUTRO corpus (hash não bate) é ignorado", async () => {
    const dir = tmpdir();
    const content = `${PRODUCTION_RULE}\n${EICAR_RULE}`;
    const rulesPath = writeCorpus(dir, content);
    writeManifest(dir, "rule outro_corpus { condition: true }\n");

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.manifest, null, "um manifesto desligado do ficheiro não pode ser usado");
    assert.equal(engine.health.status, "active");
    assert.equal(engine.health.coverage, "unknown");
  });

  test("M4: manifesto ilegível/ inválido é ignorado sem matar o motor", async () => {
    const dir = tmpdir();
    const content = `${PRODUCTION_RULE}\n${EICAR_RULE}`;
    const rulesPath = writeCorpus(dir, content);
    fs.writeFileSync(path.join(dir, ".yara-corpus.json"), "{ isto não é json", "utf-8");

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.manifest, null);
    assert.equal(engine.health.status, "active");
    assert.equal(engine.ruleCount, 2);
  });

  test("M5: fontes rejeitadas aparecem no detalhe (sem URL nem caminho)", async () => {
    const dir = tmpdir();
    const content = `${PRODUCTION_RULE}\n${EICAR_RULE}`;
    const rulesPath = writeCorpus(dir, content);
    writeManifest(dir, content, {
      rejected: [{ name: "RANSOM_MS17-010_Wannacrypt.yar", reason: "HTTP 404" }],
    });

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.match(engine.health.detail ?? "", /1 fonte\(s\) rejeitada\(s\)/);
    assert.doesNotMatch(engine.health.detail ?? "", /https?:\/\//, "o estado não transporta URLs");
  });

  test("M7: load() reancora o manifesto no diretório do corpus carregado", async () => {
    const dir = tmpdir();
    const content = `${PRODUCTION_RULE}\n${EICAR_RULE}`;
    const rulesPath = writeCorpus(dir, content);
    writeManifest(dir, content);

    // É o percurso do serviço: motor construído sem path e carregado depois.
    const engine = new YaraEngine();
    await engine.load(rulesPath);

    assert.equal(engine.manifest?.sources.length, 2, "o manifesto tem de acompanhar o corpus carregado");
    assert.equal(engine.health.coverage, "unknown");
  });

  test("M6: corpus só de teste + manifesto com produção rejeitada => degraded, não activo", async () => {
    const dir = tmpdir();
    const content = EICAR_RULE;
    const rulesPath = writeCorpus(dir, content);
    writeManifest(dir, content, {
      sources: [{ name: "MALW_Eicar.yar", ruleClass: "test", rules: 1, sha256: sha256(EICAR_RULE) }],
      rejected: [
        { name: "packer_compiler_signatures.yar", reason: "HTTP 503" },
        { name: "crypto_signatures.yar", reason: "HTTP 503" },
      ],
    });

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.health.coverage, "limited");
    assert.equal(engine.health.status, "degraded");
  });

  test("M8: 'reference' é proveniência, não produção nem cobertura", async () => {
    const dir = tmpdir();
    const content = `${PRODUCTION_RULE}\n${EICAR_RULE}`;
    const rulesPath = writeCorpus(dir, content);
    writeManifest(dir, content, {
      sources: [
        { name: "RANSOM_MS17-010_Wannacrypt.yar", ruleClass: "production", rules: 1, sha256: sha256(PRODUCTION_RULE) },
        { name: "MALW_Eicar.yar", ruleClass: "test", rules: 1, sha256: sha256(EICAR_RULE) },
        { name: "packer_compiler_signatures.yar", ruleClass: "reference", rules: 36, sha256: sha256("packer-reference") },
        { name: "crypto_signatures.yar", ruleClass: "reference", rules: 124, sha256: sha256("crypto-reference") },
      ],
    });

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.manifest?.sources.length, 4, "a referência fica registada no manifesto");
    assert.match(engine.health.detail ?? "", /1 production and 1 test source/);
    assert.match(
      engine.health.detail ?? "",
      /2 reference source\(s\) excluded/,
      "as fontes de referência não contam como produção",
    );
    assert.equal(engine.health.coverage, "unknown", "proveniência não é eficácia");
  });

  test("M10: contagem lexical inclui indentadas e global, exclui private", () => {
    const content = [
      "rule top { condition: true }",
      " rule indented { condition: true }",
      "private rule helper { condition: true }",
      "global rule global_rule { condition: true }",
    ].join("\n");

    assert.equal(
      countReportableYaraRules(content),
      3,
      "top + indentada + global; private não é reportável",
    );
  });

  test("M9: classe desconhecida invalida o manifesto (não se adivinha proveniência)", async () => {
    const dir = tmpdir();
    const content = `${PRODUCTION_RULE}\n${EICAR_RULE}`;
    const rulesPath = writeCorpus(dir, content);
    writeManifest(dir, content, {
      sources: [
        { name: "fonte_futura.yar", ruleClass: "mystery", rules: 1, sha256: sha256(PRODUCTION_RULE) },
      ],
    });

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.manifest, null, "uma classe desconhecida não pode ser reinterpretada");
    assert.equal(engine.health.status, "active");
    assert.equal(engine.health.coverage, "unknown");
  });
});
