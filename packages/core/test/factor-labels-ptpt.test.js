import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { scoreThreat } from "../dist/scoring.js";

/**
 * ROTULOS DOS FACTOS DE DETECCAO — PT-PT no ecra, identificador estavel.
 *
 * `factors[].label` nao e um campo interno: o servico junta os labels num
 * `summary` e publica-o no evento `artifact.analyzed`
 * (packages/service/src/engine.ts:1082), e esse summary chega tal e qual ao
 * toast e ao relatorio. O `label` e, portanto, TEXTO DE ECRA.
 *
 * Antes disto o rotulo era `rule.replaceAll("_", " ")` — a chave tecnica com
 * os underscores virados em espacos. O utilizador lia "dangerous file
 * extension" e "high entropy" no meio de uma frase em portugues. Nao e um
 * detalhe: e a unica explicacao que o produto da de porque classifica o
 * ficheiro.
 *
 * A distincao que este ficheiro fixa:
 *   `id`   identificador estavel. Nao muda: e a chave de dados, e varios
 *          testes e consumidores dependem dela.
 *   `label` texto para o utilizador. PT-PT, e a unica coisa que muda.
 *
 * Um factor cujo `id` nao tem rotulo em PT-PT continua a funcionar: o
 * fallback e o identificador legivel, nunca uma string inventada e nunca a
 * forma Crua com underscores.
 */

const ENTRADA_BASE = {
  signatureMatch: false,
  yaraMatches: 0,
  rulesTriggered: [],
  trustDecision: "unknown",
};

/** Todos os ids que o scoring pode produzir a partir das regras heuristicas. */
const IDS_DAS_REGRAS = [
  "dangerous_file_extension",
  "social_engineering_filename_pattern",
  "suspicious_download_type",
  "double_extension",
  "executable_signature",
  "archive_with_exe",
  "magic_number_mismatch",
  "high_entropy",
  "process_injection_indicator",
  "suspicious_location",
  "persistence_attempt",
  "allowlisted_hash",
  "trusted_publisher",
  "trusted_system_path",
];

function fatorDe(ruleId) {
  const r = scoreThreat({ ...ENTRADA_BASE, rulesTriggered: [ruleId] });
  const f = r.factors.find((x) => x.id === ruleId);
  assert.ok(f, `a regra ${ruleId} tem de produzir um factor`);
  return f;
}

describe("factor labels — o que o utilizador lê no ecra", () => {
  test("NENHUMA regra produz um label com a forma tecnica Crua", () => {
    // A regressão exacta: `rule.replaceAll("_", " ")` produzia
    // "dangerous file extension". O underscore e o sinal de que o texto
    //-display ainda e um identificador.
    for (const id of IDS_DAS_REGRAS) {
      const f = fatorDe(id);
      assert.doesNotMatch(
        f.label,
        /_/,
        `o label de "${id}" ainda tem underscore — é a chave técnica, não copy: "${f.label}"`,
      );
    }
  });

  test("NENHUM label contem as palavras inglesas do rotulo antigo", () => {
    const palavrasInglesas = [
      "dangerous", "suspicious", "entropy", "extension", "injection",
      "persistence", "known bad hash", "magic number", "archive",
      "publisher", "system path",
    ];
    for (const id of IDS_DAS_REGRAS) {
      const f = fatorDe(id);
      for (const palavra of palavrasInglesas) {
        assert.ok(
          !f.label.toLowerCase().includes(palavra),
          `o label de "${id}" ainda diz "${palavra}": "${f.label}"`,
        );
      }
    }
  });

  test("todos os labels sao PT-PT e nao vazios", () => {
    for (const id of IDS_DAS_REGRAS) {
      const f = fatorDe(id);
      assert.ok(f.label.trim().length > 0, `"${id}" ficou sem label`);
      // Heurística fraca: um rotulo em português tem maiúsculas que um
      // identificador-derived não tem. Não é prova de nada sozinha; a
      // proibição de underscore e de inglês acima é que fecha o gate.
      assert.match(f.label, /[A-ZÀ-Þ]/, `o label de "${id}" não parece uma frase: "${f.label}"`);
    }
  });

  test("o `id` NÃO mudou — é a chave de dados, não a copy", () => {
    // A garantia inversa: se alguém "corrigir" o português mudando o id, os
    // consumidores que filtram por `id` (detection-criterion.test.js usa
    // `f.id === "yara_match"`) partem em silêncio.
    for (const id of IDS_DAS_REGRAS) {
      const f = fatorDe(id);
      assert.equal(f.id, id, `o id de "${id}" foi alterado`);
    }
  });

  test("os ids sao PT-BR-free tambem no label (detetado vs detectado)", () => {
    for (const id of IDS_DAS_REGRAS) {
      const f = fatorDe(id);
      assert.doesNotMatch(f.label, /detectad[oa]|arquivo|usuári/i, `label PT-BR: "${f.label}"`);
    }
  });
});

describe("factor labels — os factores de assinatura mantem PT-PT", () => {
  test("known bad hash tem label em portugues", () => {
    // Este nao vem de `rulesTriggered`: e o ramo `hasKnownHash` com um
    // label escrito a mao (scoring.ts:103) que continua em ingles.
    const r = scoreThreat({ ...ENTRADA_BASE, signatureMatch: true });
    const f = r.factors.find((x) => x.id === "known-bad-hash");
    assert.ok(f, "um hash malicioso conhecido tem de produzir um factor");
    assert.doesNotMatch(f.label, /_/, f.label);
    assert.ok(!/known bad hash/i.test(f.label), `ainda em ingles: "${f.label}"`);
  });

  test("um factor sem rotulo em PT-PT cai no identificador legivel, nunca cru", () => {
    // Regra desconhecida: o fallback tem de ser legivel, e nunca a chave com
    // underscores. Este e o unico ponto onde o fallback importa.
    const r = scoreThreat({ ...ENTRADA_BASE, rulesTriggered: ["regra_que_nao_existe"] });
    const f = r.factors.find((x) => x.id === "regra_que_nao_existe");
    assert.ok(f, "mesmo uma regra desconhecida produz factor");
    assert.doesNotMatch(f.label, /_/, `fallback cru: "${f.label}"`);
    assert.ok(f.label.trim().length > 0);
  });
});