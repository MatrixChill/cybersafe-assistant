import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, HardwareSnapshot, ProtectionState } from "@cybersafe/shared-types";
import { protectionStatusText, realtimeProtectionCopy } from "../src/lib/protectionHealth";
import { buildMatrixContext } from "../src/lib/matrixContext";
import DashboardPage from "../src/pages/DashboardPage";
import { buildTrayMenuTemplate } from "../../desktop/src/tray-menu";

// Runtime classico para o JSX fora do Vite (padrao dos testes desta package).
(globalThis as Record<string, unknown>).React = React;
// O MatrixAvatar do Dashboard usa AppearanceProvider, que le localStorage nos
// inicializadores de estado — stub minimo honesto (mesmo padrao de
// scanner-page-render.test.ts).
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
import { AppearanceProvider } from "../src/contexts/AppearanceContext";

/**
 * HORA 3 — as camadas contam a MESMA VERDADE sobre tempo real:
 *  G1: `ProtectionStatus` deixa de ser forçado ao vocabulário dos motores.
 *  G2: "Desativada"/"Pausada até X" são estados DISTINTOS, mostrados só com
 *      leitura real; ausência de dado nunca vira afirmação.
 *  G3: o Matrix recebe `Real-time protection: on|off|unknown` factual, e o
 *      contexto é um helper puro testável.
 */

describe("G1 — protectionStatusText", () => {
  test("cada valor real da união tem a sua palavra PT-PT", () => {
    assert.equal(protectionStatusText("safe"), "Protegido");
    assert.equal(protectionStatusText("attention"), "Atenção");
    assert.equal(protectionStatusText("critical"), "Crítico");
    assert.equal(protectionStatusText("degraded"), "Degradado");
  });

  test("'critical' nunca mais cai em 'Estado desconhecido'", () => {
    // O bug era este: cast de ProtectionStatus a EngineSubsystemStatus fazia o
    // Monitor escrever "Estado desconhecido" com proteção desligada.
    assert.notEqual(protectionStatusText("critical"), "Estado desconhecido");
    assert.notEqual(protectionStatusText("safe"), "Estado desconhecido");
    assert.notEqual(protectionStatusText("attention"), "Estado desconhecido");
    // Valor fora da união continua honesto: diz que não se sabe.
    assert.equal(protectionStatusText("borrachas" as never), "Estado desconhecido");
  });

  test("o Monitor deixou de fazer o cast", () => {
    const monitor = readFileSync(new URL("../src/pages/MonitorPage.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(monitor, /as EngineSubsystemStatus/, "o cast de vocabulario voltou");
    assert.match(monitor, /protectionStatusText\(protection\.status\)/);
  });
});

describe("G2 — realtimeProtectionCopy", () => {
  test("perda de IPC prevalece sobre uma leitura ativa antiga", () => {
    assert.deepEqual(realtimeProtectionCopy({ disponivel: false, enabled: true }), { text: "Indisponível", tone: "warn" });
    const dashboard = { riskScore: null, totalEvents: 0, highSeverityEvents: 0, downloadRisk: "low", recentThreats: [], alerts: [], systemStatus: "safe" } as DashboardSummary;
    const html = renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(DashboardPage, {
      dashboard, isLoading: false, realtime: { disponivel: false, enabled: true },
    })));
    // Migração V2-FIRST: a linha do tempo real passou a viver no diagnóstico
    // colapsado do Painel, como texto simples (sem `<span>` de estado). O
    // contrato é o mesmo: a perda de IPC prevalece, e nada se pinta como ativo.
    assert.match(html, /Proteção em tempo real: Indisponível/);
    assert.match(html, /Sem leitura/, "a nota em falta é dita, não contada como zero");
    assert.match(html, /Ligação não confirmada/, "o hero responde ao que se sabe da ligação");
    assert.doesNotMatch(html, />Ativa<|Sistema Protegido|Sim, está protegido|Monitorização ligada/);
    const tray = buildTrayMenuTemplate({ serviceRunning: false, status: null, score: null, threats: null, quarantine: null, protectionEnabled: null }, { open() {}, exit() {}, startProtection() {} });
    assert.ok(tray.some((item) => item.label === "Proteção em tempo real — Indisponível"));
  });
  test("off real diz 'Desativada'; on real diz 'Ativa'", () => {
    assert.deepEqual(realtimeProtectionCopy({ enabled: false }), { text: "Desativada", tone: "off" });
    assert.deepEqual(realtimeProtectionCopy({ enabled: true }), { text: "Ativa", tone: "ok" });
  });

  test("pausa mostra 'Pausada até' com data formatada; prioridade sobre enabled", () => {
    const copia = realtimeProtectionCopy({ enabled: true, pausedUntil: "2026-10-07T18:30:00.000Z" });
    assert.ok(copia);
    assert.equal(copia.tone, "warn");
    assert.match(copia.text, /^Pausada até /);
    assert.ok(copia.text.includes("2026"));
    // Data illegivel nao e escondida: mostra-se o valor crudo, sem inventar.
    const crua = realtimeProtectionCopy({ pausedUntil: "ontem" });
    assert.equal(crua?.text, "Pausada até ontem");
  });

  test("campos ausentes OMITEM a linha — nunca 'Desativada' por desconhecimento", () => {
    assert.equal(realtimeProtectionCopy({}), null);
    assert.equal(realtimeProtectionCopy({ enabled: undefined, pausedUntil: null }), null);
    assert.equal(realtimeProtectionCopy(undefined), null);
    assert.equal(realtimeProtectionCopy(null), null);
  });

  test("Dashboard renderiza a linha DISTINTA quando há leitura, e não a inventa quando não há", () => {
    const dashboard = {
      riskScore: 20, totalEvents: 0, highSeverityEvents: 0, downloadRisk: "low",
      recentThreats: [], alerts: [], systemStatus: "critical",
    } as unknown as DashboardSummary;

    const comLeitura = renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(DashboardPage, {
      dashboard, isLoading: false, serviceConnected: true, realtime: { disponivel: true, enabled: false },
    })));
    assert.match(comLeitura, /Proteção em tempo real: Desativada/);

    const ativa = renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(DashboardPage, {
      dashboard, isLoading: false, serviceConnected: true, realtime: { disponivel: true, enabled: true },
    })));
    assert.match(ativa, /Proteção em tempo real: Ativa/);

    // Sem leitura do `enabled`, a linha não desaparece nem afirma: diz que não
    // foi verificada. (Em V1 a linha simplesmente não existia.)
    const semLeitura = renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(DashboardPage, {
      dashboard, isLoading: false, serviceConnected: true, realtime: {},
    })));
    assert.match(semLeitura, /Proteção em tempo real: Monitorização não verificada/);
    assert.doesNotMatch(semLeitura, /Proteção em tempo real: Ativa|Monitorização ligada/, "sem leitura real nada se afirma");
  });
});

