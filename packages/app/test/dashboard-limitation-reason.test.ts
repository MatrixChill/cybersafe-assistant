import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";
import { dashboardVerdict } from "../src/v2/dashboard/model";

const engine = {
  serviceRunning: true,
  osLayerHealthy: true,
  anyEngineDegraded: true,
  degradedReasons: [
    "ClamAV: degraded — sem base de assinaturas",
    "Filtro WFP: unavailable — filtro inativo",
  ],
  monitoredPaths: [],
  yara: { status: "active" },
  hashDb: { status: "active" },
  clamav: { status: "degraded" },
  nativeEngine: { status: "active" },
} as unknown as EngineHealth;

const dashboard = {
  riskScore: 68,
  totalEvents: 0,
  highSeverityEvents: 0,
  downloadRisk: "low",
  recentThreats: [],
  alerts: [],
  systemStatus: "attention",
  engineHealth: engine,
} as unknown as DashboardSummary;

test("o hero do Dashboard cita a limitação concreta reportada e não só uma frase genérica", () => {
  const verdict = dashboardVerdict(dashboard, { enabled: true, disponivel: true }, true);
  assert.equal(verdict.title, "Proteção com limitações");
  assert.match(verdict.description, /ClamAV/);
  assert.match(verdict.description, /WFP/);
  assert.match(verdict.description, /Limitações reportadas/);
});

test("sem limitações reportadas, o hero não inventa uma causa", () => {
  const saudavel = {
    ...engine,
    anyEngineDegraded: false,
    degradedReasons: [],
  } as unknown as EngineHealth;
  const verdict = dashboardVerdict(
    { ...dashboard, systemStatus: "safe", engineHealth: saudavel },
    { enabled: true, disponivel: true },
    true,
  );
  assert.equal(verdict.title, "Monitorização ligada");
  assert.doesNotMatch(verdict.description, /Limitações reportadas/);
});
