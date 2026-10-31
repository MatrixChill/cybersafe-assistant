import { test } from "node:test";
import assert from "node:assert/strict";
import { PcStateEngine, normalizeSample, DEFAULT_PC_STATE_CONFIG } from "../dist/index.js";

/**
 * Estes testes fecham duas mentiras que o Findings Engine podia contar:
 *
 *  1. `cpu: CLAMP(usage)` sem olhar `usageStatus`. Um snapshot com a carga
 *     por medir trazia `usage: 0`; 0 entrava na série e a ausência de sensor
 *     tornava-se «carga baixa». O valor deixa de ser uma medição quando o
 *     estado diz que não é.
 *  2. `performance ?? "good"`. Nenhum achado de desempenho vale «bom» só
 *     porque não se mediu nada; a ignorância pintava o sistema de verde.
 *
 * `hw` é FIXTURE de teste, não leitura desta máquina.
 */
const BASE_TS = Date.parse("2023-11-14T22:13:20.000Z");

function hw({ cpu = 10, cpuStatus, ram = 40, disk = 40, step = 0, processes = [] } = {}) {
  const timestamp = new Date(BASE_TS + step * 1000).toISOString();
  return {
    cpu: {
      usage: cpu,
      model: "Test CPU",
      cores: 8,
      speed: 3.2,
      temperature: null,
      ...(cpuStatus === undefined ? {} : { usageStatus: cpuStatus }),
    },
    ram: { usagePercent: ram, usedGb: 8, totalGb: 16 },
    disk: { usagePercent: disk, usedGb: 200, totalGb: 500, fsType: "NTFS" },
    network: { rxSec: 0, txSec: 0, interfaceName: "eth0" },
    battery: { hasBattery: false, percent: 100, isCharging: true, timeRemaining: null },
    gpu: null,
    system: { uptime: 1000, platform: "win32", osVersion: "10", hostname: "TEST" },
    topProcessesByCpu: processes,
    topProcessesByRam: processes,
    stressScore: 0,
    alerts: [],
    timestamp,
  };
}

function protection() {
  return {
    status: "safe",
    stats: { riskScore: 0, totalEvents: 0, highSeverityEvents: 0, blockedExecutions: 0, quarantinedCount: 0, monitoredProcesses: 0 },
    engine: {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "active" },
      nativeEngine: { status: "active" },
      firewall: { status: "active" },
    },
  };
}

function health(overrides = {}) {
  return {
    system: { available: true, ramUsagePercent: 40, totalRamGb: 16, availableRamGb: 9, osName: "Windows", osVersion: "10", osBuild: "1", manufacturer: "", model: "", architecture: "x64" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    services: [],
    connections: [],
    users: [],
    disks: [],
    firewall: { enabled: true, profiles: [], available: true },
    overallStatus: "good",
    score: 100,
    recommendations: [],
    collectedAt: "2023-11-14T22:13:20.000Z",
    errors: [],
    ...overrides,
  };
}

/** Alimenta o motor com `n` snapshots consecutivos e devolve o último estado. */
function run(engine, snapshots) {
  let state = null;
  for (const hardware of snapshots) {
    state = engine.update({
      hardware,
      protection: protection(),
      windowsHealth: health(),
      threats: [],
      now: Date.parse(hardware.timestamp),
    });
  }
  return state;
}

const sustained = DEFAULT_PC_STATE_CONFIG.sustainedSamples;

test("normalizeSample: carga por medir não entra como amostra", () => {
  for (const usageStatus of ["unavailable", "stale", "error", "unsupported"]) {
    const sample = normalizeSample(hw({ cpu: 0, cpuStatus: usageStatus }));
    assert.equal(sample.cpu, null, `usageStatus=${usageStatus} não é medição`);
  }
  // 0 medido continua a ser medição: a asserção vem do estado, não do valor.
  const measured = normalizeSample(hw({ cpu: 0, cpuStatus: "available" }));
  assert.equal(measured.cpu, 0);
  // Contrato partilhado: `usageStatus` ausente (snapshot antigo) trata-se como
  // disponível, nunca como 0 garantido.
  assert.equal(normalizeSample(hw({ cpu: 42 })).cpu, 42);
});

test(`CPU acima do limiar sem medição não gera achado (sustained=${sustained})`, () => {
  const engine = new PcStateEngine();
  const state = run(engine, Array.from({ length: sustained + 2 }, (_, step) =>
    hw({ cpu: 97, cpuStatus: "unavailable", step }),
  ));
  const keys = state.findings.filter((f) => f.category === "performance").map((f) => f.id);
  assert.deepEqual(keys.filter((k) => k.includes("cpu")), []);
  assert.notEqual(state.performance, "attention");
});

test("o mesmo valor com medição disponível gera o achado — a porta é o estado", () => {
  const engine = new PcStateEngine();
  const state = run(engine, Array.from({ length: sustained + 2 }, (_, step) =>
    hw({ cpu: 97, cpuStatus: "available", step }),
  ));
  const cpuHigh = state.findings.find((f) => f.id.includes("perf:cpu-high") || f.id.endsWith("cpu-high"));
  assert.ok(cpuHigh, "carga medida e sustentada tem de produzir achado");
  assert.equal(cpuHigh.severity, "attention");
  assert.equal(cpuHigh.evidence.cpuPercent, 97);
});

test("sem nenhuma amostra medida, performance é unknown e nunca good", () => {
  const state = run(new PcStateEngine(), [
    hw({ cpuStatus: "unavailable", ram: null, disk: null, step: 0 }),
  ]);
  assert.equal(state.performance, "unknown");
  // A RAM em `null` é a política que já existia: sem medição, sem achado.
  const ramKeys = state.findings.map((f) => f.id).filter((id) => id.includes("ram"));
  assert.deepEqual(ramKeys.filter((id) => id.includes("perf:")), []);
});

test("uma única base medida recupera o good", () => {
  const state = run(new PcStateEngine(), [hw({ cpuStatus: "available", cpu: 12, step: 0 })]);
  assert.equal(state.performance, "good");
});

test("snapshot ausente não inventa base medida", () => {
  const engine = new PcStateEngine();
  const state = engine.update({
    hardware: null,
    protection: protection(),
    windowsHealth: health(),
    threats: [],
    now: BASE_TS,
  });
  assert.equal(state.performance, "unknown");
});
