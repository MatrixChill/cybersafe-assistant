import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
