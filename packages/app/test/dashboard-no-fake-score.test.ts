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
        // Migração V2-FIRST: estes casos falam do que o SERVIÇO devolveu (score
        // lido = null, ou lido = 78). Logo a ligação está confirmada; `false`
        // mudaria o que está em teste.
        serviceConnected: true,
      }),
    ),
  );

describe("Fase B — Dashboard nunca mostra score nao medido", () => {
  test("riskScore null (sem leitura do servico): nenhum numero no hero, legenda 'sem leitura'", () => {
    const html = render({ riskScore: null });
    assert.match(html, /Sem leitura/, "a legenda do score diz o facto: nao ha leitura");
    assert.doesNotMatch(html, /\/100/, "nao se mostra denominador de um score inexistente");
    // O valor do hero era o traço de V1 (`tabular-nums">—`). Em V2 a ausência é
    // dita por letras, junto do rótulo canónico, e nenhum dígito aparece na
    // secção da pontuação.
    const secção = /<h3>Pontuação de proteção<\/h3><p>([^<]*)/.exec(html);
    assert.ok(secção, "a secção de pontuação existe e está rotulada");
    assert.equal(/\d/.test(secção![1]), false, `nenhum número pode aparecer: "${secção![1]}"`);
  });

  test("riskScore medido mantem o numero e o denominador", () => {
    const html = render({ riskScore: 78, systemStatus: "safe" });
    assert.match(html, /78\/100/);
  });

  test("superficies do Dashboard usam tokens do tema, nao branco hardcoded (modo claro)", () => {
    // bg-white/... e border-white/... eram invisiveis nos temas claros e
    // ignoravam os tokens — o design system proibe hex/cor crua em superficies.
    // O alvo é agora a cadeia que se vê: contentor + composição + diagnóstico.
    const files = [
      "../src/pages/DashboardPage.tsx",
      "../src/v2/dashboard/LabDashboard.tsx",
      "../src/v2/dashboard/LabDiagnostics.tsx",
      "../src/components/ProtectionDetails.tsx",
    ];
    for (const file of files) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.doesNotMatch(src, /bg-white\/|border-white\/|hover:bg-white\//, `${file} tem cor crua white/[..] em superficies`);
    }
  });
});
