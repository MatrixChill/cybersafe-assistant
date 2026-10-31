import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * TP-PAP-CPU-USAGE-TRUTH — comportamento de getSnapshot com falha REAL do
 * provider simulada no seam `readCpuLoad` (sem hardware I/O: init desligado,
 * disco já lido, ticks médio/lento desativados).
 *
 * Antes do fix, a linha `si.currentLoad().catch(() => null)` + `?? 0`
 * publicava 0% indistinguível de CPU ociosa (reproduzido em cópia do dist
 * pré-fix: último bom 37, controlo 16, falha → 0).
 */

class SeamEngine extends HardwareHealthEngine {
  constructor() {
    super();
    this.initialized = true;
    this.diskReadAttempted = true;
    this.diskSnapshot = initialDiskSnapshot();
    this.lastMediumTick = Date.now();
    this.lastSlowTick = Date.now();
    this.nextLoad = null;
  }

  async readCpuLoad() {
    if (this.nextLoad instanceof Error) throw this.nextLoad;
    return this.nextLoad;
  }

  async snapshot() {
    this.lastFastTick = 0; // força o tick rápido no getSnapshot
    return this.getSnapshot([]);
  }
}

describe("CPU usage truth — getSnapshot", () => {
  it("leitura válida publica o valor e estado available", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 42 };
    const snap = await e.snapshot();
    assert.equal(snap.cpu.usage, 42);
    assert.equal(snap.cpu.usageStatus, "available");
    assert.ok(snap.cpu.usageUpdatedAt, "deve trazer o instante da leitura boa");
  });

  it("0% REAL é válido: CPU ociosa não é erro", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 0 };
    const snap = await e.snapshot();
    assert.equal(snap.cpu.usage, 0);
    assert.equal(snap.cpu.usageStatus, "available", "0 medido tem de ser available, não unavailable");
  });

  it("falha do provider NÃO publica 0: mantém o último valor bom como stale", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 37 };
    await e.snapshot();

    e.nextLoad = null; // simula currentLoad a rejeitar/indisponível
    const snap = await e.snapshot();
    assert.equal(snap.cpu.usage, 37, "a falha jamais pode virar 0% medido");
    assert.equal(snap.cpu.usageStatus, "stale");
  });

  it("erro lançado pelo seam também é falha, não 0", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 55 };
    await e.snapshot();

    e.nextLoad = new Error("provider indisponível");
    const snap = await e.snapshot();
    assert.equal(snap.cpu.usage, 55);
    assert.equal(snap.cpu.usageStatus, "stale");
  });

  it("passado o TTL sem nova leitura boa → unavailable (o número deixa de ser atual)", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 42 };
    await e.snapshot();

    e.nextLoad = null;
    e.cpuUsageState.updatedAt = Date.now() - 4_000; // > 3 s
    const snap = await e.snapshot();
    assert.equal(snap.cpu.usageStatus, "unavailable");
    assert.equal(snap.cpu.usage, 42, "o último número não é apagado, mas também não é apresentável");
  });

  it("sem qualquer leitura boa desde o arranque → unavailable (nunca available por omissão)", async () => {
    const e = new SeamEngine();
    e.nextLoad = null;
    const snap = await e.snapshot();
    assert.equal(snap.cpu.usageStatus, "unavailable");
    assert.equal(snap.cpu.usage, 0, "valor de inicialização; o estado diz que NÃO é medição");
  });

  it("valores malformados (NaN, negativo, >100, string) contam como falha, nunca como 0", async () => {
    for (const bad of [Number.NaN, -1, 101, "16", Infinity]) {
      const e = new SeamEngine();
      e.nextLoad = { currentLoad: 48 };
      await e.snapshot();

      e.nextLoad = { currentLoad: bad };
      const snap = await e.snapshot();
      assert.equal(snap.cpu.usage, 48, `valor inválido ${String(bad)} não pode substituir o último bom`);
      assert.equal(snap.cpu.usageStatus, "stale", `valor inválido ${String(bad)} tem de ser falha`);
    }
  });

  it("a idade é recalculada no snapshot mesmo sem novo tick", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 42 };
    await e.snapshot();

    e.cpuUsageState.updatedAt = Date.now() - 4_000;
    e.lastFastTick = Date.now(); // tick rápido desligado: nada releu
    const snap = await e.getSnapshot([]);
    assert.equal(snap.cpu.usageStatus, "unavailable");
  });

  it("B1 integra no snapshot público: temperatura fresca e expirada", async () => {
    const e = new SeamEngine();

    e.applyCpuTemperature(57);
    let snap = await e.snapshot();
    assert.equal(snap.cpu.temperature, 57);
    assert.equal(snap.cpu.temperatureStatus, "available");

    e.cpuTempState.updatedAt = Date.now() - 60_000;
    snap = await e.snapshot();
    assert.equal(snap.cpu.temperature, null);
    assert.equal(snap.cpu.temperatureStatus, "unavailable");
  });

  it("uso expirado (TTL) não continua a alimentar o stress nem o alerta de CPU", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 96 };

    let snap = await e.snapshot();
    assert.equal(snap.cpu.usageStatus, "available");
    assert.equal(snap.stressContributions.cpu, 35, "96% atual contribui para o stress");
    assert.ok(snap.alerts.some((a) => a.category === "cpu"), "96% atual gera alerta de CPU");

    // O TTL expira sem novo tick: o número deixa de ser medição ATUAL.
    e.cpuUsageState.updatedAt = Date.now() - 4_000;
    e.lastFastTick = Date.now();
    snap = await e.getSnapshot([]);

    assert.equal(snap.cpu.usageStatus, "unavailable");
    assert.equal(snap.stressContributions.cpu, 0, "valor expirado não pode somar stress como se fosse agora");
    assert.ok(
      !snap.alerts.some((a) => a.category === "cpu" && /CPU elevada/i.test(a.title)),
      "valor expirado não pode manter o alerta de CPU elevada",
    );
  });

  it("uso stale (falha recente) também não é tratado como medição atual no stress", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 96 };
    await e.snapshot();

    e.nextLoad = null; // poll falhada, ainda dentro do TTL
    const snap = await e.snapshot();
    assert.equal(snap.cpu.usageStatus, "stale");
    assert.equal(snap.stressContributions.cpu, 0);
    assert.ok(!snap.alerts.some((a) => a.category === "cpu" && /CPU elevada/i.test(a.title)));
  });

  it("0% atual continua válido e neutro no stress; unavailable inicial é neutro com estado explícito", async () => {
    const e = new SeamEngine();
    e.nextLoad = { currentLoad: 0 };
    let snap = await e.snapshot();
    assert.equal(snap.cpu.usageStatus, "available");
    assert.equal(snap.stressContributions.cpu, 0);
    assert.ok(!snap.alerts.some((a) => a.category === "cpu"));

    const cold = new SeamEngine();
    cold.nextLoad = null;
    snap = await cold.snapshot();
    assert.equal(snap.cpu.usageStatus, "unavailable");
    assert.equal(snap.stressContributions.cpu, 0);
    assert.ok(!snap.alerts.some((a) => a.category === "cpu"));
  });
});
