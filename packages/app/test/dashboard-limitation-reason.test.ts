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

test("snapshot produzido pelo serviço e serializado conserva as causas no Dashboard", async () => {
  const { ProtectionEngineService } = await import("../../service/dist/engine.js");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard-service-"));
  try {
    // Real producer, no init(): no watcher, ETW, network or personal profile.
    const service = new ProtectionEngineService(dir);
    const wire = JSON.parse(JSON.stringify(service.getProtectionState()));
    assert.ok(wire.engine.degradedReasons.length > 0);
    assert.equal(wire.engine.yara.coverage, "unknown");
    const verdict = dashboardVerdict({ ...dashboard, systemStatus: wire.status, engineHealth: wire.engine }, { enabled: true, disponivel: true }, true);
    assert.equal(verdict.title, "Proteção com limitações");
    for (const reason of wire.engine.degradedReasons.slice(0, 2)) assert.ok(verdict.description.includes(reason.trim()));
    assert.doesNotMatch(verdict.title, /completa/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
