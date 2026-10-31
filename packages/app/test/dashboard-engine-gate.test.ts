/**
 * TP-3H-DASHBOARD-FIX — o gate de motores no hero do Dashboard.
 *
 * Regressão do P0: com `riskScore` medido e SEM `engineHealth`, a UI
 * apresentava contagem e teto INVENTADOS ("0 de 4 motores ativos · teto 25"),
 * porque `explainProtectionScore(score, undefined)` assume 4 motores
 * indisponíveis. Com `engineHealth` presente, a contagem medida aparece.
 *
 * Teste final integrável: caminho canónico (`../src/pages/DashboardPage`),
 * sem variáveis de ambiente e sem import dinâmico.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";
import DashboardPage from "../src/pages/DashboardPage";
import { explainProtectionScore } from "../src/lib/protectionHealth";
import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** Fixture TIPADA: campos obrigatórios de `EngineHealth` presentes, sem `as unknown as`. */
const ENGINE: EngineHealth = {
  serviceRunning: true,
  osLayerHealthy: true,
  degradedReasons: [],
  monitoredPaths: [],
  yara: { status: "active" },
  hashDb: { status: "active" },
  clamav: { status: "active" },
  nativeEngine: { status: "active" },
};

const base: DashboardSummary = {
  riskScore: 78,
  totalEvents: 0,
  highSeverityEvents: 0,
  downloadRisk: "low",
  recentThreats: [],
  alerts: [],
  systemStatus: "degraded",
};

function render(dashboard: DashboardSummary): string {
  return renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      // Migração V2-FIRST: fixture de dados CONFIRMADOS ⇒ `serviceConnected:
      // true`. Sem ligação confirmada a página diz «Motores sem leitura» — que é
      // verdade para esse estado, mas não é o estado que este teste fixa.
      createElement(DashboardPage, { dashboard, isLoading: false, serviceConnected: true }),
    ),
  );
}

/** Texto sem os separadores de comentário que o React SSR insere entre expressões. */
const texto = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/\s+/g, " ").trim();

test("Dashboard sem engineHealth: nenhuma contagem nem teto inventados", () => {
  const t = texto(render(base));
  assert.match(t, /78\/100/, "o score medido tem de aparecer");
  assert.doesNotMatch(t, /motores ativos/, "sem engines não há contagem de motores");
  assert.doesNotMatch(t, /0 de 4/, "contagem 0 de 4 é inventada");
  assert.doesNotMatch(t, /teto 25/, "teto 25 é inventado");
  assert.match(t, /Motores sem leitura/, "fallback de estado sem leitura");
});

test("Dashboard com engineHealth tipado: a contagem medida aparece", () => {
  const info = explainProtectionScore(78, ENGINE);
  const t = texto(render({ ...base, engineHealth: ENGINE }));
  assert.match(
    t,
    new RegExp(`${info.activeEngines} de ${info.totalEngines} motores ativos . máximo possível ${info.maxPossible}`),
    `contagem medida em falta (esperado ${info.activeEngines} de ${info.totalEngines} · máximo possível ${info.maxPossible})`,
  );
  assert.doesNotMatch(t, /Motores sem leitura/, "com engines não há fallback de ausência");
});
