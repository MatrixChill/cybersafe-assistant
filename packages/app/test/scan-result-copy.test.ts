import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as session from "../src/lib/scanSession";
const conciseResultSummary = (input: Parameters<typeof session.buildResultSummary>[0]): string => {
  assert.equal(typeof session.conciseResultSummary, "function", "o resumo simples deve estar disponível");
  return session.conciseResultSummary(input);
};

const completed = {
  scope: "computer",
  type: "quick",
  status: "completed",
  filesConsidered: 800,
  filesAnalyzed: 647,
  filesExcluded: 153,
  filesFailed: 0,
  filesInconclusive: 0,
  threatsFound: 0,
} as const;

describe("resumo simples da análise rápida", () => {
  test("limita a ausência de deteções aos analisados e explica exclusões uma vez", () => {
    const text = conciseResultSummary(completed);
    assert.equal(text, "Não foram detetadas ameaças nos 647 ficheiros analisados. Outros 153 ficaram fora da análise pelas regras de exclusão.");
    assert.equal((text.match(/647/g) ?? []).length, 1);
    assert.equal((text.match(/153/g) ?? []).length, 1);
    assert.doesNotMatch(text, /800|motores|100%|computador seguro/i);
  });
  test("ameaças têm prioridade sobre a contagem de ficheiros", () => {
    assert.match(conciseResultSummary({ ...completed, threatsFound: 2 }), /^Foram detetadas 2 ameaças nos 647 ficheiros analisados./);
    assert.match(conciseResultSummary({ ...completed, filesConsidered: 1, filesAnalyzed: 1, filesExcluded: 0, threatsFound: 1 }), /^Foi detetada 1 ameaça no ficheiro analisado./);
  });
  test("nenhum ficheiro analisado não equivale a ausência de ameaças", () => {
    const text = conciseResultSummary({ ...completed, filesAnalyzed: 0, filesExcluded: 800 });
    assert.match(text, /^Nenhum ficheiro foi analisado./);
    assert.doesNotMatch(text, /não foram detetadas ameaças/i);
  });
  test("base desconhecida não reutiliza os considerados como analisados", () => {
    const text = conciseResultSummary({ ...completed, filesAnalyzed: undefined });
    assert.match(text, /não indicou quantos ficheiros foram analisados/);
    assert.doesNotMatch(text, /800 ficheiros analisados|não foram detetadas ameaças/i);
  });
  test("falhas e exclusão singular são explicadas sem linguagem de motor", () => {
    const text = conciseResultSummary({ ...completed, filesConsidered: 650, filesExcluded: 1, filesFailed: 2 });
    assert.match(text, /Outro ficheiro ficou fora da análise pelas regras de exclusão./);
    assert.match(text, /Não foi possível analisar 2 ficheiros./);
  });
  test("cancelamento e erro não apresentam conclusão limpa", () => {
    assert.match(conciseResultSummary({ ...completed, status: "cancelled" }), /^Análise cancelada/);
    assert.match(conciseResultSummary({ ...completed, status: "failed", error: "sem ligação" }), /Não foi possível concluir/);
  });
});
