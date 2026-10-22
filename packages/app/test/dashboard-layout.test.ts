import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeDiskSpace, PROTECTION_LEVEL_META } from "../src/lib/protectionHealth";

/**
 * Invariantes de layout do cabeçalho do Painel (estado geral).
 *
 * Bug manual: o texto "Degradado" aparecia sobreposto/desalinhado no topo do
 * Painel. As causas estruturais eram (a) chips sem a utility border (o
 * modificador de cor de borda era inerte e o chip parecia desalinhado) e
 * (b) rótulos do anel sem limite de largura. Estes testes fixam os invariantes.
 */
describe("Dashboard status chip / ring layout invariants", () => {
  const levels = ["protected", "attention", "degraded", "critical"] as const;

  test("o chip inclui a utility border (sem ela, border-*/30 nao desenha)", () => {
    for (const level of levels) {
      assert.match(
        PROTECTION_LEVEL_META[level].chipClass,
        /(^|\s)border(\s|$)/,
        level + ".chipClass precisa da utility border",
      );
    }
  });

  test("o rotulo curto do anel e curto o suficiente para nao transbordar", () => {
    for (const level of levels) {
      const short = PROTECTION_LEVEL_META[level].shortLabel;
      assert.ok(short.length > 0, level + ".shortLabel nao pode ser vazio");
      assert.ok(
        short.length <= 10,
        level + ".shortLabel '" + short + "' e demasiado longo para o anel (<=10)",
      );
    }
  });

  test("cada nivel define as classes semanticas usadas no cabecalho", () => {
    for (const level of levels) {
      const meta = PROTECTION_LEVEL_META[level];
      for (const key of ["dotClass", "textClass", "chipClass", "label"] as const) {
        assert.equal(typeof meta[key], "string");
        assert.ok(meta[key].length > 0, level + "." + key + " nao pode ser vazio");
      }
    }
  });

  test("o nivel degraded expõe um texto curto e compreensível (sem termos técnicos)", () => {
    assert.equal(PROTECTION_LEVEL_META.degraded.shortLabel, "Atenção");
  });
});

/**
 * WS-3 — hierarquia do topo: pergunta → resposta direta → nota → prioridades.
 *
 * O hero antigo dizia "Olá! Sou a Matrix" + um parágrafo que repetia, palavra
 * a palavra, os avisos da lista de prioridades abaixo. Fixamos aqui o inverso:
 * a resposta é curta, distinta por nível, e não volta a dizer o que a secção
 * "O que precisa de atenção" já diz.
 */
describe("Dashboard hero — resposta central e sem repetição", () => {
  const levels = ["protected", "attention", "degraded", "critical"] as const;

  test("cada nível responde à pergunta em poucas palavras", () => {
    for (const level of levels) {
      const answer = PROTECTION_LEVEL_META[level].answer;
      assert.ok(answer.length > 0, level + ".answer não pode ser vazio");
      assert.ok(answer.length <= 24, level + ".answer '" + answer + "' é demasiado longo para o topo (<=24)");
      assert.match(answer, /\.$/, level + ".answer deve ser uma frase fechada");
    }
  });

  test("as quatro respostas são diferentes entre si (hierarquia clara)", () => {
    const answers = levels.map((level) => PROTECTION_LEVEL_META[level].answer);
    assert.equal(new Set(answers).size, answers.length, "respostas repetidas não deixam ver a diferença de estado");
  });

  test("o hero não repete a palavra da secção de prioridades", () => {
    for (const level of levels) {
      const { answer, answerDetail } = PROTECTION_LEVEL_META[level];
      for (const text of [answer, answerDetail]) {
        assert.doesNotMatch(text, /atenç/i, "'" + text + "' duplica o título 'O que precisa de atenção'");
      }
      assert.ok(PROTECTION_LEVEL_META[level].answerDetail.length <= 90, level + ".answerDetail é um parágrafo, não uma frase");
    }
  });

  test("protected é a única resposta sem aviso e não anuncia perigo", () => {
    assert.match(PROTECTION_LEVEL_META.protected.answer, /^Sim/);
    for (const level of ["attention", "degraded", "critical"] as const) {
      assert.doesNotMatch(PROTECTION_LEVEL_META[level].answer, /^Sim\.$/, level + " não pode responder igual a protected");
    }
  });
});

/**
 * Disco: DADO (espaço livre) → SIGNIFICADO (o que deixa de funcionar) →
 * ORIENTAÇÃO (o que fazer). "62% usado" não diz a ninguém nada.
 */
describe("describeDiskSpace — espaço livre, significado e ação", () => {
  test("mostra o espaço LIVRE calculado do total, não a percentagem usada", () => {
    const g = describeDiskSpace(300, 1000);
    assert.equal(g.urgency, "ok");
    assert.equal(g.freeGb, 700);
    assert.match(g.freeText, /livres/);
    assert.match(g.freeText, /700/);
    assert.equal(g.action, "", "sem problema não se inventa tarefa");
    assert.ok(g.meaning.length > 0, "o significado acompanha sempre o número");
  });

  test("folga curta: explica e diz o que fazer", () => {
    const g = describeDiskSpace(480, 500);
    assert.equal(g.urgency, "tight");
    assert.equal(g.freeGb, 20);
    assert.match(g.action, /libertar/i);
    assert.match(g.meaning, /atualiza/i);
  });

  test("crítico: mensagem de falha real e ação concreta", () => {
    const g = describeDiskSpace(118, 120);
    assert.equal(g.urgency, "critical");
    assert.match(g.action, /Reciclagem/i, "a orientação tem de ser executável por uma pessoa");
    assert.match(g.meaning, /falha|não instala|deixam de abrir/i);
  });

  test("o limiar também é proporcional: 2 TB com 10 GB livres é crítico", () => {
    const g = describeDiskSpace(1990, 2000);
    assert.equal(g.urgency, "critical", "10 GB num volume de 2 TB é praticamente nada");
  });

  test("sem leitura fiável não se inventa nada", () => {
    for (const [used, total] of [[0, 0], [Number.NaN, 500], [-5, 500], [100, Number.NaN]] as const) {
      const g = describeDiskSpace(used, total);
      assert.equal(g.urgency, "unknown", `used=${used} total=${total}`);
      assert.equal(g.freeText, "—");
      assert.equal(g.action, "");
    }
  });

  test("nunca devolve espaço livre negativo", () => {
    const g = describeDiskSpace(1200, 1000);
    assert.equal(g.freeGb, 0);
    assert.equal(g.urgency, "critical");
  });
});
