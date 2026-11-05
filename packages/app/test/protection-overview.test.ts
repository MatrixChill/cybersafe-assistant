import test from "node:test";
import assert from "node:assert/strict";
import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";
import { protectionOverview } from "../src/lib/protectionOverview";

function engine(overrides: Partial<Record<string, unknown>> = {}): EngineHealth {
  return {
    serviceRunning: true,
    osLayerHealthy: true,
    degradedReasons: [],
    monitoredPaths: ["C:/Users/x/Downloads"],
    realtimeQueueDepth: 0,
    realtimeDroppedEvents: 0,
    realtimeLoss: {
      queueRejections: 0,
      watcherSignals: 0,
      watcherNamelessCallbacks: 0,
      queuePathsCapped: false,
      queueDistinctPaths: 0,
      watcherCallbacksIndeterminate: false,
      raizesComPerda: [],
    },
    yara: { status: "active", coverage: "normal", detail: "Loaded 1 rule" },
    hashDb: { status: "active", detail: "Loaded 1 signature" },
    clamav: { status: "active" },
    nativeEngine: { status: "active" },
    wfp: {
      status: "unavailable",
      detail: "filtro WFP inativo — sem tentativa de ativação neste perfil",
    },
    ...overrides,
  } as unknown as EngineHealth;
}

function dashboard(overrides: Partial<Record<string, unknown>> = {}): DashboardSummary {
  return {
    systemStatus: "degraded",
    riskScore: 100,
    highSeverityEvents: 0,
    alerts: [],
    engineHealth: engine(),
    ...overrides,
  } as unknown as DashboardSummary;
}

const realtime = { enabled: true, disponivel: true };

test("quatro motores ativos + WFP opcional desligado = motores operacionais, sem alarme", () => {
  const o = protectionOverview(dashboard(), realtime, true);
  assert.equal(o.kind, "operational-network-off");
  assert.equal(o.title, "Motores de análise operacionais");
  assert.equal(o.tone, "ok");
  assert.equal(o.enginesActive, 4);
  assert.equal(o.enginesTotal, 4);
  assert.equal(o.networkFilter, "optional-off");
  assert.match(o.description, /quatro motores de análise estão ativos/i);
  assert.match(o.description, /proteção de rede adicional/i);
});

test("um motor degradado deixa de ser operacional", () => {
  const o = protectionOverview(
    dashboard({
      engineHealth: engine({
        clamav: { status: "degraded", detail: "ClamAV instalado mas sem base" },
        degradedReasons: ["ClamAV instalado mas sem base de assinaturas"],
      }),
    }),
    realtime,
    true,
  );
  assert.equal(o.kind, "limited");
  assert.notEqual(o.title, "Motores de análise operacionais");
  assert.equal(o.tone, "warn");
});

test("WFP com erro mantém o estado crítico", () => {
  const o = protectionOverview(
    dashboard({ engineHealth: engine({ wfp: { status: "error", detail: "falha medida" } }) }),
    realtime,
    true,
  );
  assert.equal(o.kind, "critical");
  assert.equal(o.tone, "crit");
});

test("WFP inativo por outra causa não é 'opcional desligado'", () => {
  const o = protectionOverview(
    dashboard({
      engineHealth: engine({
        wfp: { status: "unavailable", detail: "filtro WFP inativo — tentativa recusada: sem privilégio" },
        degradedReasons: ["filtro WFP inativo — tentativa recusada: sem privilégio"],
      }),
    }),
    realtime,
    true,
  );
  assert.equal(o.kind, "limited");
});

test("monitorização desligada é dita como tal", () => {
  const o = protectionOverview(dashboard(), { enabled: false, disponivel: true }, true);
  assert.equal(o.kind, "monitoring-off");
  assert.equal(o.tone, "warn");
});

test("sem ligação confirmada não se afirma nada", () => {
  const o = protectionOverview(dashboard(), realtime, null);
  assert.equal(o.kind, "unconfirmed");
  assert.equal(o.tone, "na");
});

test("perdas do watcher impedem o estado operacional", () => {
  const o = protectionOverview(
    dashboard({
      engineHealth: engine({
        realtimeLoss: {
          queueRejections: 2,
          watcherSignals: 0,
          watcherNamelessCallbacks: 0,
          queuePathsCapped: false,
          queueDistinctPaths: 2,
          watcherCallbacksIndeterminate: false,
          raizesComPerda: [],
        },
        degradedReasons: ["filtro WFP inativo — sem tentativa de ativação neste perfil"],
      }),
    }),
    realtime,
    true,
  );
  assert.equal(o.kind, "limited");
});
