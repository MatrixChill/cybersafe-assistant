import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * TP-PC-CENTER-INDICADORES — os indicadores novos do PC Center têm de ser
 * publicados com fonte e estado, e a ausência de leitura nunca pode virar
 * número. Nada aqui toca hardware real: as seam de aquisição (`readCpuLoad`,
 * `readNetworkStats`, `readKernelMemory`, `readKernelPower`) são sobrepostas e
 * o tick lento é neutralizado ao contrário do que acontece em produção.
 *
 * Cada teste nomeia o defeito que fixa:
 *  - por-núcleo era deitado fora apesar de vir na mesma resposta;
 *  - compromisso/página/reservado não existiam e o "reservado" derivado de uma
 *    só fonte dava sempre 0 (falsa afirmação);
 *  - energia sem bateria tinha de ser afirmada com prova, não por omissão;
 *  - utilização do GPU não tinha fonte nenhuma neste sistema (o SI devolve
 *    null) e tinha de vir do mesmo PMLog que já dava a temperatura;
 *  - contadores acumulados por adaptador, com taxa calculada por nós e
 *    `null` enquanto não há duas amostras.
 */

const GiB = 1024 ** 3;

const memoria = {
  totalPhysBytes: 32 * GiB,
  availPhysBytes: 6 * GiB,
  commitLimitBytes: 48 * GiB,
  commitAvailBytes: 10 * GiB,
  memoryLoadPercent: 81,
  totalVirtualBytes: 128 * GiB,
  acquiredAt: "2026-10-26T00:00:00.000Z",
};

/** Desktop sem bateria: flag 0x80, percentagem 255 = desconhecida. */
const energiaSemBateria = {
  acLine: "on",
  hasBattery: false,
  batteryPercent: null,
  remainingMinutes: null,
  isCharging: null,
  systemStatus: 0,
  batteryLow: false,
  acquiredAt: "2026-10-26T00:00:00.000Z",
};

class SeamEngine extends HardwareHealthEngine {
  constructor({ memory = memoria, power = energiaSemBateria } = {}) {
    super();
    this.initialized = true;
    this.diskReadAttempted = true;
    this.diskSnapshot = initialDiskSnapshot();
    this.lastMediumTick = Date.now();
    this.lastSlowTick = Date.now();
    this.nextCpuLoad = null;
    this.nextStats = null;
    this.nextMemory = { status: "ok", value: memory };
    this.nextPower = { status: "ok", value: power };
    // GPU "detetada" sem utilização: é o estado real desta máquina quando o
    // ADL não respondeu, e é exatamente o caso que não pode virar 0 %.
    this.slowMetrics.gpu = {
      available: true,
      usagePercent: null,
      vramTotalMb: 8192,
      vramUsedMb: null,
      model: "AMD Radeon RX 5600 XT",
      dedicated: true,
      gpus: [],
    };
    this.cpuIdentity = { logicalCores: 24, physicalCores: 12, referenceMHz: 4700 };
  }

  async readCpuLoad() {
    return this.nextCpuLoad;
  }
  async readNetworkStats() {
    if (this.nextStats instanceof Error) throw this.nextStats;
    return this.nextStats;
  }
  readKernelMemory() {
    return this.nextMemory;
  }
  readKernelPower() {
    return this.nextPower;
  }
  async readAdapterFacts() {
    /* facts já semeadas pelo teste */
  }
}

