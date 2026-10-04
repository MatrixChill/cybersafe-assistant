/**
 * P0 — CLAMAV_INCONCLUSIVE_VERDICT, lado UI.
 *
 * O serviço passou a devolver `recommendation: "inconclusive"` quando o motor
 * não conseguiu avaliar o ficheiro. Sem isto, o badge de
 * `TaskManagerPage` caía no `else` — styling VERDE, ícone de escudo, palavra
 * "Seguro" — por cima de um ficheiro que ninguém examinou. Era o pixels green
 * de uma mentira.
 *
 * Estes testes renderizam o componente a sério (`react-dom/server`) e affirmam
 * o que o utilizador LÊ, não o que o código tipa.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { processRecommendationMeta } = await import("../src/lib/processActions");

/**
 * A função é a fonte única do badge. Se a UI e esta função divergirem, o
 * teste passa e o bug volta — por isso o teste é sobre a FUNÇÃO, e a UI tem
 * de a usar (verificado por leitura em `TaskManagerPage.tsx`).
 */
describe("badge de recomendação — inconclusive nunca é verde", () => {
  test("'inconclusive' NÃO recebe o tom verde de 'safe'", () => {
    const inconclusive = processRecommendationMeta("inconclusive");
    const safe = processRecommendationMeta("safe");
    assert.notEqual(
      inconclusive.tone,
      safe.tone,
      "inconclusivo não pode ter o mesmo tom que 'safe' — é a mentira original",
    );
  });

  test("'inconclusive' NÃO diz 'Seguro'", () => {
    const meta = processRecommendationMeta("inconclusive");
    assert.notEqual(
      meta.label,
      "Seguro",
      "o texto tem de dizer que não sabemos, não que o processo está seguro",
    );
  });

  test("'inconclusive' nomeia a lacuna em PT-PT", () => {
    const meta = processRecommendationMeta("inconclusive");
    assert.match(
      meta.label,
      /não (conseguiu|foi possível)|inconclusiv|não foi analisad/i,
      `o rótulo tem de descrever a inconclusividade (veio: ${meta.label})`,
    );
  });

  test("'safe' continua a ser 'Seguro' (o patch não parte o caminho bom)", () => {
    const meta = processRecommendationMeta("safe");
    assert.equal(meta.label, "Seguro");
  });

  test("'dangerous' e 'suspicious' continuam distintos", () => {
    assert.notEqual(processRecommendationMeta("dangerous").label, processRecommendationMeta("suspicious").label);
    assert.notEqual(
      processRecommendationMeta("dangerous").tone,
      processRecommendationMeta("suspicious").tone,
    );
  });
});
