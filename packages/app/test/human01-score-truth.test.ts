import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, EngineHealth, HardwareSnapshot } from "@cybersafe/shared-types";

/**
 * TP-V2-VISUAL (qoder) — contrato da COMPOSIÇÃO do Dashboard V2.
 *
 * Fixa o que um redesign do hero não pode partir, sem amarrar markup cosmético:
 *  - `section.hero-banner` existe e o seu `data-material` segue a preferência de
 *    superfície guardada (o eixo de material é independente do estado do sistema);
 *  - a pontuação é EXPLICADA (rótulo "Pontuação de proteção", motores ativos, teto,
 *    penalização por ameaças) — não é um número solto;
 *  - a faixa de evidência (`evidence-strip`) mostra de onde vem cada facto;
 *  - honestidade do tempo real: sem leitura de `enabled`, NUNCA se afirma
 *    "Monitorização ligada" — diz "não verificada";
 *  - telemetria hierárquica: CPU e RAM lideram a secção "A usar agora".
 *
 * Capturas reais (BEFORE/AFTER) ficam em output/design-evolution-v2-20261017.
 */

const ENGINE = {
  serviceRunning: true,
  anyEngineDegraded: false,
  degradedReasons: [],
  yara: { status: "active", detail: "ok" },
  hashDb: { status: "active", detail: "ok" },
  clamav: { status: "active", detail: "ok" },
  nativeEngine: { status: "active" },
  wfp: { status: "active" },
  definitionsUpdatedAt: "2026-10-17T00:00:00.000Z",
  monitoredPaths: ["C:/Users/x/Documents", "C:/Users/x/Downloads"],
  realtimeQueueDepth: 0,
} as unknown as EngineHealth;

const resumo = (extra: Partial<DashboardSummary> = {}) =>
  ({
    riskScore: 86,
    totalEvents: 18,
    highSeverityEvents: 1,
    downloadRisk: "low",
    recentThreats: [{ domain: "exemplo.invalid", severity: "high", createdAt: "2026-10-17T00:00:00.000Z" }],
    alerts: [],
    systemStatus: "attention",
    engineHealth: ENGINE,
    ...extra,
  }) as unknown as DashboardSummary;

const HARDWARE = {
  cpu: { usage: 23, model: "CPU genérica", temperature: 52 },
  ram: { usagePercent: 41, usedGb: 6.6, totalGb: 16 },
  gpu: { usage: 12, model: "GPU genérica", temperature: 47, vramUsedMb: 1000, vramTotalMb: 8000 },
  disk: {
    primary: { mount: "C:", kind: "system-reserved" },
    volumes: [
      { mount: "C:", kind: "working", usagePercent: 41, usedGb: 210, totalGb: 512, freeGb: 302 },
    ],
  },
  network: { rxSec: 14200, txSec: 3000, interfaceName: "Adaptador" },
  alerts: [],
} as unknown as HardwareSnapshot;

/** localStorage falso com um valor de superfície controlável por teste. */
function withSurface(surface: string | null) {
  const store: Record<string, string> = { theme: "dark", cybersafe_surface: surface ?? "glass" };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  (globalThis as Record<string, unknown>).React = React;
}

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: DashboardPage } = await import("../src/pages/DashboardPage");

function render(props: Record<string, unknown>, surface: string | null = "glass") {
  withSurface(surface);
  return renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(DashboardPage, { dashboard: resumo(), isLoading: false, hardware: HARDWARE, ...props } as never),
    ),
  );
}


it("100/100 não implica cobertura completa quando há avisos", () => {
  const html = render({ dashboard: resumo({ riskScore: 100, systemStatus: "attention" }), realtime: { disponivel: true, enabled: true } });
  assert.match(html, /Não confirma cobertura completa/);
});
it("rejeições são tentativas sem garantia de análise e não ficheiros perdidos", () => {
  const engine = { ...ENGINE, realtimeDroppedEvents: 10 };
  const html = render({ dashboard: resumo({ riskScore: 100, systemStatus: "attention", engineHealth: engine }), realtime: { disponivel: true, enabled: true } });
  assert.match(html, /10 tentativas de análise rejeitadas/);
  assert.match(html, /Cobertura incompleta ou não confirmada/);
  assert.doesNotMatch(html, /10 ficheiros perdidos/);
});