describe("CPU: utilização por processador lógico, threads e frequência", () => {
  it("a tabela por núcleo vem da mesma leitura do uso total e é publicada", async () => {
    const e = new SeamEngine();
    e.nextCpuLoad = { currentLoad: 42, cpus: [{ load: 50.4 }, { load: 0 }, { load: 12.6 }] };
    const s = await e.getSnapshot([]);
    assert.equal(s.cpu.usage, 42);
    assert.deepEqual(
      s.cpu.perCore?.map((c) => [c.index, c.percent, c.status]),
      [[0, 50.4, "available"], [1, 0, "available"], [2, 12.6, "available"]],
      "0 % num núcleo é uma medição real, não uma falha",
    );
    assert.ok(s.cpu.perCoreUpdatedAt, "a tabela declara o instante da leitura");
  });

  it("entrada sem leitura fica unavailable e não 0 %", async () => {
    const e = new SeamEngine();
    e.nextCpuLoad = { currentLoad: 42, cpus: [{ load: 10 }, { load: undefined }, { load: 300 }] };
    const s = await e.getSnapshot([]);
    assert.deepEqual(
      s.cpu.perCore?.map((c) => [c.percent, c.status]),
      [[10, "available"], [null, "unavailable"], [null, "unavailable"]],
    );
  });

  it("sem array de núcleos não há tabela publicada (nem zeros)", async () => {
    const e = new SeamEngine();
    e.nextCpuLoad = { currentLoad: 42 };
    const s = await e.getSnapshot([]);
    assert.equal(s.cpu.perCore, undefined);
    assert.equal(s.cpu.perCoreUpdatedAt, undefined);
  });

  it("threads lógicos e núcleos físicos são campos distintos", async () => {
    const e = new SeamEngine();
    e.nextCpuLoad = { currentLoad: 1, cpus: [{ load: 1 }, { load: 1 }] };
    const s = await e.getSnapshot([]);
    assert.equal(s.cpu.logicalCores, 24);
    assert.equal(s.cpu.physicalCores, 12);
    assert.equal(s.cpu.frequency.referenceMHz, 4700);
  });

  it("a frequência declara a sua origem e nunca esconde o nominal como medida", async () => {
    const e = new SeamEngine();
    e.nextCpuLoad = { currentLoad: 1 };
    const s = await e.getSnapshot([]);
    assert.ok(/os\.cpus/.test(s.cpu.frequency.source), "origem da frequência identificada");
    assert.ok(["available", "unsupported"].includes(s.cpu.frequency.status));
    assert.equal(
      s.cpu.frequency.measuredAsCurrent,
      s.cpu.frequency.currentMHz !== s.cpu.frequency.referenceMHz,
      "measuredAsCurrent acompanha a comparação atual vs. referência",
    );
  });
});

