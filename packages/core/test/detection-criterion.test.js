import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scoreThreat } from "../dist/scoring.js";

/**
 * O critério de ameaça. Regressões do P0 "scanner-detection-quality".
 *
 * Um ficheiro só é ameaça com EVIDÊNCIA (hash DB, YARA-X, ClamAV, reexecução
 * bloqueada) ou com uma combinação de heurísticas deliberadamente reforçada.
 * Sinais heurísticos isolados — estar numa pasta suspeita, ter entropia alta,
 * ser um PE ou um arquivo, ser um VSIX — são FINDING, nunca malware.
 *
 * Cada teste é uma linha do contrato do utilizador, com o porque ao lado.
 */

const clean = { signatureMatch: false, yaraMatches: 0, rulesTriggered: [], trustDecision: "unknown" };

describe("critério de ameaça — evidência forte", () => {
  test("hash known bad continua a ser ameaça", () => {
    // Prova de malware pela base de assinaturas: isto é deteção, não palpite.
    const r = scoreThreat({ ...clean, signatureMatch: true, rulesTriggered: ["known_bad_hash"] });
    assert.equal(r.verdict, "malicious");
    assert.equal(r.severity, "critical");
    assert.equal(r.recommendedAction, "quarantined");
  });

  test("YARA-X a bater é ameaça, com ou sem heurísticas", () => {
    // Um match de YARA-X identifica o binário: sobe sozinho, sem reforco.
    const r = scoreThreat({ ...clean, yaraMatches: 1, rulesTriggered: ["yara_match"] });
    assert.equal(r.verdict, "malicious");
    assert.ok(r.severity !== "low");
  });

  test("ClamAV a bater é ameaça", () => {
    const r = scoreThreat({ ...clean, rulesTriggered: ["known_malware"] });
    assert.equal(r.verdict, "malicious");
  });

  test("o canário de teste do projeto continua a ser ameaça forte", () => {
    // dev_canary_signature é EVIDÊNCIA FORTE: o canário é o nosso teste de que
    // uma deteção verdadeira continua a ser anunciada. Se isto passar a "safe",
    // a correção partiu a deteção — e é o alarme mais importante da suite.
    const r = scoreThreat({
      ...clean,
      rulesTriggered: ["dev_canary_signature", "suspicious_location"],
    });
    assert.equal(r.verdict, "suspicious");
    assert.equal(r.severity, "medium", "severity != low e o serviço anuncia a deteção");
    assert.notEqual(r.severity, "low", "engine.ts:935 publica threat para severity != low");
  });

  test("PE benigno em pasta de sistema não é ameaça", () => {
    // Controlo: notepad.exe real deu 0 pontos. Extensão perigosa isolada não
    // é ameaça, e a confiança do caminho do sistema ainda mais reduz.
    const r = scoreThreat({
      signatureMatch: false,
      yaraMatches: 0,
      rulesTriggered: ["dangerous_file_extension", "trusted_system_path", "unsigned_binary"],
      trustDecision: "trusted",
    });
    assert.equal(r.verdict, "safe");
    assert.equal(r.severity, "low");
  });
});

describe("critério de ameaça — heurística isolada é finding, não malware", () => {
  test("localização suspeita isolada NÃO é ameaça", () => {
    // Estar em \Temp\ não é ser malware. Isolado, não prova nada.
    const r = scoreThreat({ ...clean, rulesTriggered: ["suspicious_location"] });
    assert.equal(r.verdict, "safe");
    assert.equal(r.severity, "low");
  });

  test("entropia alta isolada NÃO é ameaça", () => {
    // Quase todo o software comprimido tem entropia alta. Isolada, não prova nada.
    const r = scoreThreat({ ...clean, rulesTriggered: ["high_entropy"] });
    assert.equal(r.verdict, "safe");
    assert.equal(r.severity, "low");
  });

  test("arquivo com .exe dentro, isolado, NÃO é ameaça", () => {
    // archive_with_exe sozinha descreve metade do software instalado neste pc.
    const r = scoreThreat({ ...clean, rulesTriggered: ["archive_with_exe"] });
    assert.equal(r.verdict, "safe");
    assert.equal(r.severity, "low");
  });

  test("PE sem hash e em localização normal NÃO é ameaça", () => {
    // Um .exe desconhecido numa pasta de sistema: nada confirma malware.
    const r = scoreThreat({ ...clean, rulesTriggered: ["unsigned_binary", "high_entropy"] });
    assert.equal(r.verdict, "safe");
    assert.equal(r.severity, "low");
  });

  test("o VSIX real que o scan deu como ameaça deixa de ser ameaça", () => {
    // EXACTO o caso do scan manual: payload.vsix em \Temp\, ZIP com .exe dentro.
    // Antes: 15 + 5 + 30 = 50, severity medium, "Threat detected in payload.vsix".
    // Nenhum hash DB, nenhum YARA, nenhum ClamAV — e confidence 0.2.
    const r = scoreThreat({
      ...clean,
      rulesTriggered: ["suspicious_location", "high_entropy", "archive_with_exe"],
    });
    assert.equal(r.riskScore, 50, "o score não muda: muda é a decisão sobre ele");
    assert.equal(r.verdict, "safe", "três heurísticas fracas não são malware");
    assert.equal(r.severity, "low", "e severity low é o que impede o 'Threat detected'");
  });

  test("o finding continua visível: fatores e recomendação não desaparecem", () => {
    // Finding ≠ ameaça. O utilizador tem de continuar a ver o porque.
    const r = scoreThreat({
      ...clean,
      rulesTriggered: ["suspicious_location", "high_entropy", "archive_with_exe"],
    });
    assert.equal(r.factors.length, 3, "os três sinais continuam listados");
    assert.equal(r.recommendedAction, "logged", "e continuam registados para atenção");
  });
});

describe("critério de ameaça — combinação reforçada", () => {
  test("heurísticas reforçadas entre si continuam a ser ameaça", () => {
    // Extensão perigosa + extensão dupla + nome de engenharia social: três
    // sinais independentes que juntos pesam 60... com mais um, 70 = reforçado.
    const r = scoreThreat({
      ...clean,
      rulesTriggered: [
        "dangerous_file_extension",
        "double_extension",
        "social_engineering_filename_pattern",
        "magic_number_mismatch",
      ],
    });
    assert.equal(r.verdict, "suspicious", "reforçado continua a ser sinal de ameaça");
    assert.equal(r.severity, "medium");
  });

  test("confiança reduz o score e a decisão segue a evidência, não o score", () => {
    // Publisher de confiança a reduzir, com o resto igual: o score desce e a
    // decisão não sobe por o score sozinho.
    const r = scoreThreat({
      signatureMatch: false,
      yaraMatches: 0,
      rulesTriggered: ["suspicious_location", "high_entropy", "archive_with_exe", "trusted_publisher"],
      trustDecision: "trusted",
    });
    assert.ok(r.riskScore < 50, `score com confiança deve baixar (foi ${r.riskScore})`);
    assert.equal(r.verdict, "safe");
  });
});
