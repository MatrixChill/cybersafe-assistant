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

const render = (dashboard: Partial<DashboardSummary>) =>
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

describe("Fase B — Dashboard nunca mostra score nao medido", () => {
  test("riskScore null (sem leitura do servico): nenhum numero no hero, legenda 'sem leitura'", () => {
    const html = render({ riskScore: null });
    assert.match(html, /sem leitura/, "a legenda do score diz o facto: nao ha leitura");
    assert.doesNotMatch(html, /\/100/, "nao se mostra denominador de um score inexistente");
    // O valor do hero e o traco, nunca 0 ou 100 inventados.
    assert.match(html, /tabular-nums[^"]*">—/);
  });

  test("riskScore medido mantem o numero e o denominador", () => {
    const html = render({ riskScore: 78, systemStatus: "safe" });
    assert.match(html, /\/100/);
  });

  test("superficies do Dashboard usam tokens do tema, nao branco hardcoded (modo claro)", () => {
    // bg-white/... e border-white/... eram invisiveis nos temas claros e
    // ignoravam os tokens — o design system proibe hex/cor crua em superficies.
    const files = ["../src/pages/DashboardPage.tsx", "../src/components/ProtectionDetails.tsx"];
    for (const file of files) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.doesNotMatch(src, /bg-white\/|border-white\/|hover:bg-white\//, `${file} tem cor crua white/[..] em superficies`);
    }
  });
});
