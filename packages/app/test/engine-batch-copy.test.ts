/**
 * TASK C — a copy do batch do ClamAV na UI.
 *
 * O backend passou a publicar `filesInEngineBatch` (quantos ficheiros estão
 * dentro do ÚNICO clamscan, que demora ~7,6 s a carregar ~1 GB de base). Sem a
 * UI o usar, o campo é inerte — e a UI continuava a dizer "A verificar os
 * ficheiros encontrados" durante sete segundos sem ter verificado nada.
 *
 * Estes testes fixam três coisas:
 *   1. durante o batch, a copy é verdadeira e nomeia o número real;
 *   2. a copy NUNCA inventa um progresso por ficheiro (nada de "1/5", "2/5");
 *   3. quando o batch acaba, a copy volta ao normal.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { activeScanDetail, normalizeScanState, mergeScanState } = await import(
  "../src/lib/scanSession"
);

const base = {
  id: "s1",
  type: "custom",
  status: "running",
  phase: "scanning",
  progress: 0,
};

describe("TASK C — copy do batch do ClamAV", () => {
  test("durante o batch, a copy diz quantos ficheiros estão dentro do clamscan", () => {
    const detail = activeScanDetail("folder", "custom", "scanning", "pasta", 20);
    assert.match(
      detail,
      /20 ficheiros/,
      `a copy tem de dizer o número real (veio: ${detail})`,
    );
    assert.match(
      detail,
      /uma só vez|de uma só vez/i,
      `a copy tem de explicar que é UMA passagem (veio: ${detail})`,
    );
  });

  test("a copy NÃO inventa progresso por ficheiro", () => {
    for (const n of [1, 5, 20]) {
      const detail = activeScanDetail("folder", "custom", "scanning", "pasta", n);
      assert.doesNotMatch(
        detail,
        /\b\d+\s*\/\s*\d+/,
        `"1/5" é progresso inventado — o batch não produz progresso por ficheiro (veio: ${detail})`,
      );
    }
  });

  test("singular e plural estão correctos (PT-PT)", () => {
    assert.match(activeScanDetail("folder", "custom", "scanning", "p", 1), /1 ficheiro\b/);
    assert.match(activeScanDetail("folder", "custom", "scanning", "p", 5), /5 ficheiros\b/);
  });

  test("sem batch, a copy volta ao texto normal de 'scanning'", () => {
    const detail = activeScanDetail("folder", "custom", "scanning", "pasta", 0);
    assert.match(detail, /A verificar os ficheiros encontrados na pasta\./);
    assert.doesNotMatch(detail, /motor de assinaturas/);
  });

  test("o estado normalizado TRANSPORTA o campo (senão o patch é inerte)", () => {
    const state = normalizeScanState({ ...base, filesInEngineBatch: 20 });
    assert.equal(state?.filesInEngineBatch, 20, "o campo tem de chegar ao renderer");
  });

  test("ao fazer merge, o batch VOLTA A ZERO (não fica preso em keepMax)", () => {
    const comBatch = normalizeScanState({ ...base, filesInEngineBatch: 20, filesScanned: 0 })!;
    const semBatch = normalizeScanState({ ...base, filesInEngineBatch: 0, filesScanned: 0 })!;
    const merged = mergeScanState(comBatch, semBatch);
    assert.equal(
      merged.filesInEngineBatch,
      0,
      "a UI não pode ficar presa a dizer '20 ficheiros' depois do batch acabar",
    );
  });

  test("o merge NÃO deixa os contadores monotónicos recuarem", () => {
    const antes = normalizeScanState({ ...base, filesAnalyzed: 3, filesFailed: 1 })!;
    const depois = normalizeScanState({ ...base, filesAnalyzed: 3, filesFailed: 0 })!;
    const merged = mergeScanState(antes, depois);
    assert.equal(merged.filesAnalyzed, 3);
    assert.equal(merged.filesFailed, 1, "os contadores que só sobem ficam presos no máximo");
  });
});
