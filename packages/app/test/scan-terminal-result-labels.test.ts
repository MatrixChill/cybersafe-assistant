import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeScanState, terminalResultLabels } from "../src/lib/scanSession";

function state(overrides: Record<string, unknown> = {}) {
  return normalizeScanState({
    id: "terminal-label-test",
    type: "custom",
    status: "completed",
    progress: 100,
    filesScanned: 1,
    filesAnalyzed: 1,
    filesFailed: 0,
    filesInconclusive: 0,
    threatsFound: 0,
    ...overrides,
  })!;
}

/**
 * O cartão de RESULTADO FINAL não pode dizer "Concluída" em verde quando há
 * uma ameaça por dentro. Terminar a análise e não ter ameaças são dois factos
 * diferentes, e este contrato fixa a frase e a cor de cada combinação — é o
 * guard da frase "Análise concluída — ameaças encontradas".
 */
describe("terminalResultLabels — o resultado nunca esconde uma ameaça", () => {
  test("concluída sem ameaças: verde, só 'Concluída'", () => {
    const r = terminalResultLabels("completed", state());
    assert.equal(r.titulo, "Análise concluída");
    assert.equal(r.chip, "Concluída");
    assert.equal(r.tom, "green");
  });

  test("concluída com 1 ameaça: a ameaça está na frase e a cor não é verde", () => {
    const r = terminalResultLabels("completed", state({ threatsFound: 1 }));
    assert.match(r.titulo, /ameaças encontradas/i);
    assert.notEqual(r.chip, "Concluída");
    assert.notEqual(r.tom, "green");
    assert.equal(r.tom, "red");
  });

  test("concluída com N ameaças: idem, nunca verde", () => {
    const r = terminalResultLabels("completed", state({ threatsFound: 7 }));
    assert.match(r.titulo, /ameaças encontradas/i);
    assert.equal(r.tom, "red");
  });

  test("cancelada: amarelo", () => {
    const r = terminalResultLabels("cancelled", state({ status: "cancelled" }));
    assert.equal(r.titulo, "Análise cancelada");
    assert.equal(r.chip, "Cancelada");
    assert.equal(r.tom, "yellow");
  });

  test("falhada: vermelho, sem pretensão de conclusão", () => {
    const r = terminalResultLabels("failed", state({ status: "failed" }));
    assert.equal(r.titulo, "Análise falhada");
    assert.equal(r.chip, "Falhada");
    assert.equal(r.tom, "red");
  });

  test("concluída com resultado inconclusivo: amarelo e sem promessa de limpeza", () => {
    const r = terminalResultLabels("completed", state({ filesInconclusive: 1 }));
    assert.equal(r.titulo, "Análise concluída com verificações inconclusivas");
    assert.equal(r.chip, "Parcial");
    assert.equal(r.tom, "yellow");
  });
});
