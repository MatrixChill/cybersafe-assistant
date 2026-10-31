import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * TP-HARDWARE-MEASURED-CONTRACT — distinguir RAM MEDIDA de defaults a zero.
 *
 * Defeito (evidence/PC-VERDICT-TRUTH.md §2): `fastMetrics.ramPercent` nascia a 0
 * sem qualquer estado e era publicado no snapshot desde o primeiro instante; um
 * 0 sem amostra era indistinguível de "RAM ociosa medida" e alimentava o stress.
 * A CPU já tinha `usageStatus`; a RAM não.
 *
 * Contrato revisto (revisão Codex):
 *  - `usagePercent`/`usedGb` só têm NÚMEROS com uma leitura ATUAL (`available`);
 *    sob `stale`/`unavailable` são `null` — nunca a leitura antiga com ar de atual.
 *  - `usageLastGoodPercent` + `usageUpdatedAt` retêm a última leitura BOA mesmo
 *    depois do TTL (exibição CACHED) — não é carga atual e NÃO entra no stress.
 *  - `totalGb` é propriedade da máquina (capacidade instalada), mantém-se número.
 *  - Ausência de `usageStatus` = estado NÃO CONFIRMADO (legado): não implica
 *    `available` nem autoriza ler o número como medição (política do consumidor).
 *
 * Não faz I/O real: os seams `readRam`/`readCpuLoad` são sobrepostos e os ticks
 * médio/lento ficam desligados (padrão do unified-battery-refresh.test.js).
 */

class RamSeamEngine extends HardwareHealthEngine {
  constructor({ fastTick = true } = {}) {
    super();
    this.initialized = true;
    this.diskReadAttempted = true;
    this.diskSnapshot = initialDiskSnapshot();
    const now = Date.now();
    this.lastMediumTick = now;
    this.lastSlowTick = now;
    // fastTick=true => o próximo getSnapshot colhe a RAM (sem I/O real).
    this.lastFastTick = fastTick ? 0 : now;
    this.ramReads = 0;
    this.nextRam = null;
  }

  readRam() {
    this.ramReads += 1;
    return this.nextRam;
  }

  async readCpuLoad() {
    return null;
  }
}

const engine = (opts) => new RamSeamEngine(opts);

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

