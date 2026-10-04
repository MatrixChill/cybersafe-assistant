import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `tsx` compila o JSX com runtime clássico (React.createElement) — o global
// abaixo satisfaz-o fora do Vite (mesmo padrão de task-manager-page.test.ts).
(globalThis as Record<string, unknown>).React = React;
// AppearanceProvider lê localStorage nos inicializadores de estado, mesmo no
// render servidor. Sem DOM, é o stub mínimo honesto (nada persistido).
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: FileScannerPage } = await import("../src/pages/FileScannerPage");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { NO_DETECTIONS_NOTE, SCAN_RESULT_LABELS } = await import("../src/lib/scanSession");

/**
 * Render a sério do Scanner SEM qualquer sessão (estado inicial real ao abrir
 * a página): o react-dom/server não corre efeitos, logo o mount é exatamente
 * o caso "idle / sem dados" do sprint 02/10. A regra crítica exige que nenhuma
 * tranquilização de resultado exista aqui; o gate dos restantes estados
 * terminais vive em `showNoThreatsReassurance` (coberto em scan-session.test.ts
 * e usado diretamente pelo JSX).
 */
function renderIdle(): string {
  return renderToStaticMarkup(
    createElement(AppearanceProvider, null, createElement(FileScannerPage, {})),
  );
}

describe("FileScannerPage — idle/sem dados renderizado", () => {
  const html = renderIdle();

  test("mostra o painel de escolha com as quatro análises", () => {
    assert.match(html, /O que pretende analisar\?/);
    assert.match(html, /Análise Rápida do Computador/);
    assert.match(html, /Análise Profunda do Computador/);
    assert.match(html, /Analisar um Ficheiro/);
    assert.match(html, /Analisar uma Pasta/);
  });

  test("não mostra cartão nem frase de tranquilização sem scan terminado", () => {
    assert.equal(html.includes(SCAN_RESULT_LABELS.filesWithoutDetections), false);
    assert.equal(html.includes("Análise concluída"), false);
    assert.equal(html.includes(NO_DETECTIONS_NOTE), false);
    assert.equal(/sem ameaças detetadas/i.test(html), false);
    assert.equal(/não foram encontradas ameaças/i.test(html), false);
  });

  test("não mostra painel de resultado sem dados do motor", () => {
    assert.equal(html.includes(SCAN_RESULT_LABELS.threatsFound), false);
    assert.equal(html.includes(SCAN_RESULT_LABELS.filesChecked), false);
  });
});
