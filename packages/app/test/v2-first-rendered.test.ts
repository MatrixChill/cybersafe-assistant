import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LabDashboard from "../src/v2/dashboard/LabDashboard";
import LabSidebar from "../src/v2/LabSidebar";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";
import type { DashboardSummary } from "@cybersafe/shared-types";
Object.assign(globalThis, {
  React,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});
const dashboard: DashboardSummary = {
  riskScore: null,
  totalEvents: 0,
  highSeverityEvents: 0,
  downloadRisk: "low",
  recentThreats: [],
  alerts: [],
  systemStatus: "degraded",
};
const render = (extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(LabDashboard, {
        dashboard,
        isLoading: false,
        history: { phase: "sem_confirmacao", entry: null },
        ...extra,
      }),
    ),
  ).replace(/<!--[\s\S]*?-->/g, "");
test("the rendered V2 page never turns missing engine data into a measured zero count", () => {
  const html = render({ serviceConnected: true });
  assert.doesNotMatch(html, /0 de 4/);
  assert.match(html, /Motores sem leitura/);
  assert.equal(
    (html.match(/data-engine="(?:yara|hashDb|clamav|nativeEngine)"/g) ?? [])
      .length,
    4,
  );
});
test("explicit quick/full/folder commands remain available without starting on navigation", () => {
  const html = render({ serviceConnected: true, onScan: () => {} });
  for (const kind of ["quick", "full", "custom"])
    assert.match(html, new RegExp(`data-testid="scan-${kind}"`));
});
test("pending and protection error survive closing the control modal", () => {
  const html = render({
    protectionPending: "starting",
    protectionError: "Pedido recusado pelo serviço",
  });
  assert.match(html, /A ativar/);
  assert.match(html, /Pedido recusado pelo serviço/);
  assert.match(html, /role="alert"/);
});
test("the real new sidebar preserves collapsed accessibility and feature permissions", () => {
  for (const collapsed of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(LabSidebar, {
        activePage: "dashboard",
        onNavigate: () => {},
        defaultCollapsed: collapsed,
        user: { name: "Teste", type: "personal", plan: "free" } as never,
      }),
    );
    assert.match(html, /data-cs-sidebar="main"/);
    assert.match(html, /aria-label="Análise de Segurança"/);
    assert.doesNotMatch(html, />Business Center</);
    assert.match(html, new RegExp(`data-collapsed="${collapsed}"`));
  }
});
test('a GPU reported absent never becomes a measured 0 percent',()=>{
 const html=render({serviceConnected:true,hardware:{gpu:{available:false,usagePercent:0}}});assert.match(html,/>GPU<\/span><strong>Não detetada<\/strong>/);
});
test("GPU presence, idle, missing data and offline remain distinct", () => {
  for (const [hardware, connected, expected] of [
    [{ gpu: { available: false, usagePercent: 0 } }, true, "Não detetada"],
    [{ gpu: { available: true, usagePercent: 0, usageStatus: "available" } }, true, "0%"],
    [{ gpu: null }, true, "Sem leitura da GPU"],
    [{ gpu: { available: false, usagePercent: 0 } }, false, "Sem leitura da GPU"],
  ] as const) {
    const html = render({ hardware, serviceConnected: connected });
    assert.ok(html.includes(`<span>GPU</span><strong>${expected}</strong>`), `GPU expected ${expected}`);
  }
});
test("missing or nonfinite risk score never prints undefined or an invented score", () => {
  for (const riskScore of [undefined, null, NaN, Infinity]) {
    const html = render({ dashboard: { ...dashboard, riskScore }, serviceConnected: true });
    assert.doesNotMatch(html, /undefined\/100|NaN\/100|Infinity\/100/);
    assert.match(html, /Sem leitura/);
  }
});
test("unconfirmed history stays different from a confirmed empty history", () => {
  const unknown = render();
  const empty = render({ history: {phase: "pronto", entry: null} });
  assert.match(unknown, /Leitura não confirmada/);
  assert.doesNotMatch(unknown, /O serviço confirmou uma lista vazia/);
  assert.match(empty, /O serviço confirmou uma lista vazia/);
});
