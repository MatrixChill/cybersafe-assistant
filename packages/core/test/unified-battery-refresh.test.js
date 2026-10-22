import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * TP-BATTERY-C1-C2 — refresh da bateria no tick lento + contrato honesto.
 *
 * Defeito (README de evidência): `si.battery()` era chamado SÓ em `init()`;
 * o snapshot publicava esses valores para sempre (num portátil, o nível fica
 * congelado no arranque do serviço). Além disso, uma falha do provider era
 * indistinguível de "sem bateria" (`hasBattery:false` + `percent:0`).
 *
 * C1: refresh no tick lento (10 s), sem interval próprio e sem sobreposição.
 * C2: `battery.status` (`present|absent|unavailable|error`) — `absent` só com
 * leitura boa que confirma ausência; falha NUNCA vira "sem bateria".
 *
 * Nenhum teste faz I/O real: o seam `readBattery` é sobreposto (como o
 * `readNetworkStats` dos testes de rede) e os ticks pesados ficam desligados.
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
    this.batteryReads = 0;
    this.nextBattery = null;
    this.deferred = null;
  }

  async readBattery() {
    this.batteryReads += 1;
    if (this.deferred) return this.deferred.promise;
    if (this.nextBattery instanceof Error) throw this.nextBattery;
    return this.nextBattery;
  }
}

function engine() {
  return new SeamEngine();
}

const present = (percent, extra = {}) => ({
  hasBattery: true,
  percent,
  isCharging: false,
  timeRemaining: null,
  ...extra,
});
const absent = () => ({ hasBattery: false, percent: 0, isCharging: false, timeRemaining: null });

describe("Bateria: refresh e contrato honesto (C1/C2)", () => {
  it("present: leitura boa publica valor, estado e frescura; percent 0 é REAL", async () => {
    const e = engine();
    e.nextBattery = present(0);
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "present");
    assert.equal(s.battery.hasBattery, true);
    assert.equal(s.battery.percent, 0, "0% com bateria presente é uma medição válida");
    assert.equal(s.battery.source, "systeminformation");
    assert.ok(Number.isFinite(Date.parse(s.battery.updatedAt)), "updatedAt tem de ser ISO real");
  });

  it("ausência comprovada: o provider respondeu sem bateria → absent", async () => {
    const e = engine();
    e.nextBattery = absent();
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "absent");
    assert.equal(s.battery.hasBattery, false);
    assert.equal(s.battery.percent, 0, "0% sem bateria não é medição (status absent explica-o)");
  });

  it("falha do provider após leitura boa mantém o último valor (NUNCA absent)", async () => {
    const e = engine();
    e.nextBattery = present(55);
    await e.refreshBattery();
    const firstUpdatedAt = (await e.getSnapshot([])).battery.updatedAt;

    e.nextBattery = null; // falha
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "present", "uma falha não pode ser apresentada como ausência");
    assert.equal(s.battery.percent, 55);
    assert.equal(s.battery.hasBattery, true);
    assert.equal(s.battery.updatedAt, firstUpdatedAt, "a frescura continua a ser a da última leitura boa");
  });

  it("falha expirada (TTL 60 s) passa a unavailable — nunca absent", async () => {
    const e = engine();
    e.nextBattery = present(55);
    await e.refreshBattery();

    e.batteryState.updatedAt = Date.now() - 61_000;
    e.nextBattery = null;
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "unavailable");
    assert.notEqual(s.battery.status, "absent");
  });

  it("falha sem qualquer leitura boa = error (distinto de ausência)", async () => {
    const e = engine();
    e.nextBattery = null;
    await e.refreshBattery();

    const s = await e.getSnapshot([]);
    assert.equal(s.battery.status, "error");
    assert.equal(s.battery.updatedAt, undefined);
    assert.equal(s.battery.source, undefined, "sem leitura real não há fonte a declarar");
  });

  it("sem sobreposição: uma leitura por ciclo, mesmo com pedidos concorrentes", async () => {
    const e = engine();
    let resolveDeferred;
    e.deferred = { promise: new Promise((resolve) => { resolveDeferred = resolve; }) };

    const first = e.refreshBattery();
    const second = e.refreshBattery(); // deve sair cedo
    await second;
    assert.equal(e.batteryReads, 1, "o ciclo em curso não pode ser sobreposto");

    resolveDeferred(present(42));
    await first;
    e.deferred = null;
    e.nextBattery = present(43);
    await e.refreshBattery();
    assert.equal(e.batteryReads, 2);
    assert.equal((await e.getSnapshot([])).battery.percent, 43);
  });

  it("o refresh vive no tick lento: nenhum caminho paralelo nem interval próprio", async () => {
    const e = engine();
    e.nextBattery = present(70);

    // Snapshots com o tick lento desligado NÃO leem bateria (nada fora do ciclo).
    await e.getSnapshot([]);
    await e.getSnapshot([]);
    assert.equal(e.batteryReads, 0, "sem tick lento não há refresh de bateria");

    // Um conjunto de snapshots dentro da janela dispara UM refresh (fire-and-forget).
    const intervalSpy = [];
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = (...args) => {
      intervalSpy.push(args);
      return originalSetInterval(...args);
    };
    try {
      e.lastSlowTick = 0;
      await e.getSnapshot([]);
      await e.getSnapshot([]);
      await e.getSnapshot([]);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      globalThis.setInterval = originalSetInterval;
    }

    assert.equal(e.batteryReads, 1, "uma janela de 10 s = um único refresh");
    assert.equal(intervalSpy.length, 0, "a bateria não pode criar um interval próprio");
    assert.equal((await e.getSnapshot([])).battery.percent, 70);
  });
});
