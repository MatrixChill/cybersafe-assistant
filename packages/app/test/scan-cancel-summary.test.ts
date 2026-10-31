/**
 * TP-A5-D1 — a frase de cancelamento diz contadores EXATOS e nunca transforma
 * considerados em analisados.
 *
 * Defeito reproduzido nos bytes de U (ANTES desta correcção), com
 * `filesAnalyzed` ausente porque o motor nunca reportou a contagem:
 *
 *   "Análise cancelada depois de analisar 2000 ficheiros considerados."
 *
 * Ou seja: 2000 considerados apresentados como 2000 analisados, sem uma única
 * confirmação do motor. O mesmo texto saía quando TODOS os considerados tinham
 * mesmo sido analisados, por isso "desconhecido" e "todos" eram
 * indistinguíveis na UI. O singular mais pequeno também mentia no plural
 * ("0 de 1 ficheiros considerados").
 *
 * Só a mensagem é corrigida: contadores, normalização, merge, IPC e motores
 * ficam intocados — os testes de regressão no fim fixam exactamente isso
 * (fallback permitido em `completed`, eixo de log inalterado).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as session from "../src/lib/scanSession";

type SummaryInput = Parameters<typeof session.buildResultSummary>[0];

const cancelled = (extra: Partial<SummaryInput>): SummaryInput =>
  ({
    scope: "computer",
    type: "quick",
    status: "cancelled",
    threatsFound: 0,
    ...extra,
  }) as SummaryInput;

const summary = (extra: Partial<SummaryInput>): string => session.buildResultSummary(cancelled(extra));

describe("cancelamento — contadores exatos, nunca considerados como analisados", () => {
  test("zero analisados de 2000 considerados: diz os dois números", () => {
    const text = summary({ filesConsidered: 2000, filesAnalyzed: 0 });
    assert.equal(
      text,
      "Análise cancelada: 0 de 2000 ficheiros considerados chegaram a ser analisados.",
    );
  });

  test("parcial: diz os dois números e não fecha a análise", () => {
    const text = summary({ filesConsidered: 800, filesAnalyzed: 120 });
    assert.equal(
      text,
      "Análise cancelada: 120 de 800 ficheiros considerados chegaram a ser analisados.",
    );
    assert.doesNotMatch(text, /800 de 800|concluída/i);
  });

  test("todos analisados: afirma os 800, mas como considerados analisados", () => {
    const text = summary({ filesConsidered: 800, filesAnalyzed: 800 });
    assert.equal(text, "Análise cancelada depois de analisar os 800 ficheiros considerados.");
  });

  test("desconhecido continua desconhecido — nunca vira 2000 analisados", () => {
    const text = summary({ filesConsidered: 2000 });
    // O defeito original: "depois de analisar 2000 ficheiros considerados".
    assert.doesNotMatch(text, /depois de analisar/);
    assert.doesNotMatch(text, /2000 ficheiros analisados/);
    assert.match(text, /não indicou quantos dos 2000 ficheiros considerados chegaram a ser analisados/);
    assert.equal(text.includes("2000"), true, "o número dos considerados é real e continua dito");
  });

  test("desconhecido e todos analisados não produzem a mesma frase", () => {
    const unknown = summary({ filesConsidered: 800 });
    const all = summary({ filesConsidered: 800, filesAnalyzed: 800 });
    assert.notEqual(unknown, all);
  });

  test("desconhecido com contador coerente: filesAnalyzed null/NaN não é analisado", () => {
    for (const bogus of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const text = summary({ filesConsidered: 40, filesAnalyzed: bogus as unknown as number });
      assert.match(text, /não indicou quantos dos 40 ficheiros considerados/);
      assert.doesNotMatch(text, /depois de analisar/);
    }
  });

  test("singular — todos analisados: 1 de 1", () => {
    assert.equal(
      summary({ filesConsidered: 1, filesAnalyzed: 1 }),
      "Análise cancelada depois de analisar o único ficheiro considerado.",
    );
  });

  test("singular — nenhum analisado de 1: concordância correta", () => {
    const text = summary({ filesConsidered: 1, filesAnalyzed: 0 });
    assert.equal(
      text,
      "Análise cancelada: o único ficheiro considerado não chegou a ser analisado.",
    );
    assert.doesNotMatch(text, /1 ficheiros|1 ficheiro considerado chegaram/);
  });

  test("singular — desconhecido de 1", () => {
    const text = summary({ filesConsidered: 1 });
    assert.equal(
      text,
      "Análise cancelada: o motor não indicou se o único ficheiro considerado chegou a ser analisado.",
    );
    assert.doesNotMatch(text, /1 ficheiros/);
  });

  test("zero considerados: não inventa uma frase de análise", () => {
    for (const analyzed of [0, undefined]) {
      const text = summary({ filesConsidered: 0, filesAnalyzed: analyzed });
      assert.equal(text, "Análise cancelada antes de haver ficheiros considerados para analisar.");
    }
  });

  test("nenhuma frase de cancelamento usa plural com um único ficheiro", () => {
    const cases: Partial<SummaryInput>[] = [
      { filesConsidered: 1, filesAnalyzed: 1 },
      { filesConsidered: 1, filesAnalyzed: 0 },
      { filesConsidered: 1 },
    ];
    for (const input of cases) {
      assert.doesNotMatch(summary(input), /\b1 ficheiros\b/);
    }
  });
});

describe("cancelamento — o resto do resumo não muda", () => {
  test("completed sem filesAnalyzed continua a usar os considerados (fallback permitido)", () => {
    const text = session.buildResultSummary({
      scope: "computer",
      type: "quick",
      status: "completed",
      filesConsidered: 800,
      threatsFound: 0,
    });
    assert.match(text, /Foram analisados 800 ficheiros/);
  });

  test("o eixo de log do cancelamento fica inalterado", () => {
    const line = session.terminalScanLogMessage({
      status: "cancelled",
      filesScanned: 1,
      filesAnalyzed: 1,
      threatsFound: 0,
    } as Parameters<typeof session.terminalScanLogMessage>[0]);
    assert.match(line, /^Análise cancelada: 1 ficheiro analisado$/);
  });
});
