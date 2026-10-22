import * as si from "systeminformation";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import type { GpuSnapshot, HardwareSnapshot, ProcessSnapshot, StressContributions, TemperatureStatus } from "@cybersafe/shared-types";
import { readTemperature } from "./temperature.js";
import { isDedicatedGpu, gpuSelectionScore } from "./gpu-selection.js";
import {
  buildDiskSnapshot,
  describeDiskRead,
  initialDiskSnapshot,
  worstWorkingVolume,
  type DiskLastGood,
  type DiskReadOutcome,
} from "./disk.js";
import type { DiskSnapshot } from "@cybersafe/shared-types";

// Reexportado para consumidores históricos (ex.: testes) sem duplicar código.
export { isDedicatedGpu, gpuSelectionScore } from "./gpu-selection.js";

const execAsync = promisify(exec);

/**
 * Quanto tempo (ms) um último valor bom de temperatura continua a ser mostrado
 * (status "stale") antes de passar a indiscutivelmente indisponível.
 *
 * A temperatura é lida no tick lento (10s) por um ÚNICO escritor. Um TTL de 25s
 * tolera até duas polls falhadas seguidas sem o valor piscar para "—", mas
 * ainda assim o remove quando já não há leitura real recente.
 */
const GPU_TEMPERATURE_STALE_TTL_MS = 25_000;

/**
 * O mesmo prazo para a temperatura da CPU. Antes, um único valor válido ficava
 * publicado como "available" para sempre: a leitura seguinte só substituía o
 * campo quando voltava não-nula, por isso um sensor que desaparecesse deixava
 * o último valor a passar por atual. A CPU passa a ter o mesmo modelo da GPU
 * (valor + instante da última leitura boa + estado), sem inventar 0 °C.
 */
const CPU_TEMPERATURE_STALE_TTL_MS = 25_000;

/**
 * TTL da leitura de uso de CPU. O tick rápido é de 1 s; tolerar 3 s cobre duas
 * falhas transitórias sem transformar uma medição antiga em "agora". Passado o
 * TTL, o valor deixa de ser publicado como atual (`usageStatus: "unavailable"`).
 */
const CPU_USAGE_STALE_TTL_MS = 3_000;

/**
 * TTL da leitura de uso de RAM (TP-HARDWARE-MEASURED-CONTRACT). Mesmo racional
 * da CPU: o tick rápido é de 1 s e 3 s toleram duas falhas transitórias. Antes
 * desta correção, `fastMetrics.ramPercent` era publicado desde o arranque como
 * um número "medido" — um 0 sem amostra era indistinguível de RAM ociosa.
 */
const RAM_USAGE_STALE_TTL_MS = 3_000;

/**
 * RAM: os campos `usageStatus`/`usageUpdatedAt` e os volumes `number | null`
 * ficam DECLARADOS em `HardwareSnapshot["ram"]` (shared-types, ownership
 * coordenado deste bloco — sem cast local). A AUSÊNCIA de `usageStatus` em
 * snapshots antigos significa estado DESCONHECIDO, nunca "available" por
 * omissão: cada consumidor decide explicitamente (política no dossiê
 * TP-HARDWARE-MEASURED-CONTRACT).
 */
/**
 * Rede: o tick lento é 10 s. Um valor com mais de 20 s (2 ticks) já não
 * representa o tráfego de agora — fica `unavailable` em vez de ser mostrado
 * como atual. Dentro de 20 s, uma falha mantém-no como `stale` (rotulado).
 */
const NETWORK_STALE_TTL_MS = 20_000;

/**
 * Bateria: o refresh vive no tick lento (10 s). Um valor de portátil muda
 * devagar, mas não pode ficar publicado como "agora" para sempre: um TTL de
 * 60 s (6 ticks) mantém o último valor bom enquanto é plausivelmente atual e
 * expira-o depois para `unavailable`. Uma falha do provider NUNCA vira
 * "absent" — ausência de bateria só se comprova com uma leitura boa.
 */
const BATTERY_READ_STALE_TTL_MS = 60_000;

/** Provider real da leitura de bateria; nunca publicado sem leitura real. */
const BATTERY_SOURCE = "systeminformation";

/**
 * Prazo da PRIMEIRA leitura do armazenamento (ms).
 *
 * O tick médio do disco é assíncrono (5 s) para não atrasar os snapshots. Só a
 * primeira leitura é esperada — de propósito: sem isto o primeiro snapshot
 * publicado (e o único que alguns caminhos voltam a ver) dizia "Ainda sem
 * leitura do armazenamento desde o arranque" mesmo com todos os volumes
 * legíveis, e o consumidor ficava com esse estado. Com prazo de 4 s: uma leitura
 * lenta é esperada até onde faz sentido e, se expirar, o caminho assíncrono
 * normal termina o trabalho e publica o valor assim que ele chegar.
 */
const DISK_FIRST_READ_TIMEOUT_MS = 4_000;

export class HardwareHealthEngine {
  private lastSnapshot: HardwareSnapshot | null = null;

  private fastMetrics = {
    cpuUsage: 0,
    ramPercent: 0,
    usedRamGb: 0,
    totalRamGb: 0,
  };

  /**
   * Estado do armazenamento publicado (substitui os antigos
   * `diskPercent/diskUsedGb/diskTotalGb/fsType` inicializados a zero).
   * O estado inicial é "unavailable" (ainda sem leitura), nunca "0%": encher
   * campos de medição com zero é afirmar que se mediu, e não se mediu.
   */
  private diskSnapshot: DiskSnapshot = initialDiskSnapshot();
  private diskLastGood: DiskLastGood | null = null;
  /** Houve já uma tentativa de leitura do armazenamento? (só a primeira é esperada) */
  private diskReadAttempted = false;

  private slowMetrics = {
    rxSec: 0,
    txSec: 0,
    // Vazio até haver leitura válida — nunca "unknown" inventado.
    interfaceName: "",
    gpu: null as any,
  };

