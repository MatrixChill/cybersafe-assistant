import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpuUsageDisplay, cpuUsageForNarrative } from "../src/lib/cpuUsage";

/**
 * TP-PAP-CPU-USAGE-TRUTH — helper central da UI/assistente.
 * Uma falha de leitura nunca pode aparecer como "0%"; 0 medido continua a ser
 * um valor real e distinguível (state available).
 */

const base = { usage: 42, usageStatus: "available" as const, usageUpdatedAt: "2026-10-18T12:00:00.000Z" };

describe("cpuUsageDisplay", () => {
  it("leitura disponível mostra o valor", () => {
    const d = cpuUsageDisplay(base);
    assert.equal(d.state, "available");
    assert.equal(d.value, 42);
    assert.equal(d.text, "42%");
    assert.equal(d.hint, null);
  });

  it("0% REAL é apresentável (CPU ociosa medida)", () => {
    const d = cpuUsageDisplay({ ...base, usage: 0 });
    assert.equal(d.state, "available");
    assert.equal(d.value, 0);
    assert.equal(d.text, "0%", "0 medido é diferente de ausência de leitura");
  });

  it("stale mostra o último valor bom com rótulo de última leitura", () => {
    const d = cpuUsageDisplay({ ...base, usageStatus: "stale" });
    assert.equal(d.state, "stale");
    assert.equal(d.value, 42);
    assert.match(d.text, /última leitura/i);
    assert.ok(d.hint);
  });

  it("unavailable não mostra número nenhum (nunca '0%')", () => {
    const d = cpuUsageDisplay({ ...base, usage: 0, usageStatus: "unavailable" });
    assert.equal(d.state, "unavailable");
    assert.equal(d.value, null);
    assert.equal(d.text, "Sem leitura");
    assert.ok(!d.text.includes("0%"));
  });

  it("error é tratado como indisponível", () => {
    const d = cpuUsageDisplay({ ...base, usageStatus: "error" });
    assert.equal(d.state, "unavailable");
    assert.equal(d.value, null);
  });

  it("valores malformados são indisponíveis, não 0", () => {
    for (const usage of [Number.NaN, -1, 101, Infinity]) {
      const d = cpuUsageDisplay({ ...base, usage });
      assert.equal(d.state, "unavailable", `usage ${String(usage)}`);
      assert.equal(d.value, null);
      assert.ok(!d.text.includes("0%"));
    }
  });

  it("snapshot antigo sem usageStatus mantém o comportamento anterior (compatibilidade)", () => {
    const d = cpuUsageDisplay({ usage: 16 });
    assert.equal(d.state, "available");
    assert.equal(d.value, 16);
    assert.equal(d.text, "16%");
  });

  it("sem CPU/snapshot é indisponível, não 0", () => {
    for (const input of [null, undefined, {} as never]) {
      const d = cpuUsageDisplay(input as never);
      assert.equal(d.state, "unavailable");
      assert.equal(d.value, null);
      assert.equal(d.text, "Sem leitura");
    }
  });
});

describe("cpuUsageForNarrative", () => {
  it("só entrega medições atuais", () => {
    assert.equal(cpuUsageForNarrative(base), 42);
    assert.equal(cpuUsageForNarrative({ ...base, usage: 0 }), 0, "0 medido é uma medição real");
    assert.equal(cpuUsageForNarrative({ ...base, usageStatus: "stale" }), null);
    assert.equal(cpuUsageForNarrative({ ...base, usageStatus: "unavailable" }), null);
    assert.equal(cpuUsageForNarrative({ ...base, usageStatus: "error" }), null);
  });

  it("nunca inventa 0 quando não há leitura", () => {
    assert.equal(cpuUsageForNarrative(null), null);
    assert.equal(cpuUsageForNarrative({ usage: Number.NaN }), null);
    assert.equal(cpuUsageForNarrative({ usage: 42, usageStatus: "unavailable" }), null);
  });
});
