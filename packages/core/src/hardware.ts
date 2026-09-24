import * as si from "systeminformation";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import type { GpuSnapshot, HardwareSnapshot, ProcessSnapshot, StressContributions, TemperatureStatus } from "@cybersafe/shared-types";
import { readTemperature } from "./temperature.js";
import { isDedicatedGpu, gpuSelectionScore } from "./gpu-selection.js";

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

export class HardwareHealthEngine {
  private lastSnapshot: HardwareSnapshot | null = null;

  private fastMetrics = {
    cpuUsage: 0,
    ramPercent: 0,
    usedRamGb: 0,
    totalRamGb: 0,
  };

  private mediumMetrics = {
    diskPercent: 0,
    diskUsedGb: 0,
    diskTotalGb: 0,
    fsType: "unknown",
  };

  private slowMetrics = {
    rxSec: 0,
    txSec: 0,
    interfaceName: "unknown",
    gpu: null as any,
    cpuTemperature: null as number | null,
  };

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

      this.staticMetrics.hasBattery = battery?.hasBattery ?? false;
      this.staticMetrics.batteryPercent = battery?.percent ?? 0;
      this.staticMetrics.isCharging = battery?.isCharging ?? false;
      this.staticMetrics.timeRemaining = battery?.timeRemaining && battery.timeRemaining > 0 ? battery.timeRemaining : null;

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
        const cpuLoad = await si.currentLoad().catch(() => null);
        this.fastMetrics.cpuUsage = Math.round(cpuLoad?.currentLoad ?? 0);

        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;
        this.fastMetrics.totalRamGb = total / (1024 ** 3);
        this.fastMetrics.usedRamGb = used / (1024 ** 3);
        this.fastMetrics.ramPercent = total > 0 ? Math.round((used / total) * 100) : 0;
      } catch (err) {
        console.error("[Hardware] Fast tick error", err);
      }
    }

    // 2. TICK MÉDIO (Aprox. 5 segundos)
    // Dispara em background para não bloquear a entrega do snapshot (Fire-and-forget)
    if (now - this.lastMediumTick >= 5000) {
      this.lastMediumTick = now;
      si.fsSize().then((fsSize) => {
        try {
          if (!fsSize || fsSize.length === 0) {
            // No filesystems found
            this.mediumMetrics.diskTotalGb = 0;
            this.mediumMetrics.diskUsedGb = 0;
            this.mediumMetrics.diskPercent = 0;
            this.mediumMetrics.fsType = "unknown";
            return;
          }

          // On Windows, look for C: drive first, otherwise use the first available
          let primaryFs = fsSize.find(fs => fs.mount === "C:" || fs.mount === "C:\\");
          if (!primaryFs) {
            // Try to find any mounted filesystem (not system mounts)
            primaryFs = fsSize.find(fs =>
              fs.mount &&
              !fs.mount.includes("Node") &&
              !fs.mount.includes("Snapshot") &&
              fs.size && fs.size > 0
            );
          }
          if (!primaryFs && fsSize.length > 0) {
            primaryFs = fsSize[0];
          }

          if (primaryFs && primaryFs.size && primaryFs.size > 0) {
            this.mediumMetrics.diskTotalGb = primaryFs.size / (1024 ** 3);
            this.mediumMetrics.diskUsedGb = (primaryFs.used ?? 0) / (1024 ** 3);
            this.mediumMetrics.diskPercent = Math.max(0, Math.min(100, Math.round(primaryFs.use ?? 0)));
            this.mediumMetrics.fsType = primaryFs.type ?? "unknown";
          } else {
            // Fallback: show UNKNOWN instead of wrong values
            this.mediumMetrics.diskTotalGb = 0;
            this.mediumMetrics.diskUsedGb = 0;
            this.mediumMetrics.diskPercent = 0;
            this.mediumMetrics.fsType = "unknown";
          }
        } catch (err) {
          console.error("[Hardware] FS Size processing error", err);
        }
      }).catch(err => console.error("[Hardware] Medium tick error", err));
    }

    // 3. TICK LENTO (Aprox. 10 segundos)
    // Dispara chamadas ultra-pesadas (WMI) em background (Fire-and-forget)
    if (now - this.lastSlowTick >= 10000) {
      this.lastSlowTick = now;

      // Network stats with better error handling
      si.networkStats().then(netStats => {
        try {
          if (!netStats || netStats.length === 0) {
            this.slowMetrics.rxSec = 0;
            this.slowMetrics.txSec = 0;
            this.slowMetrics.interfaceName = "unknown";
            return;
          }

          // Look for primary network interface (not loopback)
          const primaryNet = netStats.find(n =>
            n.iface &&
            !n.iface.toLowerCase().includes("loopback") &&
            !n.iface.toLowerCase().includes("lo")
          ) || netStats[0];

          if (primaryNet) {
            this.slowMetrics.rxSec = primaryNet.rx_sec ?? 0;
            this.slowMetrics.txSec = primaryNet.tx_sec ?? 0;
            this.slowMetrics.interfaceName = primaryNet.iface ?? "unknown";
          }
        } catch (err) {
          console.error("[Hardware] Net stats processing error", err);
        }
      }).catch(err => console.error("[Hardware] Slow tick net error", err));

      // GPU detection with fallbacks
      this.detectGpu().then(gpu => {
        this.slowMetrics.gpu = gpu;
      }).catch(err => console.error("[Hardware] GPU detection error", err));

      // Temperaturas via providers user-mode (systeminformation → ACPI)
      readTemperature().then(reading => {
        // Usamos cpuPackageC como temperatura CPU principal, fallback para coreMax
        const cpuTemp = reading.cpuPackageC ?? reading.cpuCoreMaxC;
        if (cpuTemp !== null) {
          this.slowMetrics.cpuTemperature = cpuTemp;
        }
        // Temperatura GPU: só o CORE pode alimentar o valor principal. Hotspot
        // e Memory Junction são guardados em campos separados com o seu sensor.
        if (reading.gpuCoreC !== null) {
          const sensorName = reading.gpuCoreSensor ?? "GPU Core";
          this.applyGpuTemperature(reading.gpuCoreC, reading.source, sensorName);
        }
        this.applyGpuSecondaryTemps(reading.gpuHotspotC, reading.gpuMemoryJunctionC);
      }).catch(() => { /* silent */ });
    }

    const uptime = os.uptime();

    // Processos vêm injetados da chamada (cache do ProtectionEngine)
    const topProcessesByCpu = [...processes].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    const topProcessesByRam = [...processes].sort((a, b) => b.memoryMb - a.memoryMb).slice(0, 5);

    // Stress Score
    const { stressScore, alerts, contributions } = this.calculateStress(
      this.fastMetrics.cpuUsage,
      this.fastMetrics.ramPercent,
      this.mediumMetrics.diskPercent,
      this.slowMetrics.cpuTemperature,
      topProcessesByCpu,
      topProcessesByRam
    );

    const snapshot: HardwareSnapshot = {
      cpu: {
        usage: this.fastMetrics.cpuUsage,
        model: this.staticMetrics.cpuModel,
        cores: this.staticMetrics.cpuCores,
        speed: this.staticMetrics.cpuSpeed,
        temperature: this.slowMetrics.cpuTemperature,
        // Auditado: sem sensor seguro (WMI/CIM em user-mode) o valor fica null e
        // o estado é "unavailable" — nunca inventamos uma temperatura fictícia
        // e nunca carregamos um driver para a obter.
        temperatureStatus: this.slowMetrics.cpuTemperature !== null ? "available" : "unavailable",
      },
      ram: {
        usagePercent: this.fastMetrics.ramPercent,
        usedGb: Math.round(this.fastMetrics.usedRamGb * 10) / 10,
        totalGb: Math.round(this.fastMetrics.totalRamGb * 10) / 10,
      },
      disk: {
        usagePercent: this.mediumMetrics.diskPercent,
        usedGb: Math.round(this.mediumMetrics.diskUsedGb * 10) / 10,
        totalGb: Math.round(this.mediumMetrics.diskTotalGb * 10) / 10,
        fsType: this.mediumMetrics.fsType,
      },
      network: {
        rxSec: Math.round(this.slowMetrics.rxSec),
        txSec: Math.round(this.slowMetrics.txSec),
        interfaceName: this.slowMetrics.interfaceName,
      },
      battery: {
        hasBattery: this.staticMetrics.hasBattery,
        percent: this.staticMetrics.batteryPercent,
        isCharging: this.staticMetrics.isCharging,
        timeRemaining: this.staticMetrics.timeRemaining,
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

  private calculateStress(
    cpuUsage: number,
    ramPercent: number,
    diskPercent: number,
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

    // CPU stress (max 35 points)
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

    // RAM stress (max 30 points)
    if (ramPercent > 85) {
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
    } else if (ramPercent > 70) {
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

    // Disk capacity alerts (NOT stress — separate finding)
    if (diskPercent > 90) {
      alerts.push({
        severity: diskPercent > 95 ? "critical" : "high",
        category: "disk",
        title: "Espaço em disco muito baixo",
        description: "Menos de 10% do disco principal está livre, o que pode impedir o sistema de funcionar corretamente.",
        recommendation: "Apague ficheiros temporários, esvazie a reciclagem ou desinstale aplicações desnecessárias.",
      });
    } else if (diskPercent > 80) {
      alerts.push({
        severity: "low",
        category: "disk",
        title: "Espaço em disco baixo",
        description: "O disco principal tem entre 10% e 20% de espaço livre.",
        recommendation: "Liberte espaço antes que o disco fique quase cheio.",
      });
    }

    return {
      stressScore: Math.min(100, score),
      alerts,
      contributions,
    };
  }
}