describe("RAM: disponível, reservado, compromisso e página", () => {
  it("compromisso e página têm fonte do kernel e números coerentes", async () => {
    const e = new SeamEngine();
    const s = await e.getSnapshot([]);
    assert.equal(s.ram.commit.status, "available");
    assert.equal(s.ram.commit.limitBytes, 48 * GiB);
    assert.equal(s.ram.commit.usedBytes, 38 * GiB, "limite - disponível");
    assert.match(s.ram.commit.source, /GlobalMemoryStatusEx/);
    assert.equal(s.ram.pagefile.totalBytes, 16 * GiB, "página = limite de compromisso - RAM");
    assert.equal(s.ram.pagefile.totalIsDerived, true, "o total derivado diz que é derivado");
  });

  it("falha do kernel: unavailable com motivo e números a null, nunca 0", async () => {
    const e = new SeamEngine({ memory: null });
    e.nextMemory = { status: "unavailable", reason: "ffi-indisponivel:koffi" };
    const s = await e.getSnapshot([]);
    assert.equal(s.ram.commit.status, "unavailable");
    assert.equal(s.ram.commit.reason, "ffi-indisponivel:koffi");
    assert.equal(s.ram.commit.limitBytes, null);
    assert.equal(s.ram.pagefile.totalBytes, null);
    assert.equal(s.ram.availableGb, null);
    assert.equal(s.ram.reservedGb, null);
  });

  it("reservado = instalada nos módulos - utilizável; sem módulos é null", async () => {
    const e = new SeamEngine();
    const semModulos = await e.getSnapshot([]);
    assert.equal(semModulos.ram.reservedGb, null, "sem dados de módulos não se afirma nada");
    assert.equal(semModulos.ram.reservedIsDerived, false);

    e.ramLayout = {
      modules: [
        { capacityBytes: 16 * GiB, bank: "A", type: "DDR5", speedMHz: 6000, manufacturer: null, partNumber: null },
        { capacityBytes: 16 * GiB, bank: "B", type: "DDR5", speedMHz: 6000, manufacturer: null, partNumber: null },
      ],
      slotsOccupied: 2,
      slotsTotal: null,
      status: "available",
      source: "Win32_PhysicalMemory",
    };
    const comModulos = await e.getSnapshot([]);
    assert.equal(comModulos.ram.reservedGb, 0, "32 GiB instalados == 32 GiB utilizáveis: nada reservado");
    assert.equal(comModulos.ram.reservedIsDerived, true);

    // Placa que esconde ~1,1 GiB ao OS (o caso real desta máquina).
    e.ramLayout = { ...e.ramLayout, modules: [{ capacityBytes: 34.2 * GiB, bank: "A", type: "DDR5", speedMHz: 6000, manufacturer: null, partNumber: null }] };
    const reservado = await e.getSnapshot([]);
    assert.equal(reservado.ram.reservedGb, 2.2);
  });

  it("módulos ficam publicados com capacidade, velocidade e slots ocupados", async () => {
    const e = new SeamEngine();
    e.ramLayout = {
      modules: [{ capacityBytes: 8 * GiB, bank: "DIMM 1", type: "DDR4", speedMHz: 3200, manufacturer: null, partNumber: "X" }],
      slotsOccupied: 1,
      slotsTotal: null,
      status: "available",
      source: "Win32_PhysicalMemory",
      updatedAt: "2026-10-26T00:00:00.000Z",
    };
    const s = await e.getSnapshot([]);
    assert.equal(s.ram.layout.slotsOccupied, 1);
    assert.equal(s.ram.layout.modules[0].speedMHz, 3200);
    assert.equal(s.ram.layout.slotsTotal, null, "o firmware não reportou o total: não se inventa");
  });
});

describe("Energia e bateria: desktop sem bateria é afirmado com prova", () => {
  it("hasBattery=false vindo do kernel, carga/autonomia a null, adaptador on", async () => {
    const e = new SeamEngine();
    const s = await e.getSnapshot([]);
    assert.equal(s.power.status, "available");
    assert.equal(s.power.hasBattery, false);
    assert.equal(s.power.batteryPercent, null, "sem bateria não é 0 %");
    assert.equal(s.power.remainingMinutes, null);
    assert.equal(s.power.isCharging, null);
    assert.equal(s.power.acLine, "on");
    assert.equal(s.power.batteryLow, false, "sem bateria não há alerta de bateria fraca");
    assert.match(s.power.source, /GetSystemPowerStatus/);
  });

  it("falha do kernel: hasBattery null (não se afirma 'sem bateria')", async () => {
    const e = new SeamEngine({ power: null });
    e.nextPower = { status: "unavailable", reason: "plataforma-nao-suportada" };
    const s = await e.getSnapshot([]);
    assert.equal(s.power.hasBattery, null);
    assert.equal(s.power.status, "unavailable");
    assert.equal(s.power.reason, "plataforma-nao-suportada");
  });

  it("portátil a carregar: percentagem e carga são publicadas", async () => {
    const e = new SeamEngine({
      power: { ...energiaSemBateria, hasBattery: true, batteryPercent: 64, isCharging: true, remainingMinutes: 120, acLine: "off" },
    });
    const s = await e.getSnapshot([]);
    assert.equal(s.power.hasBattery, true);
    assert.equal(s.power.batteryPercent, 64);
    assert.equal(s.power.isCharging, true);
    assert.equal(s.power.remainingMinutes, 120);
  });
});

