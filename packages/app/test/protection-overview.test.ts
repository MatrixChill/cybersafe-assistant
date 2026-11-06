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
  // Serviço sem desfecho de recuperação: cobertura não confirmada, em eixo próprio.
  assert.equal(o.kind, "coverage-unconfirmed");
  assert.match(o.description, /desfecho da recuperação não reportado/);
});

// ── v0.2.1: eixo de cobertura do tempo real ─────────────────────────────────
function recovery(o: Record<string, unknown>) {
  return { metadataRejections: 0, analysisRejections: 9, pending: 0, running: false, recovered: 9, exhausted: 0,
    expired: 0, dropped: 0, suppressed: 0, cancelled: 0, distinctPaths: 9, pathsCapped: false, affectedPaths: [],
    lastEventAt: null, lastStage: "analysis", lastEventId: 9, metadataInFlight: 0, analysisQueueDepth: 0,
    waiting: 0, unrecovered: 0, analysisPending: 0, analysisConfirmed: 9, inconclusive: 0, versionUnconfirmed: 0,
    trackedCapped: false, ...o };
}
const lossOf = (n: number) => ({ queueRejections: n, watcherSignals: 0, watcherNamelessCallbacks: 0, queuePathsCapped: false,
  queueDistinctPaths: n, watcherCallbacksIndeterminate: false, raizesComPerda: [] });
const wfpReason = ["Filtro WFP do CyberSafe: unavailable — filtro WFP inativo — sem tentativa de ativação neste perfil"];

test("histórico todo recuperado + WFP opcional continua 'motores operacionais'", () => {
  const o = protectionOverview(dashboard({ engineHealth: engine({ realtimeLoss: lossOf(9),
    realtimeRecovery: recovery({}), degradedReasons: wfpReason }) }), realtime, true);
  assert.equal(o.kind, "operational-network-off");
});

test("4 de 4 motores + caminhos não recuperados = eixo de cobertura, não 'Proteção com limitações'", () => {
  const o = protectionOverview(dashboard({ engineHealth: engine({ realtimeLoss: lossOf(9),
    realtimeRecovery: recovery({ recovered: 6, unrecovered: 3, analysisConfirmed: 6 }),
    degradedReasons: ["Cobertura do tempo real não confirmada: 9 tentativas rejeitadas em 9 caminhos; 6 recuperados, 3 não recuperados."] }) }),
    realtime, true);
  assert.equal(o.kind, "coverage-unconfirmed");
  assert.notEqual(o.title, "Proteção com limitações");
  assert.match(o.title, /cobertura/i);
  assert.equal(o.tone, "warn");
  assert.equal(o.allEnginesActive, true);
  assert.match(o.description, /3 caminhos sem nenhuma versão admitida/);
});

test("admissão recuperada mas análises por concluir = em recuperação, nunca operacional", () => {
  const o = protectionOverview(dashboard({ engineHealth: engine({ realtimeLoss: lossOf(9),
    realtimeRecovery: recovery({ analysisPending: 9, analysisConfirmed: 0 }),
    degradedReasons: ["Cobertura do tempo real não confirmada: 9 admitidos com análise por concluir."] }) }), realtime, true);
  assert.equal(o.kind, "coverage-unconfirmed");
  assert.equal(o.title, "Cobertura do tempo real em recuperação");
  assert.match(o.description, /9 admitidos com análise por concluir/);
});

test("motor degradado continua a mandar no título mesmo com perdas", () => {
  const o = protectionOverview(dashboard({ engineHealth: engine({ realtimeLoss: lossOf(9),
    realtimeRecovery: recovery({ unrecovered: 3 }), clamav: { status: "degraded" } }) }), realtime, true);
  assert.equal(o.kind, "limited");
});

test("v0.2.3: recuperação em curso diz '4 motores operacionais' e que está a recuperar", () => {
  const o = protectionOverview(dashboard({ engineHealth: engine({ realtimeLoss: lossOf(9),
    realtimeRecovery: recovery({ waiting: 3, analysisConfirmed: 6 }),
    degradedReasons: ["Cobertura do tempo real não confirmada: 3 à espera de nova tentativa."] }) }), realtime, true);
  assert.equal(o.kind, "coverage-unconfirmed");
  assert.match(o.description, /^4 motores operacionais\. A proteção em tempo real está a recuperar algumas análises pendentes/);
});

test("v0.2.3: removidos antes da análise são informativos e não impedem confirmar", () => {
  const o = protectionOverview(dashboard({ engineHealth: engine({ realtimeLoss: lossOf(9),
    realtimeRecovery: recovery({ analysisConfirmed: 5, removed: 4 }), degradedReasons: wfpReason }) }), realtime, true);
  assert.equal(o.kind, "operational-network-off");
});
