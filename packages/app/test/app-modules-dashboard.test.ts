/**
 * TP-APP-MODULES-FREEBUFF-20261024 — Dashboard.
 *
 * Dois factos que a UI não pode inventar:
 *  - o Painel não é um router. Um `<a href="/threats">` dentro do Electron sai
 *    do renderer e não abre a página Ameaças; o histórico tem de ser apontado
 *    para a navegação real (barra lateral), não para um URL que não existe;
 *  - sem ligação ao serviço, os números do último snapshot são a última
 *    leitura conhecida — não um estado atual. O ecrã tem de o dizer.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary } from "@cybersafe/shared-types";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";
import DashboardPage from "../src/pages/DashboardPage";

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const dashboard: DashboardSummary = {
  riskScore: 78,
  totalEvents: 3,
  highSeverityEvents: 1,
  downloadRisk: "low",
  recentThreats: [],
  alerts: [],
  systemStatus: "safe",
};

const render = (extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(DashboardPage, { dashboard, isLoading: false, ...extra }),
    ),
  );

const texto = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** A etiqueta do botão, para se ler o atributo `disabled` e não as classes `disabled:*`. */
const botao = (html: string, id: string) => {
  const encontrado = html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`));
  assert.ok(encontrado, `botão ${id} não está no ecrã`);
  return encontrado[0];
};

const desativado = (etiqueta: string) => /\sdisabled(?:=|\s|>)/.test(etiqueta);

describe("Dashboard — navegação", () => {
  test("não aponta para um href de página que o Electron não serve", () => {
    const html = render({ serviceConnected: true, onOpenScanner: () => {} });
    // O Painel não é router: nenhuma âncora de URL. Em V1 a indicação de onde
    // ir era texto («Ameaças, na barra lateral»); em V2 é o callback do App, e
    // a regra continua a mesma — sair do renderer por href morre no Electron.
    assert.doesNotMatch(html, /href="\/threats"/, "o link absoluto sai do renderer e morre");
    assert.doesNotMatch(html, /href="\/[a-z]/, "nenhum caminho de página em href");
    assert.doesNotMatch(html, /<a\s/, "o Painel não tem âncoras de documento");
    assert.match(html, /Consultar resultados/, "a única saída é o callback de navegação");
    assert.doesNotMatch(html, /Nova análise<\/button>[\s\S]{0,80}href=/, "o CTA não pode ser um link");
  });
});

describe("Dashboard — ligação ao serviço", () => {
  test("sem ligação, declara que os números são a última leitura conhecida", () => {
    const html = render({ serviceConnected: false });
    const t = texto(html);
    assert.match(t, /Sem ligação ao serviço/i);
    assert.match(t, /última leitura conhecida/i);
    assert.match(t, /não (é|são) um estado atual/i);
  });

  test("com ligação, não mostra o aviso de leitura antiga", () => {
    const t = texto(render({ serviceConnected: true }));
    assert.doesNotMatch(t, /última leitura conhecida/i);
  });

  test("sem callback de análise, os botões não fingem estar acionáveis", () => {
    const html = render();
    assert.equal(desativado(botao(html, "scan-quick")), true, "sem onScan o clique não pode existir");
    assert.equal(desativado(botao(html, "scan-full")), true);
  });

  test("com callback e serviço ligado, a análise rápida fica acionável", () => {
    const html = render({ onScan: () => {}, serviceConnected: true });
    assert.equal(desativado(botao(html, "scan-quick")), false);
  });
});