describe("G3 — buildMatrixContext", () => {
  const baseProtection = {
    status: "critical",
    stats: { riskScore: 80, totalEvents: 12, highSeverityEvents: 3, quarantinedCount: 2 },
    engine: { serviceRunning: true },
    protectionEnabled: false,
    protectionPausedUntil: null,
  } as unknown as ProtectionState;

  const input = {
    protection: baseProtection,
    hardware: {
      cpu: { usage: 31, temperature: 55, usageStatus: "available", usageUpdatedAt: new Date(Date.now() - 1000).toISOString() }, ram: { usagePercent: 62, usageStatus: "available", usageUpdatedAt: new Date(Date.now() - 1000).toISOString() }, disk: { usagePercent: 71 },
    } as unknown as HardwareSnapshot,
    pcState: {
      overall: "attention", security: "good", performance: "attention", system: "good",
      findings: [{ severity: "medium", title: "Disco quase cheio", evidence: { evidenceLines: ["71% usado"] } }],
    } as never,
    threats: [{ severity: "high" }] as never,
  };

  test("mantem TODOS os campos factuais que o App já mandava", () => {
    const ctx = buildMatrixContext(input);
    assert.match(ctx, /Protection score: 20/);
    assert.match(ctx, /Protection status: critical/);
    assert.match(ctx, /Service running: true/);
    assert.match(ctx, /Security events \(total\): 12/);
    assert.match(ctx, /Quarantined items: 2/);
    assert.match(ctx, /CPU usage: 31%/);
    assert.match(ctx, /RAM usage: 62%/);
    assert.match(ctx, /Disk usage: 71%/);
    assert.match(ctx, /PC overall: attention/);
    assert.match(ctx, /PC findings \(count\): 1/);
    assert.doesNotMatch(ctx, /Disco quase cheio/, "texto livre fica local; contexto estruturado exige consentimento");
    assert.match(ctx, /Active threats: 1/);
  });

  test("acrescenta o estado factual do tempo real: on/off/unknown", () => {
    assert.match(buildMatrixContext(input), /Real-time protection: off/);
    const on = buildMatrixContext({ ...input, protection: { ...baseProtection, protectionEnabled: true } });
    assert.match(on, /Real-time protection: on/);
    const desconhecido = buildMatrixContext({ ...input, protection: { ...baseProtection, protectionEnabled: undefined } });
    assert.match(desconhecido, /Real-time protection: unknown/);
    assert.doesNotMatch(desconhecido, /Real-time protection: off/, "campo nao lido nunca afirma off");
  });

  test("'Protection paused until' so aparece quando o campo existe", () => {
    const pausado = buildMatrixContext({ ...input, protection: { ...baseProtection, protectionPausedUntil: "2026-10-07T18:30:00.000Z" } });
    assert.match(pausado, /Protection paused until: 2026-10-07T18:30:00\.000Z/);
    assert.doesNotMatch(buildMatrixContext(input), /Protection paused until/);
  });

  test("sem protecao lida, nada de linhas de protecao", () => {
    const ctx = buildMatrixContext({ ...input, protection: null });
    assert.doesNotMatch(ctx, /Protection score|Real-time protection|Protection status/);
    assert.match(ctx, /Active threats: 1/, "as ameacas ativas continuam a ser contadas");
  });

  test("tendencia de 24h usa apenas amostras datadas e nao conta o futuro", () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    const ctx = buildMatrixContext({
      ...input,
      now,
      threats: [
        { severity: "high", createdAt: "2026-11-01T11:00:00.000Z" },
        { severity: "high", createdAt: "2026-11-01T10:00:00.000Z" },
        { severity: "high", createdAt: "2026-10-31T06:00:00.000Z" },
        { severity: "high", createdAt: "2026-11-02T12:00:00.000Z" },
        { severity: "high", createdAt: "nao-e-data" },
      ] as never,
    });
    assert.match(ctx, /Threats in retained feed: last 24h 2, previous 24h 1, trend up \(\+1\)/);
  });

  test("sem datas utilizaveis, a tendencia nao aparece", () => {
    const ctx = buildMatrixContext({ ...input, threats: [{ severity: "high" }] as never });
    assert.doesNotMatch(ctx, /Threats in retained feed/);
  });

  test("o App usa o helper — a montagem inline nao voltou, e o WIP de scroll esta intacto", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(app, /import \{ buildMatrixContext \} from "\.\/lib\/matrixContext"/);
    assert.match(app, /buildMatrixContext\(\{ protection, hardware, pcState, threats \}\)/);
    assert.doesNotMatch(app, /parts\.push\(`Protection score/, "a montagem inline duplicada voltou ao App");
    // WIP de scroll (preservacao obrigatoria do scope):
    assert.match(app, /anchorNewPageAtTop/);
    assert.match(app, /mainScrollRef/);
  });

  // Ronda 4 (Maestro, integracao): a guarda anterior era `== null`, que NAO
  // apanha `NaN`. Uma serializacao corrompida em IPC mandava «NaN%» para o
  // contexto da IA — mesmo defeito de honestidade que «0,0%» sem medicao.
  test("R4: NaN nunca chega ao contexto da IA", () => {
    const nan = {
      ...input,
      hardware: {
        cpu: { usage: Number.NaN, temperature: 55 },
        ram: { usagePercent: Number.NaN },
        disk: {
          usagePercent: Number.NaN,
          volumes: [
            { kind: "working", mount: "D:", freeGb: Number.NaN, usagePercent: Number.NaN },
            { kind: "working", mount: "E:", freeGb: Number.POSITIVE_INFINITY, usagePercent: 40 },
          ],
        },
      } as unknown as HardwareSnapshot,
    };
    const ctx = buildMatrixContext(nan);
    assert.doesNotMatch(ctx, /NaN/, "NaN chegou ao contexto da IA");
    assert.doesNotMatch(ctx, /Infinity/, "Infinity chegou ao contexto da IA");
    assert.match(ctx, /CPU usage: sem leitura/);
    assert.match(ctx, /RAM usage: sem leitura/);
    assert.match(ctx, /Disk usage: sem leitura/);
    assert.match(ctx, /Disk D: livre sem leitura \(uso sem leitura\)/);
    assert.match(ctx, /Disk E: livre sem leitura \(40% usado\)/, "so o campo sem leitura cai");
    assert.doesNotMatch(ctx, /D::|E::/, "o sufixo ':' duplicado voltou (D:: / E::)");
  });
});