describe("GPU: utilização real com estado, a partir do mesmo PMLog", () => {
  it("valor ADL publicado com origem e timestamp; o null do systeminformation não o substitui", async () => {
    const e = new SeamEngine();
    e.applyGpuUtilization(37, 12, "AMD ADL", "GPU_ACTIVITY/GPU_ACTIVITY_MEM @ RX 5600 XT");
    const s = await e.getSnapshot([]);
    assert.equal(s.gpu.usagePercent, 37);
    assert.equal(s.gpu.usageStatus, "available");
    assert.equal(s.gpu.usageSource, "GPU_ACTIVITY/GPU_ACTIVITY_MEM @ RX 5600 XT");
    assert.equal(s.gpu.vramUsedPercent, 12);
    assert.ok(s.gpu.usageUpdatedAt);
  });

  it("0 % do ADL é uma medição; uma falha depois do TTL não é 0 %", async () => {
    const e = new SeamEngine();
    e.applyGpuUtilization(0, 0, "AMD ADL", "GPU_ACTIVITY");
    const parado = await e.getSnapshot([]);
    assert.equal(parado.gpu.usagePercent, 0, "GPU ociosa medida é 0 % legítimo");
    assert.equal(parado.gpu.usageStatus, "available");

    // Envelhece a leitura para além do TTL e falha a poll seguinte.
    e.gpuUseState = { ...e.gpuUseState, updatedAt: Date.now() - 60_000 };
    e.applyGpuUtilization(null, null, "AMD ADL", "GPU_ACTIVITY");
    const semLeitura = await e.getSnapshot([]);
    assert.equal(semLeitura.gpu.usageStatus, "unavailable");
    assert.equal(semLeitura.gpu.usagePercent, null, "ausência de leitura nunca é 0 %");
  });

  it("dentro do TTL de uma falha, a última leitura mantém-se como stale", async () => {
    const e = new SeamEngine();
    e.applyGpuUtilization(45, 20, "AMD ADL", "GPU_ACTIVITY");
    e.applyGpuUtilization(null, null, "AMD ADL", "GPU_ACTIVITY");
    const s = await e.getSnapshot([]);
    assert.equal(s.gpu.usagePercent, 45);
    assert.equal(s.gpu.usageStatus, "stale");
  });

  it("sem leitura ADL nenhuma, o valor do systeminformation continua a servir, com a sua origem", async () => {
    const e = new SeamEngine();
    e.slowMetrics.gpu = { ...e.slowMetrics.gpu, usagePercent: 8 };
    const s = await e.getSnapshot([]);
    assert.equal(s.gpu.usagePercent, 8);
    assert.equal(s.gpu.usageStatus, "available");
    assert.match(s.gpu.usageSource ?? "", /systeminformation/, "a origem fallback é declarada");
  });
});

