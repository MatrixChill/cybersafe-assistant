import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeBatteryHealth } from "../dist/battery-health.js";

/**
 * FASE 1 — saúde da bateria (capacidades → saúde publicável).
 *
 * Regra do módulo: só se publica o que foi medido. Uma bateria presente com
 * capacidades a 0 é "indisponível com motivo", nunca 0% de saúde; uma
 * capacidade em mAh não é convertida sem tensão; uma leitura implausível não
 * produz saúde.
 *
 * Nenhum teste toca em WMI: o módulo é puro.
 */

const VALIDO = {
  hasBattery: true,
  designedCapacity: 57_000,
  maxCapacity: 46_000,
  capacityUnit: "mWh",
  cycleCount: 320,
};

describe("Saúde da bateria: cálculos e estados", () => {
  it("capacidades válidas em mWh → saúde e desgaste calculados", () => {
    const h = describeBatteryHealth(VALIDO);
    assert.equal(h.status, "available");
    assert.equal(h.detail, null);
    assert.equal(h.designWh, 57);
    assert.equal(h.maxWh, 46);
    assert.equal(h.healthPercent, 81, "46000/57000 = 80,7% → 81%");
    assert.equal(h.wearPercent, 19, "100 − 81");
    assert.equal(h.cycleCount, 320);
  });

  it("sem bateria → absent, sem números inventados", () => {
    const h = describeBatteryHealth({
      hasBattery: false,
      designedCapacity: 0,
      maxCapacity: 0,
      capacityUnit: "",
      cycleCount: 0,
    });
    assert.equal(h.status, "absent");
    assert.equal(h.healthPercent, null);
    assert.equal(h.wearPercent, null);
    assert.equal(h.designWh, null);
    assert.match(h.detail, /não é aplicável/);
  });

  it("bateria presente sem capacidades (0/0) → unsupported com motivo, nunca 0%", () => {
    const h = describeBatteryHealth({ ...VALIDO, designedCapacity: 0, maxCapacity: 0 });
    assert.equal(h.status, "unsupported");
    assert.equal(h.healthPercent, null);
    assert.match(h.detail, /não reporta as capacidades/);
    assert.equal(h.cycleCount, 320, "os ciclos continuam a ser publicáveis");
  });

  it("capacidades em falta (undefined) não lançam e não produzem saúde", () => {
    const h = describeBatteryHealth({ hasBattery: true, capacityUnit: "mWh" });
    assert.equal(h.status, "unsupported");
    assert.equal(h.healthPercent, null);
  });

  it("mAh sem tensão → unsupported; não se inventa uma tensão", () => {
    const h = describeBatteryHealth({
      hasBattery: true,
      designedCapacity: 4_800,
      maxCapacity: 4_000,
      capacityUnit: "mAh",
    });
    assert.equal(h.status, "unsupported");
    assert.equal(h.healthPercent, null);
    assert.equal(h.designWh, null);
    assert.match(h.detail, /mAh/);
  });

  it("unidade ausente → unsupported, sem conversão", () => {
    const h = describeBatteryHealth({ ...VALIDO, capacityUnit: "" });
    assert.equal(h.status, "unsupported");
    assert.equal(h.healthPercent, null);
  });

  it("capacidade fora do plausível → invalid", () => {
    const h = describeBatteryHealth({ ...VALIDO, designedCapacity: 999, maxCapacity: 900 });
    assert.equal(h.status, "invalid");
    assert.equal(h.healthPercent, null);
    assert.match(h.detail, /plausível/);
  });

  it("máxima acima da original além da tolerância → invalid", () => {
    const h = describeBatteryHealth({ ...VALIDO, designedCapacity: 50_000, maxCapacity: 80_000 });
    assert.equal(h.status, "invalid");
    assert.equal(h.healthPercent, null);
    assert.match(h.detail, /tolerância/);
  });

  it("máxima ligeiramente acima da original (arredondamento) → 100% e 0% desgaste", () => {
    const h = describeBatteryHealth({ ...VALIDO, designedCapacity: 50_000, maxCapacity: 51_000 });
    assert.equal(h.status, "available");
    assert.equal(h.healthPercent, 100, "nunca 102%");
    assert.equal(h.wearPercent, 0);
  });

  it("bateria muito gasta → saúde baixa, sem valor negativo", () => {
    const h = describeBatteryHealth({ ...VALIDO, designedCapacity: 60_000, maxCapacity: 12_000 });
    assert.equal(h.healthPercent, 20);
    assert.equal(h.wearPercent, 80);
  });

  it("ciclos: 0 é indistinguível de não reportado → null", () => {
    assert.equal(describeBatteryHealth({ ...VALIDO, cycleCount: 0 }).cycleCount, null);
  });

  it("ciclos: contador corrompido é rejeitado", () => {
    assert.equal(describeBatteryHealth({ ...VALIDO, cycleCount: 500_000 }).cycleCount, null);
    assert.equal(describeBatteryHealth({ ...VALIDO, cycleCount: -3 }).cycleCount, null);
    assert.equal(describeBatteryHealth({ ...VALIDO, cycleCount: 12.5 }).cycleCount, null);
  });

  it("valores numéricos em texto são aceites (o provider varia entre builds)", () => {
    const h = describeBatteryHealth({
      hasBattery: true,
      designedCapacity: "57000",
      maxCapacity: "46000",
      capacityUnit: "mWh",
    });
    assert.equal(h.status, "available");
    assert.equal(h.healthPercent, 81);
  });

  it("NaN e Infinity não produzem saúde", () => {
    assert.equal(
      describeBatteryHealth({ ...VALIDO, designedCapacity: Number.NaN }).status,
      "unsupported",
    );
    assert.equal(
      describeBatteryHealth({ ...VALIDO, maxCapacity: Number.POSITIVE_INFINITY }).status,
      "unsupported",
    );
  });

  it("nunca lança com entradas hostis", () => {
    for (const input of [null, undefined, {}, { hasBattery: true }, { hasBattery: "true" }]) {
      assert.doesNotThrow(() => describeBatteryHealth(input));
    }
  });
});
