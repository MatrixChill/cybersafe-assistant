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

const dashboardSource = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");

describe("Dashboard V2 — hero com material da preferência, independente do estado", () => {
  it("o hero-banner lê data-material da superfície guardada (solid/glass)", () => {
    assert.match(render({ realtime: { disponivel: true, enabled: true } }, "solid"), /<section[^>]*class="[^"]*hero-banner[^"]*"[^>]*data-material="solid"/);
    assert.match(render({ realtime: { disponivel: true, enabled: true } }, "glass"), /<section[^>]*class="[^"]*hero-banner[^"]*"[^>]*data-material="glass"/);
  });

  it("o material vem do contexto de aparência, não de um literal do estado", () => {
    assert.match(dashboardSource, /const \{ surface \} = useAppearance\(\)/);
    assert.match(dashboardSource, /data-material=\{surface\}/);
  });
});

describe("Dashboard V2 — pontuação explicada, não número solto", () => {
  it("rotula o que é medido e mostra motores ativos + teto", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    assert.match(html, /Pontuação de proteção/);
    assert.match(html, /de 4 motores ativos · máximo possível/);
    assert.ok(html.includes("/100"), "o denominador acompanha o número");
  });

  it("a penalização por ameaças aparece quando há ameaças graves", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    assert.match(html, /−\d+ por ameaças/, "a explicação da nota deve mostrar a penalização real");
  });
});

describe("Dashboard V2 — faixa de evidência com origem", () => {
  it("existe a evidence-strip com os cinco factos lidos pelo serviço", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    assert.match(html, /data-testid="evidence-strip"/);
    for (const label of ["Motores ativos", "Tempo real", "Definições", "Caminhos", "Fila"]) {
      assert.ok(html.includes(label), `faltou o facto de evidência "${label}"`);
    }
  });
});

describe("Dashboard V2 — honestidade do tempo real", () => {
  it("sem leitura de enabled não afirma 'Monitorização ligada'; diz 'não verificada'", () => {
    const html = render({ realtime: { disponivel: true } });
    assert.equal(html.includes("Monitorização ligada"), false, "nunca afirmar ligado sem leitura");
    assert.match(html, /Monitorização não verificada/);
  });

  it("com enabled lido a true, o chip usa o veredicto do nível (não o rótulo de pausa)", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    assert.equal(html.includes("Monitorização não verificada"), false);
  });
});

describe("Dashboard V2 — telemetria hierárquica", () => {
  it("a secção 'A usar agora' lidera com CPU e RAM", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    const inicio = html.indexOf("A usar agora");
    assert.ok(inicio >= 0, "falta o título da telemetria medida");
    const depois = html.slice(inicio);
    assert.ok(depois.includes("CPU") && depois.includes("RAM"), "CPU e RAM são os líderes da hierarquia");
  });
});