describe("RAM: medido vs default a zero (contrato aditivo)", () => {
  it("arranque sem amostra: unavailable, sem número com ar de medição", async () => {
    const e = engine({ fastTick: false }); // tick rápido não corre => nenhuma leitura
    const s = await e.getSnapshot([]);

    assert.equal(s.ram.usageStatus, "unavailable");
    assert.equal(s.ram.usageUpdatedAt, undefined, "sem leitura boa não há timestamp");
    assert.equal(s.ram.usagePercent, null, "não há leitura atual");
    assert.equal(s.ram.usedGb, null, "não há leitura atual");
    assert.equal(s.ram.usageLastGoodPercent, null, "nunca houve leitura boa");
    assert.ok(s.ram.totalGb === null || s.ram.totalGb > 0, "capacidade: desconhecida (null) ou medida (> 0) — nunca 0 GB");
    assert.equal(s.cpu.usageStatus, "unavailable", "simetria com a CPU");
    assert.equal(s.stressContributions.ram, 0);
  });

  it("0 % REAL é uma medição válida e fica available", async () => {
    const e = engine();
    e.nextRam = { percent: 0, usedGb: 0, totalGb: 16 };
    const s = await e.getSnapshot([]);

    assert.equal(s.ram.usageStatus, "available");
    assert.equal(s.ram.usagePercent, 0, "0% medido é válido");
    assert.equal(s.ram.usageLastGoodPercent, 0);
    assert.ok(Number.isFinite(Date.parse(s.ram.usageUpdatedAt)), "updatedAt ISO real");
  });

  it("leitura boa publica valores, frescura e última leitura boa", async () => {
    const e = engine();
    e.nextRam = { percent: 45, usedGb: 7.2, totalGb: 16 };
    const s = await e.getSnapshot([]);

    assert.equal(s.ram.usageStatus, "available");
    assert.equal(s.ram.usagePercent, 45);
    assert.equal(s.ram.usedGb, 7.2);
    assert.equal(s.ram.totalGb, 16);
    assert.equal(s.ram.usageLastGoodPercent, 45);
  });

  it("falha depois de leitura boa: stale, sem número atual mas com a última boa", async () => {
    const e = engine();
    e.nextRam = { percent: 45, usedGb: 7.2, totalGb: 16 };
    const first = await e.getSnapshot([]);
    assert.equal(first.ram.usageStatus, "available");

    // Sem avançar o relógio: a próxima leitura falha dentro do TTL.
    e.lastFastTick = 0;
    e.nextRam = null;
    const second = await e.getSnapshot([]);

    assert.equal(second.ram.usageStatus, "stale");
    assert.equal(second.ram.usagePercent, null, "stale não é leitura atual");
    assert.equal(second.ram.usedGb, null);
    assert.equal(second.ram.usageLastGoodPercent, 45, "última boa retida para CACHED");
    assert.equal(second.ram.usageUpdatedAt, first.ram.usageUpdatedAt);
    assert.equal(second.stressContributions.ram, 0, "stale nunca entra no stress");
  });

  it("leitura expirada: unavailable, última boa retida (não descartada)", async () => {
    const e = engine();
    e.nextRam = { percent: 45, usedGb: 7.2, totalGb: 16 };
    await e.getSnapshot([]);

    e.lastFastTick = 0;
    e.nextRam = null;
    await e.getSnapshot([]); // fica stale

    // Avança além do TTL (3 s) sem novas leituras boas.
    Date.now = () => realNow() + 10_000;
    e.lastFastTick = 0;
    const s = await e.getSnapshot([]);

    assert.equal(s.ram.usageStatus, "unavailable");
    assert.equal(s.ram.usagePercent, null);
    assert.equal(s.ram.usedGb, null);
    assert.equal(s.ram.usageLastGoodPercent, 45, "CACHED preservado após expirar");
    assert.ok(Number.isFinite(Date.parse(s.ram.usageUpdatedAt)), "timestamp da última boa");
    assert.equal(typeof s.ram.totalGb, "number", "capacidade não depende da medição");
    assert.equal(s.stressContributions.ram, 0);
  });

  it("erro do provider nunca é convertido em 0 medido (nem em stress)", async () => {
    const e = engine();
    e.nextRam = null; // falha desde o arranque
    const s = await e.getSnapshot([]);

    assert.equal(s.ram.usageStatus, "unavailable");
    assert.equal(s.ram.usagePercent, null, "nenhum 0 inventado");
    assert.equal(s.ram.usageLastGoodPercent, null);
    assert.equal(s.stressContributions.ram, 0);
  });

  it("snapshots concorrentes: sem exceções e sem estado inventado", async () => {
    const e = engine();
    e.nextRam = { percent: 60, usedGb: 9.6, totalGb: 16 };
    const [a, b] = await Promise.all([e.getSnapshot([]), e.getSnapshot([])]);

    // O snapshot que corre o tick publica a leitura; o concorrente que apanha o
    // tick ainda em voo publica o estado honesto ANTERIOR (unavailable) — nunca
    // um 0 disfarçado de medição — sem exceções nem estado corrompido.
    assert.equal(a.ram.usageStatus, "available");
    assert.equal(a.ram.usagePercent, 60);
    assert.ok(Number.isFinite(Date.parse(a.ram.usageUpdatedAt)));
    assert.ok(
      ["available", "unavailable", "stale"].includes(b.ram.usageStatus),
      `estado inválido no snapshot concorrente: ${b.ram.usageStatus}`
    );
    if (b.ram.usageStatus !== "available") {
      assert.equal(b.ram.usagePercent, null);
      assert.equal(b.stressContributions.ram, 0);
    }
    // Um snapshot seguinte (com o tick já aplicado) volta a estar disponível.
    const c = await e.getSnapshot([]);
    assert.equal(c.ram.usageStatus, "available");
  });

  it("compatibilidade: capacidade/bateria (C2) intactas e estados tipados", async () => {
    const e = engine();
    e.nextRam = { percent: 33, usedGb: 5.3, totalGb: 16 };
    const s = await e.getSnapshot([]);

    assert.equal(typeof s.ram.totalGb, "number");
    assert.ok(
      s.ram.usagePercent === null || typeof s.ram.usagePercent === "number",
      "usagePercent é número com leitura atual, null sem ela"
    );
    assert.ok(
      ["available", "stale", "unavailable", "error"].includes(s.ram.usageStatus),
      "estado do vocabulário existente"
    );
    // C2 preservado por este delta.
    assert.equal(typeof s.battery.hasBattery, "boolean");
    assert.equal(typeof s.battery.percent, "number");
    assert.ok(typeof s.battery.status === "string");
  });

  it("snapshot produzido pelo motor é auto-descritivo: o estado está SEMPRE presente", async () => {
    // Política de legado: a AUSÊNCIA de `usageStatus` significa "não confirmado" e
    // nunca "available". Isto só é detectável pelos consumidores se o motor nunca
    // omitir o campo — este teste fixa essa garantia (o legado vem de snapshots
    // antigos/cacheados, não deste motor).
    const semLeitura = await engine({ fastTick: false }).getSnapshot([]);
    const e2 = engine();
    e2.nextRam = { percent: 20, usedGb: 3.2, totalGb: 16 };
    const comLeitura = await e2.getSnapshot([]);
    assert.equal(comLeitura.ram.usageStatus, "available");

    for (const s of [semLeitura, comLeitura]) {
      assert.ok(
        ["available", "stale", "unavailable", "error"].includes(s.ram.usageStatus),
        "estado sempre explícito no snapshot do motor"
      );
      assert.equal(s.ram.usageStatus === "available", s.ram.usagePercent !== null,
        "available <=> há leitura atual (nunca 0 de default com ar de medição)");
    }
  });
});
it("totalGb: desconhecido (null) antes de qualquer medicao; nunca 0 GB", async () => {
  const semMedicao = await engine({ fastTick: false }).getSnapshot([]);
  assert.equal(semMedicao.ram.totalGb, null, "capacidade desconhecida nao pode ser 0 GB");

  const e = engine();
  e.nextRam = { percent: 42, usedGb: 6.4, totalGb: 15.9 };
  const lido = await e.getSnapshot([]);
  assert.ok(lido.ram.totalGb > 0, "capacidade medida tem de ser > 0");
  assert.equal(Math.round(lido.ram.totalGb * 10) / 10, 15.9);
});