describe("Rede: adaptadores com estado, taxa calculada por nós e sem duplicados", () => {
  it("primeira amostra dá totais mas taxa null (não 0 B/s inventado)", async () => {
    const e = new SeamEngine();
    e.nextStats = [{ iface: "Wi-Fi", rx_sec: 100, tx_sec: 20, rx_bytes: 5_000_000, tx_bytes: 900_000 }];
    await e.refreshNetwork();
    const s = await e.getSnapshot([]);
    assert.equal(s.network.adapters.length, 1);
    const [a] = s.network.adapters;
    assert.equal(a.iface, "Wi-Fi");
    assert.equal(a.rxBytesTotal, 5_000_000);
    assert.equal(a.txBytesTotal, 900_000);
    assert.equal(a.rxBytesPerSec, null, "uma amostra não faz velocidade");
    assert.equal(a.txBytesPerSec, null);
  });

  it("segunda amostra produz a taxa a partir dos dois contadores", async () => {
    const e = new SeamEngine();
    const base = { iface: "Wi-Fi", rx_sec: 0, tx_sec: 0, rx_bytes: 1_000_000, tx_bytes: 2_000 };
    e.nextStats = [base];
    await e.refreshNetwork();
    // Avança o relógio da amostra: mesmo contador com +500 KiB em ~10 s.
    e.adapterCounters.set("Wi-Fi", { rx: 1_000_000, tx: 2_000, at: Date.now() - 10_000 });
    e.nextStats = [{ ...base, rx_bytes: 6_000_000, tx_bytes: 12_000 }];
    await e.refreshNetwork();
    const s = await e.getSnapshot([]);
    const [a] = s.network.adapters;
    assert.equal(a.rxBytesPerSec, 500_000, "(6 MB - 1 MB) / 10 s");
    assert.equal(a.txBytesPerSec, 1_000);
  });

  it("contador que desce (reset) não produz taxa negativa nem taxa fingida", async () => {
    const e = new SeamEngine();
    e.nextStats = [{ iface: "Wi-Fi", rx_sec: 1, tx_sec: 1, rx_bytes: 9_000_000, tx_bytes: 9_000_000 }];
    await e.refreshNetwork();
    e.adapterCounters.set("Wi-Fi", { rx: 9_000_000, tx: 9_000_000, at: Date.now() - 5_000 });
    e.nextStats = [{ iface: "Wi-Fi", rx_sec: 1, tx_sec: 1, rx_bytes: 1_000, tx_bytes: 1_000 }];
    await e.refreshNetwork();
    const s = await e.getSnapshot([]);
    const [a] = s.network.adapters;
    assert.equal(a.rxBytesPerSec, null);
    assert.equal(a.txBytesPerSec, null);
    assert.equal(a.rxBytesTotal, 1_000, "o novo total é real e continua a ser publicado");
  });

  it("um registo por interface, sem duplicados, com tipo e estado", async () => {
    const e = new SeamEngine();
    e.nextStats = [
      { iface: "Wi-Fi", rx_sec: 5, tx_sec: 1, rx_bytes: 10, tx_bytes: 5 },
      { iface: "Ethernet", rx_sec: 0, tx_sec: 0, rx_bytes: 0, tx_bytes: 0 },
      { iface: "Wi-Fi", rx_sec: 5, tx_sec: 1, rx_bytes: 10, tx_bytes: 5 },
    ];
    await e.refreshNetwork();
    const s = await e.getSnapshot([]);
    assert.deepEqual(s.network.adapters.map((a) => a.iface), ["Wi-Fi", "Ethernet"]);
    assert.equal(new Set(s.network.adapters.map((a) => a.iface)).size, s.network.adapters.length);
    assert.ok(s.network.adapters.some((a) => a.kind === "wireless"), "Wi-Fi é classificado como sem fios");
    assert.ok(s.network.adapters.every((a) => a.status === "available"));
  });

  it("os factos do adaptador (ip, mac, velocidade) acompanham o contador", async () => {
    const e = new SeamEngine();
    e.adapterFacts.set("Ethernet", {
      iface: "Ethernet", label: "Ethernet", kind: "wired", operstate: "up",
      speedMbps: 1000, ip4: "192.168.1.20", mac: "aa:bb:cc:dd:ee:ff",
      rxBytesTotal: null, txBytesTotal: null, rxBytesPerSec: null, txBytesPerSec: null, status: "unavailable",
    });
    e.nextStats = [{ iface: "Ethernet", rx_sec: 0, tx_sec: 0, rx_bytes: 3, tx_bytes: 4 }];
    await e.refreshNetwork();
    const s = await e.getSnapshot([]);
    const [a] = s.network.adapters;
    assert.equal(a.speedMbps, 1000);
    assert.equal(a.ip4, "192.168.1.20");
    assert.equal(a.operstate, "up");
    assert.equal(a.status, "available", "o estado passa a refletir a leitura dos contadores");
  });

  it("falha da rede não publica adaptadores nenhuns com zeros", async () => {
    const e = new SeamEngine();
    e.nextStats = new Error("CIM indisponível");
    await e.refreshNetwork();
    const s = await e.getSnapshot([]);
    assert.equal(s.network.readStatus, "unavailable");
    assert.deepEqual(s.network.adapters, []);
  });
});
