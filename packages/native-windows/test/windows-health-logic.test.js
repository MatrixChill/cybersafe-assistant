import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHealthAlerts,
  buildRecommendations,
  buildWindowsHealthSnapshot,
  computeScore,
  overallStatus,
} from "../dist/windows-health-logic.js";

function makeInput(overrides = {}) {
  return {
    system: {
      osName: "Microsoft Windows",
      osVersion: "10.0.19045",
      cpuModel: "Test CPU",
      cpuCores: 8,
      totalRamGb: 16,
      availableRamGb: 8,
      ramUsagePercent: 40,
      available: true,
    },
    topCpu: [],
    topRam: [],
    services: [],
    connections: [],
    users: [],
    disks: [],
    firewall: { available: false, enabled: false, profiles: [] },
    ...overrides,
  };
}

test("overallStatus is 'good' when there are no recommendations", () => {
  assert.equal(overallStatus([]), "good");
});

test("overallStatus escalates to attention/critical correctly", () => {
  const attention = [{ id: "a", severity: "medium", status: "attention", title: "x", description: "y", suggestion: "z" }];
  const critical = [{ id: "b", severity: "high", status: "critical", title: "x", description: "y", suggestion: "z" }];

  assert.equal(overallStatus(attention), "attention");
  assert.equal(overallStatus(critical), "critical");
  assert.equal(overallStatus([...attention, ...critical]), "critical");
});

test("computeScore clamps between 0 and 100", () => {
  assert.equal(computeScore([]), 100);
  assert.equal(computeScore(Array(20).fill({ severity: "high" })), 0);
});

test("buildRecommendations flags high RAM as critical", () => {
  const input = makeInput({ system: { ...makeInput().system, ramUsagePercent: 92 } });
  const recs = buildRecommendations(input);
  const ram = recs.find((r) => r.id === "ram-high");
  assert.ok(ram);
  assert.equal(ram.status, "critical");
});

test("buildRecommendations flags full disk", () => {
  const input = makeInput({
    disks: [{ deviceId: "C:", volumeName: "SSD", sizeGb: 500, freeGb: 10, usagePercent: 98 }],
  });
  const recs = buildRecommendations(input);
  assert.ok(recs.find((r) => r.id === "disk-critical"));
});

test("buildRecommendations flags disabled firewall", () => {
  const input = makeInput({
    firewall: { available: true, enabled: false, profiles: [{ name: "Domain", enabled: false }] },
  });
  const recs = buildRecommendations(input);
  assert.ok(recs.find((r) => r.id === "firewall-disabled"));
});

test("buildRecommendations flags unavailable critical service", () => {
  const input = makeInput({
    services: [{ name: "WinDefend", displayName: "Windows Defender", running: false }],
  });
  const recs = buildRecommendations(input);
  assert.ok(recs.find((r) => r.id === "service-down"));
});

test("buildWindowsHealthSnapshot composes status, score and recommendations", () => {
  const input = makeInput();
  const snap = buildWindowsHealthSnapshot(input, "2025-01-01T00:00:00.000Z", ["cmdlet unavailable"]);
  assert.equal(snap.overallStatus, "good");
  assert.equal(snap.score, 100);
  assert.deepEqual(snap.errors, ["cmdlet unavailable"]);
  assert.equal(snap.collectedAt, "2025-01-01T00:00:00.000Z");
});

test("buildHealthAlerts returns empty array for no recommendations", () => {
  const alerts = buildHealthAlerts([]);
  assert.equal(alerts.length, 0);
});

test("buildHealthAlerts maps high severity to critical", () => {
  const recs = [{ id: "ram-high", severity: "high", status: "critical", title: "Memória RAM crítica", description: "RAM a 92%", suggestion: "Feche aplicações" }];
  const alerts = buildHealthAlerts(recs);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "critical");
  assert.equal(alerts[0].title, "Memória RAM crítica");
  assert.equal(alerts[0].category, "Memória");
});

test("buildHealthAlerts maps medium severity to warning", () => {
  const recs = [{ id: "disk-attention", severity: "medium", status: "attention", title: "Espaço em disco baixo", description: "Disco a 87%", suggestion: "Limpe ficheiros" }];
  const alerts = buildHealthAlerts(recs);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "warning");
  assert.equal(alerts[0].category, "Armazenamento");
});

test("buildHealthAlerts maps low severity to info", () => {
  const recs = [{ id: "unknown-id", severity: "low", status: "good", title: "Info", description: "Detalhe", suggestion: "Nenhuma" }];
  const alerts = buildHealthAlerts(recs);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "info");
  assert.equal(alerts[0].category, "Geral");
});

test("buildHealthAlerts assigns correct categories", () => {
  const recs = [
    { id: "firewall-disabled", severity: "high", status: "critical", title: "Firewall", description: "Desligado", suggestion: "Ative" },
    { id: "service-down", severity: "high", status: "attention", title: "Serviço", description: "Indisponível", suggestion: "Verifique" },
    { id: "many-cpu-processes", severity: "medium", status: "attention", title: "CPU", description: "Muitos", suggestion: "Feche" },
  ];
  const alerts = buildHealthAlerts(recs);
  assert.equal(alerts[0].category, "Segurança");
  assert.equal(alerts[1].category, "Serviços");
  assert.equal(alerts[2].category, "CPU");
});

test("buildHealthAlerts handles multiple recommendations", () => {
  const input = makeInput({
    system: { ...makeInput().system, ramUsagePercent: 92 },
    disks: [{ deviceId: "C:", volumeName: "SSD", sizeGb: 500, freeGb: 10, usagePercent: 98 }],
    firewall: { available: true, enabled: false, profiles: [{ name: "Domain", enabled: false }] },
  });
  const recs = buildRecommendations(input);
  const alerts = buildHealthAlerts(recs);
  assert.ok(alerts.length >= 3);
  const severities = alerts.map((a) => a.severity);
  assert.ok(severities.includes("critical"));
});
