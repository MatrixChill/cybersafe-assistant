import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { EngineHealth, ProtectionStatus } from "@cybersafe/shared-types";
import { deriveProtectionLevel, explainProtectionScore, PROTECTION_LEVEL_META } from "../src/lib/protectionHealth";

const healthyEngine = (overrides: Partial<EngineHealth> = {}): EngineHealth => ({
  serviceRunning: true,
  osLayerHealthy: true,
  degradedReasons: [],
  monitoredPaths: [],
  anyEngineDegraded: false,
  yara: { status: "active" },
  hashDb: { status: "active" },
  clamav: { status: "active" },
  nativeEngine: { status: "active" },
  firewall: { status: "active" },
  ...overrides,
});

const cases: { name: string; status: ProtectionStatus; engine?: EngineHealth; expected: string }[] = [
  {
    name: "todos ativos + safe → protected",
    status: "safe",
    engine: healthyEngine(),
    expected: "protected",
  },
  {
    name: "yara ativo + clamav unavailable + safe → NUNCA protected",
    status: "safe",
    engine: healthyEngine({
      anyEngineDegraded: true,
      clamav: { status: "unavailable", detail: "serviço não instalado" },
    }),
    expected: "degraded",
  },
  {
    name: "yara ativo + clamav unavailable + attention → degraded",
    status: "attention",
    engine: healthyEngine({
      anyEngineDegraded: true,
      clamav: { status: "unavailable", detail: "serviço não instalado" },
    }),
    expected: "degraded",
  },
  {
    name: "engine em ERROR + safe → critical imediato",
    status: "safe",
    engine: healthyEngine({
      anyEngineDegraded: true,
      yara: { status: "error", detail: "falha de inicialização" },
    }),
    expected: "critical",
  },
  {
    name: "serviço desligado + safe → critical",
    status: "safe",
    engine: healthyEngine({ serviceRunning: false, anyEngineDegraded: true }),
    expected: "critical",
  },
  {
    name: "critical (ameaça) + healthy → critical",
    status: "critical",
    engine: healthyEngine(),
    expected: "critical",
  },
  {
    name: "degraded backend + sem engines → degraded",
    status: "degraded",
    engine: undefined,
    expected: "degraded",
  },
  {
    name: "backend degraded com serviço parado → critical (defesa extra)",
    status: "degraded",
    engine: healthyEngine({ serviceRunning: false, anyEngineDegraded: true }),
    expected: "critical",
  },
];

for (const c of cases) {
  test(c.name, () => {
    assert.equal(deriveProtectionLevel(c.status, c.engine), c.expected);
  });
}

// ── Explicação da pontuação (pesos reais espelham effectiveRiskScore) ──

describe("explainProtectionScore — fórmula real do Dashboard", () => {
  test("cenário 55: 2 de 4 motores de análise ativos → máx 55, sem penalização", () => {
    // Estado real típico: YARA + Hash DB ativos; ClamAV e Native indisponíveis.
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "unavailable", detail: "clamscan não encontrado" },
      nativeEngine: { status: "unavailable", detail: "não integrado" },
      firewall: { status: "unavailable" },
    };
    const info = explainProtectionScore(55, engine);
    assert.equal(info.activeEngines, 2);
    assert.equal(info.totalEngines, 4);
    assert.equal(info.maxPossible, 55); // 100 − piso 45 (1–2 ativos)
    assert.equal(info.threatPenalty, 0); // 55 já é o máximo possível
  });

  test("0 motores de análise ativos → máx 25 (piso 75)", () => {
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "error" },
      hashDb: { status: "error" },
      clamav: { status: "unavailable" },
      nativeEngine: { status: "unavailable" },
    };
    assert.equal(explainProtectionScore(25, engine).maxPossible, 25);
  });

  test("4 motores ativos sem degradados → máx 100", () => {
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "active" },
      nativeEngine: { status: "active" },
    };
    const info = explainProtectionScore(80, engine);
    assert.equal(info.maxPossible, 100);
    assert.equal(info.threatPenalty, 20); // ameaças recentes explicam os 20 perdidos
  });

  test("a pontuação nunca reflete componentes inexistentes como penalização", () => {
    // Firewall UNAVAILABLE não conta para o piso (comporta-se como o backend).
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "active" },
      nativeEngine: { status: "active" },
      firewall: { status: "unavailable" },
    };
    assert.equal(explainProtectionScore(100, engine).maxPossible, 100);
  });

  test("o texto do nível degraded mantém o rótulo do bug original", () => {
    assert.equal(PROTECTION_LEVEL_META.degraded.shortLabel, "Degradado");
  });
});