  /**
   * Temperatura da CPU com frescura explícita. Mesmo modelo da GPU:
   * - leitura válida → value/status=available/updatedAt=agora;
   * - poll falhada dentro do TTL → mantém o último valor bom (status=stale);
   * - passado o TTL → value=null, status=unavailable.
   * O provider (`temperature.ts`) já rejeita 0 °C e valores fora de 0..150,
   * por isso aqui não se transforma ausência de leitura em número nenhum.
   */
  private cpuTempState: {
    value: number | null;
    updatedAt: number | null;
    status: TemperatureStatus;
  } = { value: null, updatedAt: null, status: "unavailable" };

  /**
   * Estado da leitura de uso de CPU. `fastMetrics.cpuUsage` é o último valor
   * BOM conhecido (0 é um valor real válido); este estado diz se ele é atual,
   * antigo (stale) ou se nunca/expirou uma leitura (unavailable).
   */
  private cpuUsageState: {
    updatedAt: number | null;
    status: TemperatureStatus;
  } = { updatedAt: null, status: "unavailable" };

  /**
   * Estado da leitura de uso de RAM (TP-HARDWARE-MEASURED-CONTRACT). Mesmo
   * contrato da CPU: `fastMetrics.ramPercent` guarda o último valor BOM (0 é
   * válido), isto diz se é atual, antigo (stale) ou ausente (unavailable).
   * Antes disto, 0 sem amostra e "RAM ociosa medida" eram indistinguíveis.
   */
  private ramUsageState: {
    updatedAt: number | null;
    status: TemperatureStatus;
    /** Última leitura BOA, retida mesmo depois do TTL (proveniência/CACHED). */
    lastGoodPercent: number | null;
  } = { updatedAt: null, status: "unavailable", lastGoodPercent: null };

  /**
   * Estado da leitura de tráfego de rede. `slowMetrics` guarda o último valor
   * BOM (0 B/s real é válido); este estado diz se é atual, a primeira leitura
   * ainda está pendente, falhou recentemente (stale) ou não há leitura.
   */
  private networkState: {
    updatedAt: number | null;
    status: "pending" | "available" | "stale" | "unavailable";
  } = { updatedAt: null, status: "pending" };

  /**
   * Estado da leitura de bateria (TP-BATTERY-C1-C2). `staticMetrics` guarda o
   * último valor BOM; `updatedAt` é o instante dessa leitura boa. Uma falha do
   * provider NUNCA é classificada como "absent": mantém a classificação e os
   * valores do último bom até ao TTL, depois passa a `unavailable`; sem
   * qualquer leitura boa, uma falha é `error`.
   */
  private batteryState: {
    updatedAt: number | null;
    status: "present" | "absent" | "unavailable" | "error";
  } = { updatedAt: null, status: "unavailable" };

  /** Guarda anti-sobreposição do refresh da bateria (tick lento). */
  private batteryRefreshInFlight = false;

  /**
   * Estado estável da temperatura da GPU (value/source/sensor/updatedAt/status).
   * Uma ÚNICA fonte escreve aqui: a cadeia `readTemperature()` (systeminformation
   * → ACPI), ambos user-mode. Antes havia dois escritores concorrentes
   * (a poll de `si.graphics()` também escrevia), o que podia publicar a
   * temperatura de uma GPU diferente da escolhida.
   */
  private gpuTempState: {
    value: number | null;
    updatedAt: number | null;
    status: TemperatureStatus;
    source: string;
    /** Nome do sensor exato que originou o valor (nunca mapeamos em silêncio). */
    sensor: string;
  } = {
    value: null,
    updatedAt: null,
    status: "unavailable",
    source: "unknown",
    sensor: "unknown",
  };

  /**
   * Temperaturas secundárias da GPU, separadas por sensor. NUNCA são
   * publicadas como "GPU" sem rótulo — a UI básica mostra o core.
   */
  private gpuSecondaryTemps: { hotspotC: number | null; memoryJunctionC: number | null } = {
    hotspotC: null,
    memoryJunctionC: null,
  };

  private staticMetrics = {
    cpuModel: "Unknown",
    cpuCores: 0,
    cpuSpeed: 0,
    platform: "unknown",
    osVersion: "unknown",
    hostname: "unknown",
    hasBattery: false,
    batteryPercent: 0,
    isCharging: false,
    timeRemaining: null as number | null,
  };

  private initialized = false;
  private lastFastTick = 0;
  private lastMediumTick = 0;
  private lastSlowTick = 0;

  /** Convert Windows OS version to human-readable name */
  private getWindowsVersionName(release: string): string {
    if (!release) return "Unknown";

    // Parse Windows version numbers
    const match = release.match(/^(\d+)/);
    if (!match) return release;

    const major = parseInt(match[1]);

    // Windows NT versions
    if (major === 10) return "Windows 10/11";
    if (major === 11) return "Windows 11";
    if (major >= 20) return `Windows ${major / 10}`;
    if (major === 6) return "Windows Vista/7/8";

    return release;
  }

  /** Get actual physical CPU cores (not logical threads on Windows) */
  private getPhysicalCores(cpuInfo: any): number {
    if (!cpuInfo) return 0;

    // Prefer physical cores if available, otherwise use logical cores
    if (cpuInfo.physicalCores && cpuInfo.physicalCores > 0) {
      return cpuInfo.physicalCores;
    }

    // Fallback: on Windows, try to detect hyperthreading
    if (cpuInfo.cores && cpuInfo.cores > 0) {
      // If we have hyperthreading info, use it
      if (cpuInfo.hyperthreading) {
        return cpuInfo.cores / 2;
      }
      return cpuInfo.cores;
    }

    return cpuInfo.cores ?? cpuInfo.logicalCores ?? 0;
  }

