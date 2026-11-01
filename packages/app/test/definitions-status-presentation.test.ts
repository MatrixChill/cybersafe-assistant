import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  linhaDasDefinicoes,
  resumoDasDefinicoes,
} from "../src/lib/definitionsStatusPresentation";

/**
 * Apresentação do estado das definições. O que aqui se protege são as três
 * coisas que este produto já embarcou por confundir eixos:
 *  - «instalado» vs «operacional» (um motor com base parcial não está saudável);
 *  - «sem leitura» vs «está mal» (não escalar severidade por ausência de dado);
 *  - 0 vs não medido (mostrar «0 assinaturas» afirma algo que ninguém mediu).
 */
const AGORA = Date.parse("2026-11-01T15:00:00.000Z");

function fonte(overrides: Record<string, unknown> = {}) {
  return {
    fonte: "clamav",
    estado: "actualizado",
    ultimaBemSucedidaAtMs: AGORA - 10 * 60 * 1000,
    ultimaTentativaAtMs: AGORA - 10 * 60 * 1000,
    ultimoErro: null,
    tentativasConsecutivas: 0,
    proximaVerificacaoAtMs: AGORA + 6 * 60 * 60 * 1000,
    cadenciaMs: 6 * 60 * 60 * 1000,
    identificadorBase: "daily-28171.cvd",
    itensCarregados: 3,
    ...overrides,
  } as any;
}

describe("estado das definições por fonte", () => {
  it("cinco estados com rótulos PT-PT distintos, sem colapsar eixos", () => {
    const rotulos = ["actualizado", "desactualizado", "degradado", "indisponivel", "nunca_verificado"].map(
      (estado) => linhaDasDefinicoes(fonte({ estado }), AGORA).rotulo,
    );
    assert.deepEqual(rotulos, [
      "Atualizado",
      "Desatualizado",
      "Degradado",
      "Indisponível",
      "Nunca verificado",
    ]);
    assert.equal(new Set(rotulos).size, 5, "cada estado tem de ter o seu nome");
  });

  it("ausência de leitura não escala severidade", () => {
    assert.equal(linhaDasDefinicoes(fonte({ estado: "nunca_verificado" }), AGORA).severidade, "ok");
    assert.equal(linhaDasDefinicoes(fonte({ estado: "degradado" }), AGORA).severidade, "atencao");
  });

  it("contagem não medida aparece como texto, nunca como zero", () => {
    const linha = linhaDasDefinicoes(fonte({ itensCarregados: null }), AGORA);
    assert.match(linha.texto, /contagem não medida/);
    assert.doesNotMatch(linha.texto, /\b0 (assinaturas|ficheiros)/, "zero é uma afirmação, não um vazio");
    const medido = linhaDasDefinicoes(fonte({ itensCarregados: 0 }), AGORA);
    assert.match(medido.texto, /0 assinaturas|0 ficheiros/, "um zero medido continua a ser mostrado");
  });

  it("a causa é catalogada e o texto do transporte nunca é ecoado", () => {
    const sujo = "MalwareBazaar HTTP 500 https://mb-api.abuse.ch/api/v1/ chave=abc123 C:\\Users\\caioc";
    const linha = linhaDasDefinicoes(
      fonte({ estado: "degradado", ultimoErro: sujo, tentativasConsecutivas: 2 }),
      AGORA,
    );
    assert.match(linha.texto, /causa: falha não catalogada \(2 tentativa\(s\) consecutiva\(s\)\)/);
    assert.doesNotMatch(linha.texto, /mb-api\.abuse\.ch|abc123|Users/, "URL, chave e caminho não saem ao ecrã");
    for (const [erro, esperada] of [
      ["MalwareBazaar: sem chave de acesso (define MALWAREBAZAAR_AUTH_KEY)", "chave de acesso não configurada"],
      ["MalwareBazaar: Auth-Key recusada (bad auth)", "chave de acesso recusada"],
      ["MalwareBazaar HTTP 429: limite de pedidos do fornecedor.", "limite de pedidos do fornecedor"],
      ["ECONNREFUSED 127.0.0.1:443", "sem ligação ao fornecedor"],
      ["MalwareBazaar: resposta não é JSON utilizável.", "resposta do fornecedor não utilizável"],
    ] as const) {
      assert.match(
        linhaDasDefinicoes(fonte({ estado: "degradado", ultimoErro: erro }), AGORA).texto,
        new RegExp(esperada),
        erro,
      );
    }
  });

  it("tempo relativo e próxima verificação nunca são um vazio silencioso", () => {
    const l = linhaDasDefinicoes(fonte(), AGORA);
    assert.match(l.texto, /há 10 min/);
    assert.match(l.texto, /em ~360 min|em ~6 h/);
    const futuro = linhaDasDefinicoes(
      fonte({ ultimaBemSucedidaAtMs: null, ultimaTentativaAtMs: null, proximaVerificacaoAtMs: AGORA - 1 }),
      AGORA,
    );
    assert.match(futuro.texto, /—/);
    assert.match(futuro.texto, /sem atualização bem sucedida registada/);
    assert.match(futuro.texto, /na próxima verificação/);
  });

  it("sem fontes do serviço: nada é afirmado, e não é «tudo atualizado»", () => {
    for (const v of [null, undefined, {}, { fontes: "x" }, { fontes: [] }]) {
      const r = resumoDasDefinicoes(v as any, AGORA);
      assert.equal(r.linhas.length, 0);
      assert.match(r.texto, /não devolveu estado|Nada é afirmado/, JSON.stringify(v));
    }
  });

  it("a pior severidade entre fontes domina o resumo", () => {
    const status = {
      cicloEmCurso: false,
      geradoEmMs: AGORA,
      fontes: [
        fonte({ fonte: "clamav", estado: "actualizado" }),
        fonte({ fonte: "hashes", estado: "indisponivel" }),
      ],
    } as any;
    const r = resumoDasDefinicoes(status, AGORA);
    assert.equal(r.severidade, "atencao");
    assert.equal(r.linhas.length, 2);
    assert.match(r.texto, /ClamAV — Atualizado/);
    assert.match(r.texto, /Base de hashes — Indisponível/);
  });
});
