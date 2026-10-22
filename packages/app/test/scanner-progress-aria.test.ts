import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Mesmo arranque dos restantes testes da página: JSX clássico e sem DOM.
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { scanProgressBarModel, ScanProgressBar, default: FileScannerPage } = await import(
  "../src/pages/FileScannerPage"
);
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");

function attrs(html: string, name: string): string | null {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

describe("TP-B2 · barra de progresso determinada", () => {
  for (const percent of [0, 37, 100]) {
    test(`${percent}% tem role, nome acessível, 0/100 e now finito`, () => {
      const model = scanProgressBarModel(percent, `${percent}% analisado`);
      assert.equal(model.aria.role, "progressbar");
      assert.equal(model.aria["aria-valuemin"], 0);
      assert.equal(model.aria["aria-valuemax"], 100);
      assert.equal(model.aria["aria-valuenow"], percent);
      assert.equal(model.aria["aria-valuetext"], undefined);
      assert.match(model.aria["aria-label"], /Progresso da análise: .*analisado/);
      assert.equal(Number.isFinite(model.aria["aria-valuenow"]), true);
      assert.ok(model.aria["aria-valuenow"]! >= 0 && model.aria["aria-valuenow"]! <= 100);
    });
  }

  test("valores fora do intervalo são limitados em vez de anunciados errados", () => {
    assert.equal(scanProgressBarModel(140, "quase").aria["aria-valuenow"], 100);
    assert.equal(scanProgressBarModel(-5, "inicio").aria["aria-valuenow"], 0);
    assert.equal(scanProgressBarModel(66.6, "meio").aria["aria-valuenow"], 67);
  });

  test("o render real expõe os atributos e a largura medida", () => {
    const html = renderToStaticMarkup(
      createElement(ScanProgressBar, { bar: { percent: 42 }, label: "A analisar 42%" }),
    );

    assert.equal(attrs(html, "role"), "progressbar");
    assert.equal(attrs(html, "aria-valuemin"), "0");
    assert.equal(attrs(html, "aria-valuemax"), "100");
    assert.equal(attrs(html, "aria-valuenow"), "42");
    assert.equal(attrs(html, "aria-valuetext"), null);
    assert.match(attrs(html, "aria-label") ?? "", /Progresso da análise: A analisar 42%/);
    assert.match(html, /width:42%/);
  });

  test("o componente real desenha 0% como zero, sem barra a pulsar", () => {
    const html = renderToStaticMarkup(
      createElement(ScanProgressBar, { bar: { percent: 0 }, label: "A preparar 0%" }),
    );

    assert.equal(attrs(html, "aria-valuenow"), "0");
    assert.equal(attrs(html, "aria-valuetext"), null);
    assert.match(html, /width:0%/);
    assert.equal(/animate-pulse/.test(html), false, "0% não pode ler como indeterminado");
  });

  test("o componente real limita 140 e -5 à mesma escala do ARIA", () => {
    const acima = renderToStaticMarkup(
      createElement(ScanProgressBar, { bar: { percent: 140 }, label: "acima" }),
    );
    assert.equal(attrs(acima, "aria-valuenow"), "100");
    assert.match(acima, /width:100%/);
    assert.equal(/width:140%/.test(acima), false, "a barra não pode esticar para 140%");

    const abaixo = renderToStaticMarkup(
      createElement(ScanProgressBar, { bar: { percent: -5 }, label: "abaixo" }),
    );
    assert.equal(attrs(abaixo, "aria-valuenow"), "0");
    assert.match(abaixo, /width:0%/);
  });

  test("o componente real nunca desenha Infinity nem NaN", () => {
    for (const invalido of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const html = renderToStaticMarkup(
        createElement(ScanProgressBar, { bar: { percent: invalido }, label: "A recolher ficheiros" }),
      );

      assert.equal(attrs(html, "aria-valuenow"), null);
      assert.equal(attrs(html, "aria-valuetext"), "A recolher ficheiros");
      assert.equal(/width:\s*\d/.test(html), false, "sem medição não há largura medida");
      assert.match(html, /animate-pulse/);
    }
  });
});

describe("TP-B2 · barra de progresso indeterminada", () => {
  for (const semMedicao of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`${String(semMedicao)} não inventa percentagem e mantém texto honesto`, () => {
      const label = "A preparar a análise";
      const model = scanProgressBarModel(semMedicao, label);
      assert.equal(model.percent, null);
      assert.equal(model.aria.role, "progressbar");
      assert.equal(model.aria["aria-valuemin"], 0);
      assert.equal(model.aria["aria-valuemax"], 100);
      // Sem medição não há `aria-valuenow`: um 0 ali leria "parado a 0%".
      assert.equal(model.aria["aria-valuenow"], undefined);
      assert.equal(model.aria["aria-valuetext"], label);
    });
  }

  test("o render indeterminado não emite aria-valuenow", () => {
    const html = renderToStaticMarkup(
      createElement(ScanProgressBar, { bar: { percent: null }, label: "A recolher ficheiros" }),
    );

    assert.equal(attrs(html, "role"), "progressbar");
    assert.equal(attrs(html, "aria-valuenow"), null);
    assert.equal(attrs(html, "aria-valuetext"), "A recolher ficheiros");
    assert.equal(/width:\d/.test(html), false);
  });
});

describe("TP-B2 · sem duplicação e sem barra falsa na página idle", () => {
  test("a página sem sessão não mostra nenhuma barra de progresso", () => {
    const html = renderToStaticMarkup(
      createElement(AppearanceProvider, null, createElement(FileScannerPage, {})),
    );

    assert.equal(html.includes('role="progressbar"'), false);
  });

  test("o modelo devolve um único conjunto de atributos ARIA", () => {
    const model = scanProgressBarModel(50, "meio");
    const keys = Object.keys(model.aria).sort();
    assert.deepEqual(keys, [
      "aria-label",
      "aria-valuemax",
      "aria-valuemin",
      "aria-valuenow",
      "role",
    ]);
  });
});