  /**
   * Deteta a GPU mais relevante (multi-GPU aware) com regra DETERMINÍSTICA:
   * prefere a discreta claramente identificável, com tie-break por VRAM.
   * Nunca assume `controller[0]`.
   */
  private async detectGpu(): Promise<any> {
    try {
      const graphics = await si.graphics().catch(() => null);
      const controllers = graphics?.controllers ?? [];
      if (controllers.length === 0) {
        return { model: "Não disponível neste sistema", available: false };
      }

      const mapController = (gpu: any): GpuSnapshot & { available: boolean } => ({
        usagePercent: gpu.utilizationGpu ?? null,
        vramTotalMb: gpu.vram ?? null,
        vramUsedMb: gpu.memoryUsed ?? null,
        temperature: gpu.temperatureGpu ?? null,
        model: gpu.model?.trim() ? gpu.model : "Dispositivo gráfico",
        dedicated: isDedicatedGpu(gpu.model),
        available: true,
      });

      const normalized = controllers.map(mapController);

      // Regra determinística: a GPU com maior pontuação (dedicada > VRAM).
      const chosen = normalized
        .map((g: any, index: number) => ({ g, index, score: gpuSelectionScore(g) }))
        .sort((a: any, b: any) => (b.score - a.score) || (a.index - b.index))[0].g;

      // NOTA: a temperatura NÃO é aplicada aqui. A cadeia `readTemperature()`
      // é a única fonte de verdade térmica (sensor explícito), evitando dois
      // escritores a competir e a publicar a GPU errada.

      return {
        ...chosen,
        gpus: normalized,
        available: true,
      };
    } catch (err) {
      console.error("[Hardware] GPU detection error", err);
      return { model: "Não disponível neste sistema", available: false };
    }
  }

