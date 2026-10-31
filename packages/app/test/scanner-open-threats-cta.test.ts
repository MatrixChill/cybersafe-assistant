import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FileScannerPage from "../src/pages/FileScannerPage";

/**
 * UI-B (TP-PAP-UI-FUNCTIONAL-20261028, Qoder) — o resultado com deteções precisa
 * de um caminho para Ameaças, não só de uma instrução.
 *
 * Na base desta lane, `scanSession.ts:893-896` mandava o utilizador «revistar as
 * ameaças na página Ameaças» e o cartão terminal (`FileScannerPage.tsx:1280-1345`)
 * não tinha affordance nenhum: o único botão era «Nova análise». Não existe
 * router no renderer (sem `location.hash`, sem react-router) — quem muda a página
 * é o `App.tsx` por `setPage`. Por isso o botão vive atrás de um prop que o Codex
 * liga: `onOpenThreats?: () => void`.
 *
 * O que NÃO prova: que o `App.tsx` já passa o callback (fora da minha scope) e o
 * estado terminal renderizado — `renderToStaticMarkup` não corre efeitos nem
 * define estado, logo o cartão terminal não é alcançável em SSR. Aí a verificação
 * é estrutural, e diz-se.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const fontePagina = readFileSync(new URL("../src/pages/FileScannerPage.tsx", import.meta.url), "utf8");

describe("contrato do prop", () => {
  test("é opcional e o página abre sem ele", () => {
    assert.match(fontePagina, /onOpenThreats\?: \(\) => void;/);
    const html = renderToStaticMarkup(createElement(FileScannerPage, {}));
    assert.ok(!html.includes("Ver as"), "sem callback não se promete um destino");
    assert.match(html, /O que pretende analisar\?/);
  });
});

describe("gating do botão (estrutural)", () => {
  test("só aparece com callback E deteções medidas", () => {
    assert.match(fontePagina, /\{onOpenThreats && \(scanProgress\.threatsFound \?\? 0\) > 0 && \(/);
    const botoes = fontePagina.match(/onClick=\{onOpenThreats\}/g) ?? [];
    assert.equal(botoes.length, 1, "um único affordance");
  });

  test("o número no botão é o que o serviço reportou, não uma contagem nossa", () => {
    assert.match(fontePagina, /Ver as \{scanProgress\.threatsFound\} deteções em Ameaças/);
  });

  test("o botão vive dentro do cartão terminal, não no estado idle", () => {
    const inicioTerminal = fontePagina.indexOf("{isTerminal && scanProgress && (() => {");
    const inicioIdle = fontePagina.indexOf('{uiStatus === "idle" && (');
    const sítioBotao = fontePagina.indexOf("onClick={onOpenThreats}");
    assert.ok(inicioTerminal > 0 && inicioIdle > 0, "os dois blocos existem");
    assert.ok(sítioBotao > inicioTerminal && sítioBotao < inicioIdle, "o botão só no resultado");
  });

  test("não acrescenta movimento nem cor literal (regra do bloco do Scanner)", () => {
    const bloco = fontePagina.slice(
      fontePagina.indexOf("onClick={onOpenThreats}") - 400,
      fontePagina.indexOf("onClick={onOpenThreats}") + 400,
    );
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(bloco), "tokens, não cores literais");
    assert.ok(!/animate-|transition-transform|scale-\[/.test(bloco), "sem movimento novo");
  });
});
