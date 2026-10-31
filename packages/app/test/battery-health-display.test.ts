import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batteryDisplay } from "../src/lib/batteryDisplay";

/**
 * FASE 1 — apresentação da saúde da bateria.
 *
 * Regras: «Não aplicável» só com ausência comprovada; «Indisponível» com o
 * motivo real (nunca 0% de saúde); valores sempre com a capacidade que os
 * originou.
 */

const presente = (extra: Record<string, unknown> = {}) => ({
  hasBattery: true,
  percent: 72,
  isCharging: false,
  timeRemaining: 140,
  status: "present" as const,
  healthStatus: "available" as const,
  healthPercent: 81,
  wearPercent: 19,
  designCapacityWh: 57,
  maxCapacityWh: 46,
  cycleCount: 320,
  ...extra,
});

describe("PC Center: saúde da bateria", () => {
  it("bateria saudável → percentagem de saúde, capacidades e ciclos", () => {
    const d = batteryDisplay(presente(), "LIVE");
    assert.equal(d.healthText, "81% de saúde");
    assert.equal(d.capacityText, "46 Wh de 57 Wh");
    assert.equal(d.cyclesText, "320 ciclos de carga");
    assert.equal(d.healthHint, "Desgaste de 19%.");
  });

  it("desgaste zero → diz que não há desgaste medido", () => {
    const d = batteryDisplay(presente({ healthPercent: 100, wearPercent: 0 }), "LIVE");
    assert.equal(d.healthText, "100% de saúde");
    assert.equal(d.healthHint, "Sem desgaste medido.");
  });

  it("capacidades decimais usam vírgula PT", () => {
    const d = batteryDisplay(presente({ designCapacityWh: 57.4, maxCapacityWh: 45.7 }), "LIVE");
    assert.equal(d.capacityText, "45,7 Wh de 57,4 Wh");
  });

  it("sem bateria → «Não aplicável», nunca 0%", () => {
    const d = batteryDisplay(
      {
        hasBattery: false,
        percent: 0,
        isCharging: false,
        timeRemaining: null,
        status: "absent" as const,
        healthStatus: "absent" as const,
        healthPercent: null,
        wearPercent: null,
        cycleCount: null,
      },
      "LIVE",
    );
    assert.equal(d.label, "Sem bateria");
    assert.equal(d.healthText, "Não aplicável");
    assert.equal(d.healthHint, "Este computador não tem bateria.");
    assert.equal(d.capacityText, null);
  });

  it("firmware sem capacidades → «Indisponível» com o motivo", () => {
    const d = batteryDisplay(
      presente({
        healthStatus: "unsupported",
        healthPercent: null,
        wearPercent: null,
        designCapacityWh: null,
        maxCapacityWh: null,
        healthDetail: "O firmware desta bateria não reporta as capacidades (original e máxima).",
      }),
      "LIVE",
    );
    assert.equal(d.healthText, "Indisponível");
    assert.match(d.healthHint ?? "", /não reporta as capacidades/);
    assert.equal(d.capacityText, null);
  });

  it("leitura implausível → «Indisponível» com o motivo, sem número", () => {
    const d = batteryDisplay(
      presente({
        healthStatus: "invalid",
        healthPercent: null,
        wearPercent: null,
        healthDetail: "A capacidade máxima é superior à original.",
      }),
      "LIVE",
    );
    assert.equal(d.healthText, "Indisponível");
    assert.match(d.healthHint ?? "", /superior à original/);
  });

  it("snapshot antigo sem campos de saúde → não inventa saúde", () => {
    const d = batteryDisplay(
      { hasBattery: true, percent: 50, isCharging: false, timeRemaining: null },
      "LIVE",
    );
    assert.equal(d.healthText, null);
    assert.equal(d.capacityText, null);
    assert.equal(d.cyclesText, null);
    assert.equal(d.healthHint, null);
    assert.equal(d.percentText, "50%", "o resto do cartão continua a funcionar");
  });

  it("ciclos 0 não é apresentado como zero ciclos", () => {
    const d = batteryDisplay(presente({ cycleCount: 0 }), "LIVE");
    assert.equal(d.cyclesText, null);
  });

  it("healthPercent fora de 0–100 é truncado, não propagado", () => {
    const d = batteryDisplay(presente({ healthPercent: 140, wearPercent: -20 }), "LIVE");
    assert.equal(d.healthText, "100% de saúde");
    assert.equal(d.healthHint, "Sem desgaste medido.");
  });
});