  /**
   * Modelo de estabilidade da temperatura da GPU:
   * - leitura válida → value/status=available;
   * - poll falhada dentro do TTL → mantém o último valor bom (status=stale);
   * - passado o TTL → value=null, status=unavailable.
   * Assim uma única falha nunca faz o valor "desaparecer".
   */
  private applyGpuTemperature(raw: number | null, source: string, sensor = "GPU Core"): void {
    const now = Date.now();
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw < 150) {
      this.gpuTempState = { value: Math.round(raw), updatedAt: now, status: "available", source, sensor };
      return;
    }
    if (
      this.gpuTempState.value !== null &&
      this.gpuTempState.updatedAt !== null &&
      now - this.gpuTempState.updatedAt <= GPU_TEMPERATURE_STALE_TTL_MS
    ) {
      this.gpuTempState = { ...this.gpuTempState, status: "stale" };
      return;
    }
    this.gpuTempState = { ...this.gpuTempState, value: null, status: "unavailable", source, sensor };
  }

  /** Aplica as temperaturas secundárias (hotspot/junction) separadamente. */
  private applyGpuSecondaryTemps(hotspotC: number | null, memoryJunctionC: number | null): void {
    if (typeof hotspotC === "number" && Number.isFinite(hotspotC) && hotspotC > 0) {
      this.gpuSecondaryTemps.hotspotC = Math.round(hotspotC);
    }
    if (typeof memoryJunctionC === "number" && Number.isFinite(memoryJunctionC) && memoryJunctionC > 0) {
      this.gpuSecondaryTemps.memoryJunctionC = Math.round(memoryJunctionC);
    }
  }

  /** Constrói o objeto GPU do snapshot, recalculando o estado da temperatura. */
  private buildGpuSnapshot(): HardwareSnapshot["gpu"] {
    const gpu = this.slowMetrics.gpu;
    if (!gpu || gpu.available === false) return gpu ?? null;

    const now = Date.now();
    let status: TemperatureStatus = this.gpuTempState.status;
    let value = this.gpuTempState.value;
    if (value !== null && this.gpuTempState.updatedAt !== null) {
      status = (now - this.gpuTempState.updatedAt) <= GPU_TEMPERATURE_STALE_TTL_MS ? status : "unavailable";
      if (status === "unavailable") value = null;
    }

    return {
      // `available` explicitado: a UI tem de distinguir "ainda sem leitura"
      // (`gpu === null`), "GPU presente" (`available: true`) e "placa não
      // detetada" (`available: false`) — nunca confundir ausência de temperatura
      // com ausência de placa gráfica.
      available: true,
      usagePercent: gpu.usagePercent ?? null,
      vramTotalMb: gpu.vramTotalMb ?? null,
      vramUsedMb: gpu.vramUsedMb ?? null,
      model: gpu.model,
      dedicated: gpu.dedicated ?? isDedicatedGpu(gpu.model),
      gpus: gpu.gpus,
      // `temperature` é SEMPRE a temperatura principal/core da GPU. Hotspot e
      // Memory Junction ficam em campos próprios e nunca são mostrados como
      // "GPU" sem rótulo.
      temperature: value,
      coreTemperature: value,
      hotspotTemperature: this.gpuSecondaryTemps.hotspotC,
      memoryJunctionTemperature: this.gpuSecondaryTemps.memoryJunctionC,
      temperatureStatus: value === null ? (this.gpuTempState.updatedAt === null ? "unavailable" : status) : status,
      temperatureUpdatedAt: this.gpuTempState.updatedAt
        ? new Date(this.gpuTempState.updatedAt).toISOString()
        : undefined,
      temperatureSource: this.gpuTempState.source,
      temperatureSensor: this.gpuTempState.sensor,
    };
  }

  /**
   * Seam da leitura de uso de CPU (sobreponível em testes sem hardware real).
   * Qualquer falha do provider devolve `null` — nunca um objeto com 0.
   */
  private async readCpuLoad(): Promise<{ currentLoad?: number } | null> {
    return si.currentLoad().catch(() => null);
  }

  /**
   * Aplica uma leitura de uso de CPU. Regras (TP-PAP-CPU-USAGE-TRUTH):
   * - 0 REAL é válido (CPU ociosa não é erro);
   * - valores não finitos/fora de 0..100 são leitura inválida, não 0;
   * - leitura inválida NÃO escreve 0 em `fastMetrics.cpuUsage`: mantém o último
   *   valor bom e marca `stale` dentro do TTL; expirado, marca `unavailable`.
   */
  private applyCpuUsage(raw: unknown): void {
    const now = Date.now();
    const valid =
      typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100;
    if (valid) {
      this.fastMetrics.cpuUsage = Math.round(raw as number);
      this.cpuUsageState = { updatedAt: now, status: "available" };
      return;
    }
    if (
      this.cpuUsageState.updatedAt !== null &&
      now - this.cpuUsageState.updatedAt <= CPU_USAGE_STALE_TTL_MS
    ) {
      this.cpuUsageState = { ...this.cpuUsageState, status: "stale" };
      return;
    }
    // Nunca houve leitura boa, ou já expirou: o número que reste não é "agora".
    this.cpuUsageState = { updatedAt: null, status: "unavailable" };
  }

  /**
   * Estado do uso de CPU a publicar AGORA. A idade é recalculada no instante do
   * snapshot (o tick pode estar atrasado ou o processo suspenso).
   */
  private buildCpuUsageState(): { status: TemperatureStatus; updatedAt: string | null } {
    const { updatedAt, status } = this.cpuUsageState;
    if (updatedAt === null) return { status: "unavailable", updatedAt: null };
    const age = Date.now() - updatedAt;
    return {
      status: age > CPU_USAGE_STALE_TTL_MS ? "unavailable" : status,
      updatedAt: new Date(updatedAt).toISOString(),
    };
  }

  /**
   * Seam da leitura de RAM (sobreponível em testes). `null` = sem leitura
   * válida (falha do provider ou total inválido) — nunca um 0 inventado.
   */
  /**
   * Capacidade de RAM da máquina (GB) ou `null` se nunca foi medida. Nunca `0`:
   * sem leitura, a capacidade é DESCONHECIDA, não zero
   * (TP-HARDWARE-MEASURED-CONTRACT, revisão "totalGb desconhecido").
   */
  private ramTotalGb: number | null = null;

  private readRam(): { percent: number; usedGb: number; totalGb: number } | null {
    const total = os.totalmem();
    if (!(total > 0)) return null;
    const used = total - os.freemem();
    return {
      percent: Math.round((used / total) * 100),
      usedGb: used / 1024 ** 3,
      totalGb: total / 1024 ** 3,
    };
  }

  /**
   * Aplica uma leitura de RAM ao estado publicado. 0 % é uma leitura REAL
   * válida; uma falha mantém o último valor bom como `stale` dentro do TTL e
   * `unavailable` depois disso — nunca escreve 0 para representar uma falha.
   */
  private applyRamUsage(read: { percent: number; usedGb: number; totalGb: number } | null): void {
    const now = Date.now();
    const valid =
      read !== null &&
      Number.isFinite(read.percent) &&
      Number.isFinite(read.usedGb) &&
      Number.isFinite(read.totalGb) &&
      read.percent >= 0 &&
      read.percent <= 100;
    if (valid && read) {
      this.fastMetrics.ramPercent = Math.round(read.percent);
      this.fastMetrics.usedRamGb = read.usedGb;
      this.fastMetrics.totalRamGb = read.totalGb;
      this.ramTotalGb = read.totalGb;
      this.ramUsageState = { updatedAt: now, status: "available", lastGoodPercent: Math.round(read.percent) };
      return;
    }
    if (
      this.ramUsageState.updatedAt !== null &&
      now - this.ramUsageState.updatedAt <= RAM_USAGE_STALE_TTL_MS
    ) {
      this.ramUsageState = { ...this.ramUsageState, status: "stale" };
      return;
    }
    // Nunca houve leitura boa, ou já expirou: o número que reste não é "agora".
    // A última leitura BOA e o seu timestamp são PRESERVADOS (proveniência: a UI
    // pode mostrá-la como "última leitura conhecida"/CACHED); quem decide a
    // frescura é o `status`, nunca o valor nem o timestamp sozinhos. O valor
    // retido NUNCA é carga atual e não entra no stress.
    this.ramUsageState = { ...this.ramUsageState, status: "unavailable" };
  }

  /**
   * Estado do uso de RAM a publicar AGORA. A idade é recalculada no instante do
   * snapshot (o tick pode estar atrasado ou o processo suspenso).
   */
  private buildRamUsageState(): {
    status: TemperatureStatus;
    updatedAt: string | null;
    lastGoodPercent: number | null;
  } {
    const { updatedAt, status, lastGoodPercent } = this.ramUsageState;
    if (updatedAt === null) return { status: "unavailable", updatedAt: null, lastGoodPercent: null };
    const age = Date.now() - updatedAt;
    return {
      status: age > RAM_USAGE_STALE_TTL_MS ? "unavailable" : status,
      // Timestamp da última leitura BOM — proveniência, não promessa de frescura.
      updatedAt: new Date(updatedAt).toISOString(),
      lastGoodPercent: lastGoodPercent ?? null,
    };
  }

  /**
   * Seam da leitura de tráfego (sobreponível em testes sem CIM/rede real).
   * Falha devolve `null` (não um array vazio: ambos são ausência de leitura).
   */
  private async readNetworkStats(): Promise<unknown[] | null> {
    return si.networkStats().catch(() => null);
  }

  /** Ciclo de leitura de rede do tick lento (10 s). */
  private async refreshNetwork(): Promise<void> {
    let stats: unknown[] | null = null;
    try {
      stats = await this.readNetworkStats();
    } catch {
      stats = null;
    }
    this.applyNetworkReading(stats);
  }

  /**
   * Seam da leitura de bateria (sobreponível em testes, sem WMI real).
   * Falha devolve `null` — ausência de leitura, nunca "sem bateria".
   */
  private async readBattery(): Promise<unknown> {
    return si.battery().catch(() => null);
  }

  /**
   * Aplica uma leitura BOA de bateria. `absent` só existe aqui: o provider
   * respondeu e não há bateria. `percent` 0 com bateria presente é valor real.
   */
  private applyBatteryReading(raw: unknown, now: number): void {
    const b = (raw ?? {}) as {
      hasBattery?: boolean;
      percent?: number;
      isCharging?: boolean;
      timeRemaining?: number | null;
    };
    this.staticMetrics.hasBattery = b.hasBattery === true;
    this.staticMetrics.batteryPercent =
      typeof b.percent === "number" && Number.isFinite(b.percent) ? b.percent : 0;
    this.staticMetrics.isCharging = b.isCharging === true;
    this.staticMetrics.timeRemaining =
      typeof b.timeRemaining === "number" && b.timeRemaining > 0 ? b.timeRemaining : null;
    this.batteryState = {
      updatedAt: now,
      status: this.staticMetrics.hasBattery ? "present" : "absent",
    };
  }

  /**
   * Ciclo de refresh da bateria, no tick lento (10 s). Sem interval próprio e
   * sem sobreposição: com um refresh em curso, o pedido seguinte sai cedo.
   */
  async refreshBattery(): Promise<void> {
    if (this.batteryRefreshInFlight) return;
    this.batteryRefreshInFlight = true;
    try {
      let reading: unknown = null;
      try {
        reading = await this.readBattery();
      } catch {
        reading = null;
      }
      if (reading && typeof reading === "object") {
        this.applyBatteryReading(reading, Date.now());
        return;
      }
      const now = Date.now();
      if (
        this.batteryState.updatedAt !== null &&
        now - this.batteryState.updatedAt <= BATTERY_READ_STALE_TTL_MS
      ) {
        return; // último valor bom ainda fresco: mantém classificação e valores
      }
      this.batteryState = {
        updatedAt: this.batteryState.updatedAt,
        status: this.batteryState.updatedAt === null ? "error" : "unavailable",
      };
    } finally {
      this.batteryRefreshInFlight = false;
    }
  }

  /**
   * Estado da bateria a publicar AGORA: a idade é recalculada no instante do
   * snapshot; passado o TTL sem leitura nova, `unavailable` (o valor que reste
   * não é "agora"). `updatedAt`/`source` só existem com leitura real.
   */
  private buildBatterySnapshot(): {
    status: "present" | "absent" | "unavailable" | "error";
    updatedAt?: string;
    source?: string;
  } {
    const { updatedAt, status } = this.batteryState;
    if (updatedAt === null) {
      return { status };
    }
    const age = Date.now() - updatedAt;
    if (age > BATTERY_READ_STALE_TTL_MS && status !== "error") {
      return { status: "unavailable", updatedAt: new Date(updatedAt).toISOString() };
    }
    return {
      status,
      updatedAt: new Date(updatedAt).toISOString(),
      source: BATTERY_SOURCE,
    };
  }

  /**
   * Aplica uma leitura de rede.
   * - vazio/sem interface/contadores inválidos = falha (NUNCA 0 B/s inventado);
   * - falha dentro do TTL mantém o último valor bom como `stale`;
   * - expirado/sem leitura = `unavailable`; interface nunca vira "unknown".
   */
  private applyNetworkReading(stats: unknown[] | null): void {
    const now = Date.now();
    const list = Array.isArray(stats) ? stats : [];
    const primary = list.find((n): n is { iface?: string; rx_sec?: number; tx_sec?: number } => {
      if (!n || typeof n !== "object") return false;
      const iface = (n as { iface?: unknown }).iface;
      if (typeof iface !== "string" || iface.length === 0) return false;
      const low = iface.toLowerCase();
      return !low.includes("loopback") && !low.includes("lo");
    }) ?? (list[0] as { iface?: string; rx_sec?: number; tx_sec?: number } | undefined);

    const iface = primary?.iface;
    const rx = primary?.rx_sec;
    const tx = primary?.tx_sec;
    const valid =
      typeof iface === "string" &&
      iface.length > 0 &&
      typeof rx === "number" &&
      Number.isFinite(rx) &&
      rx >= 0 &&
      typeof tx === "number" &&
      Number.isFinite(tx) &&
      tx >= 0;

    if (valid) {
      this.slowMetrics.rxSec = Math.round(rx as number);
      this.slowMetrics.txSec = Math.round(tx as number);
      this.slowMetrics.interfaceName = iface as string;
      this.networkState = { updatedAt: now, status: "available" };
      return;
    }

    if (this.networkState.updatedAt !== null && now - this.networkState.updatedAt <= NETWORK_STALE_TTL_MS) {
      this.networkState = { ...this.networkState, status: "stale" };
      return;
    }
    this.networkState = { updatedAt: null, status: "unavailable" };
  }

  /** Estado da rede a publicar AGORA (a idade é recalculada no snapshot). */
  private buildNetworkState(): {
    status: "pending" | "available" | "stale" | "unavailable";
    updatedAt: string | null;
  } {
    const { updatedAt, status } = this.networkState;
    if (updatedAt === null) {
      return { status: status === "pending" ? "pending" : "unavailable", updatedAt: null };
    }
    const age = Date.now() - updatedAt;
    return {
      status: age > NETWORK_STALE_TTL_MS ? "unavailable" : status,
      updatedAt: new Date(updatedAt).toISOString(),
    };
  }

  /**
   * Aplica uma leitura de temperatura da CPU (boa ou falhada). Uma leitura
   * inválida NÃO inventa 0 °C: dentro do TTL mantém o último valor bom como
   * "stale"; fora do TTL limpa-o para `null`/`unavailable`.
   */
  private applyCpuTemperature(raw: number | null): void {
    const now = Date.now();
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw < 150) {
      this.cpuTempState = { value: Math.round(raw), updatedAt: now, status: "available" };
      return;
    }
    if (
      this.cpuTempState.value !== null &&
      this.cpuTempState.updatedAt !== null &&
      now - this.cpuTempState.updatedAt <= CPU_TEMPERATURE_STALE_TTL_MS
    ) {
      this.cpuTempState = { ...this.cpuTempState, status: "stale" };
      return;
    }
    this.cpuTempState = { value: null, updatedAt: null, status: "unavailable" };
  }

  /**
   * Temperatura da CPU a publicar AGORA: o estado é recalculado no instante do
   * snapshot, para que um valor que envelheceu sem novas polls também expire
   * (o tick lento pode estar atrasado ou o processo pode ter estado suspenso).
   */
  private buildCpuTemperature(): { value: number | null; status: TemperatureStatus } {
    const { value, updatedAt, status } = this.cpuTempState;
    if (value === null || updatedAt === null) return { value: null, status: "unavailable" };
    if (Date.now() - updatedAt > CPU_TEMPERATURE_STALE_TTL_MS) {
      return { value: null, status: "unavailable" };
    }
    return { value, status };
  }

  /**
   * Read CPU temperature via WMI MSAcpi_ThermalZoneTemperature.
   * Returns temperature in Celsius or null if unavailable (non-admin, no sensor, VM).
   * WMI values are in tenths of Kelvin — converts to Celsius.
   */
  private async readCpuTemperature(): Promise<number | null> {
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-CimInstance MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentTemperature"',
        { windowsHide: true, timeout: 5000 }
      );
      const raw = parseInt(stdout.trim(), 10);
      if (!Number.isFinite(raw) || raw <= 0) return null;
      // WMI returns tenths of Kelvin: (K / 10) - 273.15 = °C
      const celsius = Math.round((raw / 10) - 273.15);
      // Sanity check: reject impossible values
      if (celsius < -20 || celsius > 150) return null;
      return celsius;
    } catch {
      return null;
    }
  }

  async init() {
    if (this.initialized) return;
    try {
      const [cpuInfo, osInfo, battery] = await Promise.all([
        si.cpu().catch(() => null),
        si.osInfo().catch(() => null),
        si.battery().catch(() => null)
      ]);

      this.staticMetrics.cpuModel = cpuInfo?.brand ?? "Unknown";
      this.staticMetrics.cpuCores = this.getPhysicalCores(cpuInfo);
      this.staticMetrics.cpuSpeed = cpuInfo?.speed ?? 0;
      this.staticMetrics.platform = osInfo?.platform ?? "unknown";

      // Convert OS version to human-readable format
      this.staticMetrics.osVersion = osInfo?.distro
        ? osInfo.distro
        : this.getWindowsVersionName(osInfo?.release ?? "unknown");

      this.staticMetrics.hostname = osInfo?.hostname ?? "unknown";

      if (battery && typeof battery === "object") {
        this.applyBatteryReading(battery, Date.now());
      } else {
        // O provider falhou no arranque: nunca "sem bateria"; fica sem leitura.
        this.batteryState = { updatedAt: null, status: "error" };
      }

      this.initialized = true;
    } catch (err) {
      console.error("[Hardware] Init error", err);
    }
  }

  async getSnapshot(processes: ProcessSnapshot[] = []): Promise<HardwareSnapshot> {
    if (!this.initialized) {
      await this.init();
    }

    const now = Date.now();

    // 1. TICK RÁPIDO (Aprox. 1 segundo)
    // Coleta apenas métricas ultra-leves que não usam WMI. Bloqueia minimamente o snapshot.
    if (now - this.lastFastTick >= 1000) {
      this.lastFastTick = now;
      try {
        const cpuLoad = await this.readCpuLoad();
        this.applyCpuUsage(cpuLoad?.currentLoad);

        this.applyRamUsage(this.readRam());
      } catch (err) {
        // Uma exceção inesperada do tick não pode passar por 0% medido.
        this.applyCpuUsage(null);
        this.applyRamUsage(null);
        console.error("[Hardware] Fast tick error", err);
      }
    }

    // 2. TICK MÉDIO (Aprox. 5 segundos)
    // Dispara em background para não bloquear a entrega do snapshot (Fire-and-forget)
    if (!this.diskReadAttempted) {
      // A PRIMEIRA leitura do armazenamento é esperada (com prazo), para que o
      // primeiro snapshot publicado já traga o volume real em vez de "ainda sem
      // leitura". As seguintes continuam assíncronas no tick médio.
      await this.awaitFirstDiskRead(now);
    } else if (now - this.lastMediumTick >= 5000) {
      this.lastMediumTick = now;
      void this.readDisksOnce();
    }

    // 3. TICK LENTO (Aprox. 10 segundos)
    // Dispara chamadas ultra-pesadas (WMI) em background (Fire-and-forget)
    if (now - this.lastSlowTick >= 10000) {
      this.lastSlowTick = now;

      // Rede: leitura própria com estado honesto (pending/available/stale/
      // unavailable). Uma falha não publica 0 B/s nem inventa "unknown".
      void this.refreshNetwork();

      // Bateria: refresh no mesmo ciclo (10 s), sem interval paralelo nem
      // sobreposição. Uma falha mantém o último valor bom — nunca "sem bateria".
      void this.refreshBattery();

      // GPU detection with fallbacks
      this.detectGpu().then(gpu => {
        this.slowMetrics.gpu = gpu;
      }).catch(err => console.error("[Hardware] GPU detection error", err));

      // Temperaturas via providers user-mode (systeminformation → ACPI)
      readTemperature().then(reading => {
        // Usamos cpuPackageC como temperatura CPU principal, fallback para coreMax.
        // Uma leitura falhada (null) passa pelo modelo de frescura da CPU: mantém
        // o último valor bom dentro do TTL (stale) e expira-o depois.
        this.applyCpuTemperature(reading.cpuPackageC ?? reading.cpuCoreMaxC);
        // Temperatura GPU: só o CORE pode alimentar o valor principal. Hotspot
        // e Memory Junction são guardados em campos separados com o seu sensor.
        if (reading.gpuCoreC !== null) {
          const sensorName = reading.gpuCoreSensor ?? "GPU Core";
          this.applyGpuTemperature(reading.gpuCoreC, reading.source, sensorName);
        }
        this.applyGpuSecondaryTemps(reading.gpuHotspotC, reading.gpuMemoryJunctionC);
      }).catch(() => {
        // Erro na cadeia de temperatura conta como poll falhada (nunca valor fantasma).
        this.applyCpuTemperature(null);
      });
    }

    const uptime = os.uptime();

    // Processos vêm injetados da chamada (cache do ProtectionEngine)
    const topProcessesByCpu = [...processes].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    const topProcessesByRam = [...processes].sort((a, b) => b.memoryMb - a.memoryMb).slice(0, 5);

    // Stress Score — usa a temperatura EFETIVA (já expirada se obsoleta).
    const cpuTemperature = this.buildCpuTemperature();
    const cpuUsageState = this.buildCpuUsageState();
    const ramUsageState = this.buildRamUsageState();
    const networkState = this.buildNetworkState();
    const { stressScore, alerts, contributions } = this.calculateStress(
      // Só uma leitura ATUAL de CPU alimenta o stress. O número em
      // fastMetrics.cpuUsage é mantido para apresentação ("última leitura"),
      // mas um valor stale/indisponível não pode passar por carga de agora.
      cpuUsageState.status === "available" ? this.fastMetrics.cpuUsage : null,
      // RAM com o mesmo contrato: só uma medição ATUAL entra no stress; um 0
      // que nunca foi medido (ou já expirado) não conta como RAM ociosa.
      ramUsageState.status === "available" ? this.fastMetrics.ramPercent : null,
      this.diskSnapshot,
      cpuTemperature.value,
      topProcessesByCpu,
      topProcessesByRam
    );

    const snapshot: HardwareSnapshot = {
      cpu: {
        usage: this.fastMetrics.cpuUsage,
        // `usage` mantém-se número (compatibilidade source), mas o estado diz
        // se é uma medição atual, uma última leitura antiga ou ausência de
        // leitura. Sem leitura, a UI/assistente não devem apresentar 0%.
        usageStatus: cpuUsageState.status,
        usageUpdatedAt: cpuUsageState.updatedAt ?? undefined,
        model: this.staticMetrics.cpuModel,
        cores: this.staticMetrics.cpuCores,
        speed: this.staticMetrics.cpuSpeed,
        temperature: cpuTemperature.value,
        // Auditado: sem sensor seguro (WMI/CIM em user-mode) o valor fica null e
        // o estado é "unavailable" — nunca inventamos uma temperatura fictícia
        // e nunca carregamos um driver para a obter. Com um valor recente mas a
        // última poll falhada, o estado é "stale" e expira ao fim do TTL.
        temperatureStatus: cpuTemperature.status,
      },
      ram: {
        // Medição ATUAL: só há NÚMEROS quando o estado é `available`. Sob
        // `stale`/`unavailable` `usagePercent`/`usedGb` vão a null — nunca um 0
        // nem a leitura antiga com ar de atual. `totalGb` é propriedade da
        // máquina (capacidade instalada), não uma medição: mantém-se o ÚLTIMO
        // valor conhecido quando existe, e `null` (desconhecido) enquanto nunca
        // foi medida — nunca 0 GB. A última leitura BOA continua disponível em
        // `usageLastGoodPercent` + `usageUpdatedAt` para exibição CACHED; NÃO é
        // carga atual e o stress só aceita `available` (ver acima).
        usagePercent: ramUsageState.status === "available" ? this.fastMetrics.ramPercent : null,
        usedGb:
          ramUsageState.status === "available"
            ? Math.round(this.fastMetrics.usedRamGb * 10) / 10
            : null,
        totalGb: this.ramTotalGb === null ? null : Math.round(this.ramTotalGb * 10) / 10,
        usageStatus: ramUsageState.status,
        usageUpdatedAt: ramUsageState.updatedAt ?? undefined,
        usageLastGoodPercent: ramUsageState.lastGoodPercent,
      },
      // Estado + volumes tal como foram medidos (null em vez de 0 sem leitura).
      disk: this.diskSnapshot,
      network: {
        rxSec: Math.round(this.slowMetrics.rxSec),
        txSec: Math.round(this.slowMetrics.txSec),
        interfaceName: this.slowMetrics.interfaceName,
        readStatus: networkState.status,
        updatedAt: networkState.updatedAt ?? undefined,
      },
      battery: {
        hasBattery: this.staticMetrics.hasBattery,
        percent: this.staticMetrics.batteryPercent,
        isCharging: this.staticMetrics.isCharging,
        timeRemaining: this.staticMetrics.timeRemaining,
        ...this.buildBatterySnapshot(),
      },
      gpu: this.buildGpuSnapshot(),
      system: {
        uptime,
        platform: this.staticMetrics.platform,
        osVersion: this.staticMetrics.osVersion,
        hostname: this.staticMetrics.hostname,
      },
      topProcessesByCpu,
      topProcessesByRam,
      stressScore,
      stressContributions: contributions,
      alerts,
      timestamp: new Date().toISOString(),
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  getLastSnapshot(): HardwareSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Aplica uma leitura de armazenamento (boa ou falhada). Dentro do TTL o estado
   * passa a "stale" e mantém os números medidos; fora do TTL passa a
   * "unavailable" e os números ficam `null` (nunca 0).
   */
  /**
   * Uma leitura do armazenamento (TODOS os volumes, não só o C:). NUNCA rejeita:
   * uma falha passa pelo mesmo caminho que uma leitura boa (`applyDiskRead`),
   * para que o motivo fique publicado e o último valor bom não seja descartado.
   */
  private async readDisksOnce(): Promise<void> {
    try {
      const fsSize = await si.fsSize();
      this.applyDiskRead(describeDiskRead(fsSize), Date.now());
    } catch (error: unknown) {
      this.applyDiskRead(
        describeDiskRead(null, error instanceof Error ? error.message : String(error ?? "erro desconhecido")),
        Date.now(),
      );
    }
  }

  /**
   * Primeira leitura do armazenamento: esperada, mas com prazo. Se o prazo
   * expirar respondemos na mesma — o estado fica `unavailable` COM motivo até a
   * leitura assíncrona terminar, nunca um spinner eterno nem um zero inventado.
   */
  private async awaitFirstDiskRead(nowMs: number): Promise<void> {
    this.diskReadAttempted = true;
    this.lastMediumTick = nowMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.readDisksOnce(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DISK_FIRST_READ_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private applyDiskRead(read: DiskReadOutcome, nowMs: number): void {
    const { snapshot, lastGood } = buildDiskSnapshot({
      read,
      lastGood: this.diskLastGood,
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
    });
    this.diskSnapshot = snapshot;
    this.diskLastGood = lastGood;
  }

  private calculateStress(
    cpuUsage: number | null,
    ramPercent: number | null,
    disk: DiskSnapshot,
    temperature: number | null,
    topCpu: import("@cybersafe/shared-types").ProcessSnapshot[],
    topRam: import("@cybersafe/shared-types").ProcessSnapshot[],
  ): { stressScore: number; alerts: import("@cybersafe/shared-types").HardwareAlert[]; contributions: StressContributions } {
    let score = 0;
    const alerts: import("@cybersafe/shared-types").HardwareAlert[] = [];

    // ── Stress = instantaneous load only ──────────────────────────────
    // Disk capacity (diskPercent) is a CAPACITY metric, not stress.
    // It belongs in PcState findings, not in the real-time stress index.

    const contributions: StressContributions = {
      cpu: 0,
      ram: 0,
      temperature: 0,
      gpu: 0,
    };

    // CPU stress (max 35 points) — só uma medição ATUAL conta. Um valor
    // `stale`/`unavailable` (falha de leitura) não pode somar stress nem gerar
    // alerta como se fosse a carga de agora.
    if (cpuUsage !== null) {
      if (cpuUsage > 90) {
        const pts = 35;
        score += pts;
        contributions.cpu = pts;
        const topProcess = topCpu.length > 0 && topCpu[0].cpu > 30 ? topCpu[0] : undefined;
        alerts.push({
          severity: cpuUsage > 95 ? "critical" : "high",
          category: "cpu",
          title: "Utilização de CPU elevada",
          description: topProcess ? `O processo ${topProcess.name} está consumindo ${topProcess.cpu}% da CPU.` : "A CPU está sob forte carga, o que pode causar lentidão no sistema.",
          process: topProcess,
          recommendation: "Feche aplicações pesadas que não estejam em uso. Se for um processo desconhecido, execute uma análise de segurança.",
        });
      } else if (cpuUsage > 75) {
        const pts = 15;
        score += pts;
        contributions.cpu = pts;
      }
    }

    // RAM stress (max 30 points) — só uma medição ATUAL conta (idêntico à CPU):
    // sem leitura válida, `null` não soma stress nem gera alerta como se fosse
    // RAM ociosa, e um número stale não passa por carga de agora.
    if (ramPercent !== null && ramPercent > 85) {
      const pts = 30;
      score += pts;
      contributions.ram = pts;
      const topProcess = topRam.length > 0 && topRam[0].memoryMb > 1000 ? topRam[0] : undefined;
      alerts.push({
        severity: ramPercent > 95 ? "critical" : "high",
        category: "ram",
        title: "Memória RAM próxima do limite",
        description: topProcess ? `O processo ${topProcess.name} está utilizando muita memória (${Math.round(topProcess.memoryMb)} MB).` : "Resta pouca memória RAM disponível para novas aplicações.",
        process: topProcess,
        recommendation: "Feche abas do navegador ou programas minimizados para libertar memória.",
      });
    } else if (ramPercent !== null && ramPercent > 70) {
      const pts = 10;
      score += pts;
      contributions.ram = pts;
    }

    // Temperature stress (max 25 points)
    if (temperature !== null && temperature > 0) {
      if (temperature > 80) {
        const pts = 25;
        score += pts;
        contributions.temperature = pts;
        alerts.push({
          severity: temperature > 90 ? "critical" : "high",
          category: "cpu",
          title: "Temperatura elevada",
          description: `A temperatura da CPU atingiu ${temperature}°C.`,
          recommendation: "Verifique a ventilação do computador. Evite bloquear as saídas de ar.",
        });
      } else if (temperature > 70) {
        const pts = 10;
        score += pts;
        contributions.temperature = pts;
      }
    }

    // Capacidade de disco NÃO é stress (ver nota acima): o aviso sai do volume
    // de trabalho mais cheio e diz QUAL é, com o espaço livre em números.
    // Sem leitura (`volumes` vazio) não há aviso — não se inventa um problema
    // a partir de um dado que não existe.
    const worst = worstWorkingVolume(disk.volumes);
    if (worst) {
      const freeGb = Math.round(worst.freeGb);
      const totalGb = Math.round(worst.totalGb);
      if (worst.usagePercent > 90) {
        alerts.push({
          severity: worst.usagePercent > 95 ? "critical" : "high",
          category: "disk",
          title: `Espaço em disco muito baixo em ${worst.mount}`,
          description: `Menos de 10% do volume ${worst.mount} está livre (${freeGb} GB livres de ${totalGb} GB), o que pode impedir o sistema de funcionar corretamente.`,
          recommendation: `Liberte espaço no volume ${worst.mount}: apague ficheiros temporários, esvazie a reciclagem ou desinstale aplicações desnecessárias.`,
        });
      } else if (worst.usagePercent > 80) {
        alerts.push({
          severity: "low",
          category: "disk",
          title: `Espaço em disco baixo em ${worst.mount}`,
          description: `O volume ${worst.mount} tem entre 10% e 20% de espaço livre (${freeGb} GB livres de ${totalGb} GB).`,
          recommendation: `Liberte espaço no volume ${worst.mount} antes que fique quase cheio.`,
        });
      }
    }

    return {
      stressScore: Math.min(100, score),
      alerts,
      contributions,
    };
  }
}
