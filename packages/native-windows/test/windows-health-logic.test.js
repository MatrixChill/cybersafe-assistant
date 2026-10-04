import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHealthAlertEvidence,
  buildHealthAlerts,
  buildHealthAlertsFromSnapshot,
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

function makeSnapshot(overrides = {}) {
  return buildWindowsHealthSnapshot(makeInput(overrides), "2025-01-01T00:00:00.000Z", []);
}

test("buildHealthAlertsFromSnapshot maps suggestion to recommended action", () => {
  const snap = makeSnapshot({ system: { ...makeInput().system, ramUsagePercent: 92 } });
  const rec = snap.recommendations.find((r) => r.id === "ram-high");
  assert.ok(rec);
  const alerts = buildHealthAlertsFromSnapshot(snap);
  const ram = alerts.find((a) => a.title === rec.title);
  assert.ok(ram);
  assert.equal(ram.recommendedAction, rec.suggestion);
  assert.equal(ram.severity, "critical");
  assert.equal(ram.category, "Memória");
  assert.ok(ram.evidence.length > 0);
});

test("buildHealthAlerts carries recommendedAction and empty evidence", () => {
  const recs = [
    { id: "disk-attention", severity: "medium", status: "attention", title: "Espaço baixo", description: "d", suggestion: "Limpe ficheiros temporários" },
  ];
  const alerts = buildHealthAlerts(recs);
  assert.equal(alerts[0].recommendedAction, "Limpe ficheiros temporários");
  assert.deepEqual(alerts[0].evidence, []);
});

test("buildHealthAlertEvidence provides RAM evidence", () => {
  const snap = makeSnapshot({
    system: { ...makeInput().system, ramUsagePercent: 92, availableRamGb: 1.2 },
    topRam: [{ pid: 1234, name: "chrome.exe", cpuPercent: 11, memoryMb: 2400, path: "C:\\progs\\chrome.exe", user: "me" }],
  });
  const ev = buildHealthAlertEvidence("ram-high", snap);
  assert.ok(ev.some((l) => l.includes("92%")));
  assert.ok(ev.some((l) => l.includes("1.2 GB livres de 16.0 GB")));
  assert.ok(ev.some((l) => l.includes("chrome.exe") && l.includes("1234") && l.includes("2400")));
});

test("buildHealthAlertEvidence provides disk evidence", () => {
  const snap = makeSnapshot({
    disks: [{ deviceId: "C:", volumeName: "SSD", sizeGb: 500, freeGb: 10, usedGb: 490, usagePercent: 98, fileSystem: "NTFS" }],
  });
  const ev = buildHealthAlertEvidence("disk-critical", snap);
  assert.ok(ev.some((l) => l.includes("C:") && l.includes("SSD")));
  assert.ok(ev.some((l) => l.includes("98%")));
  assert.ok(ev.some((l) => l.includes("10.0 GB livres de 500.0 GB")));
  assert.ok(ev.some((l) => l.includes("NTFS")));
});

test("buildHealthAlertEvidence provides firewall evidence", () => {
  const snap = makeSnapshot({
    firewall: {
      available: true,
      enabled: false,
      profiles: [{ name: "Domain", enabled: false }, { name: "Private", enabled: true }],
    },
  });
  const ev = buildHealthAlertEvidence("firewall-disabled", snap);
  assert.ok(ev.some((l) => l.includes("Desativado")));
  assert.ok(ev.some((l) => l === "Perfil Domain: Desativado"));
  assert.ok(ev.some((l) => l === "Perfil Private: Ativado"));
});

test("buildHealthAlertEvidence provides service evidence", () => {
  const snap = makeSnapshot({
    services: [
      { name: "WinDefend", displayName: "Windows Defender", status: "Stopped", startType: "Auto", running: false },
      { name: "Spooler", displayName: "Print Spooler", status: "Running", startType: "Auto", running: true },
    ],
  });
  const ev = buildHealthAlertEvidence("service-down", snap);
  assert.ok(ev.some((l) => l.includes("Windows Defender") && l.includes("Stopped")));
  assert.ok(!ev.some((l) => l.includes("Print Spooler")));
});

test("buildHealthAlertEvidence lists heavy CPU processes only", () => {
  const snap = makeSnapshot({
    topCpu: [
      { pid: 1, name: "procA", cpuPercent: 82, memoryMb: 300, path: "", user: "u" },
      { pid: 2, name: "procB", cpuPercent: 12, memoryMb: 90, path: "", user: "u" },
    ],
  });
  const ev = buildHealthAlertEvidence("many-cpu-processes", snap);
  assert.equal(ev.length, 1);
  assert.ok(ev[0].includes("procA") && ev[0].includes("82.0%"));
});

test("buildHealthAlertEvidence returns empty for unknown alert id", () => {
  const snap = makeSnapshot();
  assert.deepEqual(buildHealthAlertEvidence("unknown-id", snap), []);
});

test("buildHealthAlertEvidence stays empty when measurements are missing", () => {
  const snap = makeSnapshot({
    system: { ...makeInput().system, available: false },
    disks: [],
    topCpu: [],
    topRam: [],
    services: [],
  });
  assert.deepEqual(buildHealthAlertEvidence("ram-high", snap), []);
  assert.deepEqual(buildHealthAlertEvidence("disk-critical", snap), []);
  assert.deepEqual(buildHealthAlertEvidence("many-cpu-processes", snap), []);
  assert.deepEqual(buildHealthAlertEvidence("service-down", snap), []);
  const fw = buildHealthAlertEvidence("firewall-disabled", snap);
  assert.ok(fw.some((l) => l.includes("indisponível")));
});

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
  const snap = buildWindowsHealthSnapshot(input, "2025-01-01T00:00:00.000Z", []);
  assert.equal(snap.overallStatus, "good");
  assert.equal(snap.score, 100);
  assert.deepEqual(snap.errors, []);
  assert.equal(snap.collectedAt, "2025-01-01T00:00:00.000Z");
});

// ─── HONESTIDADE (WS-1): errors sem recomendação -> unknown ──────────────
// Antes: errors vazio ou com entradas, sem recs, dava sempre good + score 100.
// Agora: errors não vazio e sem recs críticas/attention -> unknown. critical e
// attention mantêm precedência. O score NAO muda (computeScore inalterado).

test("errors vazio, sem recomendacoes -> good, score 100 (comportamento actual)", () => {
  const snap = makeSnapshot();
  assert.equal(snap.overallStatus, "good");
  assert.equal(snap.score, 100);
});

test("errors com entradas, sem recomendacoes -> unknown", () => {
  const snap = buildWindowsHealthSnapshot(makeInput(), "2025-01-01T00:00:00.000Z", ["cmdlet unavailable"]);
  assert.equal(snap.overallStatus, "unknown");
  assert.equal(snap.score, 100);
  assert.deepEqual(snap.errors, ["cmdlet unavailable"]);
});

test("errors com entradas E uma recomendacao critical -> critical (precedencia)", () => {
  const input = makeInput({ system: { ...makeInput().system, ramUsagePercent: 92 } });
  const snap = buildWindowsHealthSnapshot(input, "2025-01-01T00:00:00.000Z", ["cmdlet unavailable"]);
  assert.equal(snap.overallStatus, "critical");
});

test("errors com entradas E uma recomendacao attention -> attention (precedencia)", () => {
  const input = makeInput({ system: { ...makeInput().system, ramUsagePercent: 80 } });
  const snap = buildWindowsHealthSnapshot(input, "2025-01-01T00:00:00.000Z", ["cmdlet unavailable"]);
  assert.equal(snap.overallStatus, "attention");
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
