import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary } from "@cybersafe/shared-types";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: DashboardPage } = await import("../src/pages/DashboardPage");
const { default: MonitorPage } = await import("../src/pages/MonitorPage");

const renderDashboard = (dashboard: Partial<DashboardSummary>) =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(DashboardPage, {
        dashboard: {
          totalEvents: 0,
          highSeverityEvents: 0,
          downloadRisk: "low",
          recentThreats: [],
          alerts: [],
          systemStatus: "degraded",
          ...dashboard,
        } as unknown as DashboardSummary,
        isLoading: false,
      }),
    ),
  );

const renderMonitor = () =>
  renderToStaticMarkup(
    createElement(MonitorPage, {
      events: [],
      processes: [],
      connections: [],
      protection: null,
      quarantine: [],
    }),
  );

const readSource = (relative: string) =>
  readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8");

describe("Polimento visual — Painel", () => {
  const html = renderDashboard({ riskScore: 60 });

  /**
   * Migração V2-FIRST (mapa em `out/MAPA-TESTES-V2-FIRST.md`): `summary-cards`,
   * `stat-card` e a faixa de cinco caixas (`surface-lift` / `lg:grid-cols-5`)
   * eram geometria de V1 e saíram por decisão explícita do proprietário. A
   * intenção de polimento que elas protegiam — grelhas de colunas IGUAIS e não
   * filas flexíveis, cartões com a mesma estrutura, vidro vindo do eixo e não de
   * classes fixas — passa a ser cobrada sobre a composição do lab:
   * `.dashboard-top`, `.engine-grid`, `.dashboard-bottom`.
   */
  const FOLHA = readSource("v2/dashboard/lab-dashboard.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const regra = (seletor: string) => {
    const i = FOLHA.indexOf(seletor);
    assert.ok(i >= 0, `faltou a regra de ${seletor}`);
    return FOLHA.slice(i, FOLHA.indexOf("}", i)).replace(/\s+/g, " ");
  };

  test("as três grelhas do Painel são de colunas, não filas flexíveis", () => {
    assert.match(html, /class="dashboard-top"/);
    assert.match(html, /data-testid="engine-grid"/);
    assert.match(html, /class="dashboard-bottom"/);
    for (const seletor of [".cs-v2 .v2-dashboard .dashboard-top", ".cs-v2 .v2-dashboard .engine-grid", ".cs-v2 .v2-dashboard .dashboard-bottom"]) {
      const corpo = regra(seletor);
      assert.match(corpo, /display: *grid/, `${seletor}: a grelha é grid, não uma fila com wrap`);
      assert.match(corpo, /grid-template-columns:/, `${seletor}: as colunas são declaradas`);
      assert.doesNotMatch(corpo, /flex-wrap/, `${seletor}: fila flexível não pode voltar`);
    }
    assert.doesNotMatch(html, /data-testid="summary-cards"|class="stat-card/, "a geometria de V1 não coexiste com a do lab");
  });

  test("os quatro cartões de motor têm a mesma estrutura, com o valor destacado", () => {
    assert.equal((html.match(/class="[^"]*\bengine-card\b/g) ?? []).length, 4, "quatro motores, nem mais nem menos");
    for (const parte of ["engine-symbol", "engine-resource", "engine-bottom"]) {
      assert.equal((html.match(new RegExp(`class="${parte}"`, "g")) ?? []).length, 4, `cada cartão tem de ter ${parte}`);
    }
    assert.equal((html.match(/<h3>/g) ?? []).length >= 4, true, "o nome do motor destaca-se em cada cartão");
  });

  test("o vidro vem do eixo, não de classes fixas no componente", () => {
    // Em V2 o eixo vive no `<html>` (`data-v2-material`) e a folha lê
    // `--v2-material-blur`; o markup do Painel não pode escrever o atributo de
    // V1 (`data-material`), que é global em `index.css` e voltou a pintar o
    // contentor por cima do tema.
    assert.doesNotMatch(html, /data-material=/, "o atributo de eixo de V1 voltou ao markup do Painel");
    const source = readSource("v2/dashboard/LabDashboard.tsx");
    for (const [nome, texto] of [["LabDashboard", source], ["lab-dashboard.css", FOLHA]] as const) {
      assert.doesNotMatch(texto, /backdrop-blur-/, `${nome}: literal de desfoque em vez do eixo`);
      assert.doesNotMatch(texto, /surface-translucent/, `${nome}: superfície de V1 dentro do Painel V2`);
    }
    assert.match(FOLHA, /var\(--v2-material-blur\)/, "o desfoque vem da variável do eixo");
  });

  test("a proveniência dos números é uma linha, não cinco caixas", () => {
    // Uma só legenda, no hero, e com as duas formas possíveis: relatório lido,
    // ou ausência dele dita. O que não é permitido é a antiga faixa de cinco
    // caixas voltar a lado da legenda.
    const caption = /class="caption">([^<]*)</.exec(html)?.[1] ?? "";
    assert.match(
      caption,
      /^(Relatório do serviço · \d+ de 4 sem degradação reportada|Motores sem leitura)$/,
      `a legenda do hero não é uma proveniência única: "${caption}"`,
    );
    assert.doesNotMatch(html, /class="surface-lift|lg:grid-cols-5/, "a faixa de cinco caixas de V1 não volta");
  });

  test("sem leitura continua a dizer 'Sem leitura' e não zero", () => {
    const semLeitura = renderDashboard({ riskScore: null });
    assert.match(semLeitura, /Sem leitura/);
    assert.doesNotMatch(semLeitura, /\b0\/100\b/, "zero não é ausência de leitura");
  });
});

describe("Polimento visual — Monitor", () => {
  const html = renderMonitor();

  test("o título do painel é humano, não o nome técnico do ficheiro", () => {
    assert.match(html, /Histórico de eventos/);
    assert.match(html, /<details class="ml-auto text-right"/);
  });

  test("o nome técnico permanece consultável dentro dos detalhes", () => {
    const details = html.slice(html.indexOf('<details class="ml-auto text-right"'));
    assert.match(details, /Detalhes técnicos/);
    assert.match(details, /security_event_bus\.log/);
  });

  test("o cabeçalho deixa de apresentar o ficheiro como título", () => {
    assert.doesNotMatch(
      html,
      /font-semibold text-foreground">\s*<svg[\s\S]{0,400}?<\/svg>\s*security_event_bus\.log/,
    );
  });
});

describe("Polimento visual — PC Center", () => {
  const page = readSource("pages/PCCenterPage.tsx");
  const health = readSource("components/PCHealthSection.tsx");

  test("os três domínios têm etiqueta própria", () => {
    assert.match(page, />Achados do sistema</);
    assert.match(page, />Carga de desempenho</);
    assert.match(health, />Avaliação com dados do Windows</);
  });

  test("o estresse fica num bloco separado do veredicto", () => {
    assert.match(page, /mt-8 flex w-full flex-col items-center border-t border-border pt-4/);
  });

  test("os valores medidos continuam iguais — nada é recalculado na UI", () => {
    assert.match(page, /\{hardware\.stressScore\}\/100/);
    assert.match(health, /\{health\.score\}/);
  });
});

describe("Polimento visual — escopo", () => {
  test("nenhuma página importa CSS: o delta é scoped e o index.css continua read-only", () => {
    for (const file of ["pages/DashboardPage.tsx", "pages/PCCenterPage.tsx", "pages/MonitorPage.tsx", "components/PCHealthSection.tsx"]) {
      assert.doesNotMatch(readSource(file), /import\s+["'][^"']+\.css["']/, `${file} importa CSS`);
    }
  });
});
