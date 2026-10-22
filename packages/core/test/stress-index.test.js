import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the stress index calculation logic.
 *
 * The calculateStress method is private on HardwareHealthEngine, so we test
 * the formula contract and state mapping via pure unit logic — no hardware init.
 */

// ── State normalization (mirrors native-windows snapshotConnections logic) ──
const STATE_MAP = {
  "1": "Listen", "2": "SynSent", "3": "SynReceived", "4": "Established",
  "5": "FinWait1", "6": "FinWait2", "7": "CloseWait", "8": "Closing",
  "9": "LastAck", "10": "TimeWait", "11": "DeleteTCB", "12": "Bound",
  "Listen": "Listen", "SynSent": "SynSent", "SynReceived": "SynReceived",
  "Established": "Established", "FinWait1": "FinWait1", "FinWait2": "FinWait2",
  "CloseWait": "CloseWait", "Closing": "Closing", "LastAck": "LastAck",
  "TimeWait": "TimeWait", "DeleteTCB": "DeleteTCB",
};
function normalizeState(raw) {
  if (!raw) return "Desconhecido";
  return STATE_MAP[raw] ?? "Desconhecido";
}

// ── Stress score formula (mirrors hardware.ts calculateStress) ──
function calculateStressScore(cpu, ram, temp) {
  let score = 0;
  const contributions = { cpu: 0, ram: 0, temperature: 0, gpu: 0 };
  // CPU (max 35 pts)
  if (cpu > 90) { score += 35; contributions.cpu = 35; }
  else if (cpu > 75) { score += 15; contributions.cpu = 15; }
  // RAM (max 30 pts)
  if (ram > 85) { score += 30; contributions.ram = 30; }
  else if (ram > 70) { score += 10; contributions.ram = 10; }
  // Temperature (max 25 pts)
  if (temp !== null && temp > 0) {
    if (temp > 80) { score += 25; contributions.temperature = 25; }
    else if (temp > 70) { score += 10; contributions.temperature = 10; }
  }
  return { score: Math.min(100, score), contributions };
}

describe("Stress score formula", () => {
  it("low load → score 0", () => {
    assert.equal(calculateStressScore(20, 30, 45).score, 0);
  });

  it("high CPU only → 35", () => {
    assert.equal(calculateStressScore(95, 30, 45).score, 35);
  });

  it("high RAM only → 30", () => {
    assert.equal(calculateStressScore(20, 90, 45).score, 30);
  });

  it("high temperature only → 25", () => {
    assert.equal(calculateStressScore(20, 30, 85).score, 25);
  });

  it("all high → max possible (35+30+25=90, clamped)", () => {
    const result = calculateStressScore(99, 99, 95);
    assert.equal(result.score, 90);
    assert.equal(result.contributions.cpu, 35);
    assert.equal(result.contributions.ram, 30);
    assert.equal(result.contributions.temperature, 25);
  });

  it("missing temperature (null) does not contribute", () => {
    const withTemp = calculateStressScore(95, 90, 85);
    const withoutTemp = calculateStressScore(95, 90, null);
    assert.ok(withTemp.score > withoutTemp.score);
  });

  it("temperature 0 does not contribute (sensor unavailable)", () => {
    assert.equal(calculateStressScore(20, 30, 0).score, 0);
  });

  it("moderate CPU + moderate RAM = 25 (15+10)", () => {
    assert.equal(calculateStressScore(80, 75, 45).score, 25);
  });

  it("disk capacity does NOT contribute (no disk param in formula)", () => {
    const c = calculateStressScore(95, 90, 85);
    assert.equal("disk" in c.contributions, false, "disk should not be in contributions");
  });

  it("contributions are non-negative", () => {
    const c = calculateStressScore(95, 90, 85);
    assert.ok(c.contributions.cpu >= 0);
    assert.ok(c.contributions.ram >= 0);
    assert.ok(c.contributions.temperature >= 0);
    assert.ok(c.contributions.gpu >= 0);
  });

  it("cenário observado: CPU 13% + RAM 57% + sem sensor → 0/100 (limiares, não ausência de dados)", () => {
    // O Stress Index só conta carga ACIMA dos limiares de stress; 13% de CPU e
    // 57% de RAM são normais. Series 0 porque não há stress, não porque falte
    // leitura (ambas as métricas existem).
    const result = calculateStressScore(13, 57, null);
    assert.equal(result.score, 0);
    assert.equal(result.contributions.cpu, 0);
    assert.equal(result.contributions.ram, 0);
    assert.equal(result.contributions.temperature, 0);
  });

  it("86% de disco não entra no índice instantâneo (finding de saúde separado)", () => {
    // A assinatura da fórmula nem sequer recebe disco — fixado para nunca regredir.
    assert.equal(calculateStressScore.length, 3);
    const result = calculateStressScore(10, 20, null);
    assert.equal(result.score, 0);
  });
});

describe("TCP state normalization", () => {
  it("numeric '1' → Listen", () => assert.equal(normalizeState("1"), "Listen"));
  it("numeric '4' → Established", () => assert.equal(normalizeState("4"), "Established"));
  it("numeric '10' → TimeWait", () => assert.equal(normalizeState("10"), "TimeWait"));
  it("numeric '100' → Desconhecido (unknown)", () => assert.equal(normalizeState("100"), "Desconhecido"));
  it("string 'Established' passes through", () => assert.equal(normalizeState("Established"), "Established"));
  it("string 'Listen' passes through", () => assert.equal(normalizeState("Listen"), "Listen"));
  it("empty string → Desconhecido", () => assert.equal(normalizeState(""), "Desconhecido"));
  it("random string → Desconhecido", () => assert.equal(normalizeState("SomethingWeird"), "Desconhecido"));
});
