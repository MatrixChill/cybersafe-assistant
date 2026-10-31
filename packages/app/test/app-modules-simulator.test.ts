/**
 * TP-APP-MODULES-FREEBUFF-20261024 — Simulador.
 *
 * O runner arranca a API numa porta isolada e publica-a em
 * `window.__CYBERSAFE_API_BASE__`; o Simulador chamava `127.0.0.1:4000` à mão.
 * Numa sessão 4100, ler/gravar resultados falhava em silêncio. A base passa a
 * ser a mesma que `AuthContext`/`AIAssistant` consomem.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SimulatorPage, { placarCenarios, simulatorApiBase } from "../src/pages/SimulatorPage";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

describe("Simulador — base da API", () => {
  test("usa a base publicada pelo preload (porta isolada)", () => {
    assert.equal(
      simulatorApiBase({ __CYBERSAFE_API_BASE__: "http://127.0.0.1:4100" }),
      "http://127.0.0.1:4100",
    );
  });

  test("remove barras finais para não duplicar /api", () => {
    assert.equal(
      simulatorApiBase({ __CYBERSAFE_API_BASE__: "http://127.0.0.1:4100///" }),
      "http://127.0.0.1:4100",
    );
  });

  test("sem preload mantém a base local por omissão", () => {
    assert.equal(simulatorApiBase(undefined), "http://127.0.0.1:4000");
    assert.equal(simulatorApiBase({}), "http://127.0.0.1:4000");
  });
});

const textoDoMenu = () =>
  renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(SimulatorPage)))
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("Simulador — texto em PT-PT", () => {
  test("o menu não tem formas de PT-BR", () => {
    const t = textoDoMenu();
    assert.doesNotMatch(t, /Treine sua/);
    assert.doesNotMatch(t, /Seus Resultados/);
    assert.doesNotMatch(t, /Aprenda a reconhecer/);
    assert.doesNotMatch(t, /links perigosos/);
  });

  test("o menu fala contigo em PT-PT", () => {
    const t = textoDoMenu();
    assert.match(t, /Treina a tua capacidade de identificar ligações perigosas/);
    assert.match(t, /Aprende a reconhecer domínios lookalike/);
  });
});

describe("Simulador — placar do cenário", () => {
  test("o primeiro cenário mostra acertos sobre o total, nunca 0/0", () => {
    assert.equal(placarCenarios(0, 6), "0/6");
    assert.doesNotMatch(placarCenarios(0, 6), /^0\/0$/);
  });

  test("os acertos acompanham o total do desafio", () => {
    assert.equal(placarCenarios(3, 6), "3/6");
  });

  test("sem cenários não há fração nenhuma", () => {
    assert.equal(placarCenarios(0, 0), "—");
    assert.equal(placarCenarios(Number.NaN, 6), "0/6");
  });
});
