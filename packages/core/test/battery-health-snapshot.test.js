import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * FASE 1 — integração da saúde da bateria no `HardwareSnapshot`.
 *
 * Verifica o contrato publicado ao serviço/UI, não o cálculo (esse está em
 * `battery-health.test.js`). Nenhum teste faz I/O real: o seam `readBattery`
 * é sobreposto e os ticks pesados ficam desligados.
 */

class SeamEngine extends HardwareHealthEngine {
  constructor() {
    super();
    this.initialized = true;
    this.diskReadAttempted = true;
    this.diskSnapshot = initialDiskSnapshot();
    this.lastFastTick = Date.now();
    this.lastMediumTick = Date.now();
    this.lastSlowTick = Date.now();
    this.nextBattery = null;
  }

  async readBattery() {
    if (this.nextBattery instanceof Error) throw this.nextBattery;
    return this.nextBattery;
  }
}

const presente = (extra = {}) => ({
  hasBattery: true,
  percent: 72,
  isCharging: false,
  timeRemaining: 140,
  designedCapacity: 57_000,
  maxCapacity: 46_000,
  capacityUnit: "mWh",
  cycleCount: 320,
  ...extra,
});

describe("Snapshot: saúde da bateria publicada com contrato honesto", () => {
  it("bateria presente com capacidades → saúde, desgaste, ciclos e capacidades", async () => {
    const e = new SeamEngine();
    e.nextBattery = presente();
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "present");
    assert.equal(s.battery.healthStatus, "available");
    assert.equal(s.battery.healthPercent, 81);
    assert.equal(s.battery.wearPercent, 19);
    assert.equal(s.battery.designCapacityWh, 57);
    assert.equal(s.battery.maxCapacityWh, 46);
    assert.equal(s.battery.cycleCount, 320);
    assert.equal(s.battery.healthDetail, undefined, "sem motivo quando está disponível");
  });

  it("desktop sem bateria → healthStatus absent e nenhum número", async () => {
    const e = new SeamEngine();
    e.nextBattery = {
      hasBattery: false,
      percent: 0,
      isCharging: false,
      timeRemaining: null,
      designedCapacity: 0,
      maxCapacity: 0,
      capacityUnit: "",
      cycleCount: 0,
    };
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "absent");
    assert.equal(s.battery.healthStatus, "absent");
    assert.equal(s.battery.healthPercent, null);
    assert.equal(s.battery.cycleCount, null);
    assert.match(s.battery.healthDetail, /não é aplicável/);
  });

  it("bateria presente sem capacidades → unsupported com explicação", async () => {
    const e = new SeamEngine();
    e.nextBattery = presente({ designedCapacity: 0, maxCapacity: 0, cycleCount: 0 });
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "present");
    assert.equal(s.battery.healthStatus, "unsupported");
    assert.equal(s.battery.healthPercent, null);
    assert.ok(s.battery.healthDetail && s.battery.healthDetail.length > 0, "tem de explicar");
  });

  it("leitura implausível → invalid, sem saúde inventada", async () => {
    const e = new SeamEngine();
    e.nextBattery = presente({ designedCapacity: 50_000, maxCapacity: 90_000 });
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.healthStatus, "invalid");
    assert.equal(s.battery.healthPercent, null);
  });

  it("falha do provider → sem campos de saúde (o estado de carga explica)", async () => {
    const e = new SeamEngine();
    e.nextBattery = new Error("WMI indisponível");
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "error");
    assert.equal(s.battery.healthStatus, undefined);
    assert.equal(s.battery.healthPercent, undefined);
  });

  it("leitura expirada → sem saúde publicada (não há leitura actual)", async () => {
    const e = new SeamEngine();
    e.nextBattery = presente();
    await e.refreshBattery();

    e.batteryState.updatedAt = Date.now() - 61_000;
    e.nextBattery = null;
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "unavailable");
    assert.equal(s.battery.healthPercent, undefined);
    assert.equal(s.battery.healthStatus, undefined);
  });

  it("a saúde não altera os campos de compatibilidade", async () => {
    const e = new SeamEngine();
    e.nextBattery = presente({ percent: 72, isCharging: true });
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.hasBattery, true);
    assert.equal(s.battery.percent, 72);
    assert.equal(s.battery.isCharging, true);
    assert.equal(s.battery.source, "systeminformation");
    assert.ok(Number.isFinite(Date.parse(s.battery.updatedAt)));
  });
});
