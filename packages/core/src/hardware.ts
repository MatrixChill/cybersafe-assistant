import * as si from "systeminformation";
import type { HardwareSnapshot } from "@cybersafe/shared-types";

let previousNetStats: { rx_sec: number; tx_sec: number } | null = null;

export class HardwareHealthEngine {
  private lastSnapshot: HardwareSnapshot | null = null;

  async getSnapshot(): Promise<HardwareSnapshot> {
    const [cpuLoad, cpuInfo, mem, diskLayout, fsSize, netStats, battery, cpuTemp] =
      await Promise.all([
        si.currentLoad().catch(() => null),
        si.cpu().catch(() => null),
        si.mem().catch(() => null),
        si.diskLayout().catch(() => []),
        si.fsSize().catch(() => []),
        si.networkStats().catch(() => []),
        si.battery().catch(() => null),
        si.cpuTemperature().catch(() => null),
      ]);

    // CPU
    const cpuUsage = Math.round(cpuLoad?.currentLoad ?? 0);
    const cpuModel = cpuInfo?.brand ?? "Unknown";
    const cpuCores = cpuInfo?.cores ?? 0;
    const cpuSpeed = cpuInfo?.speed ?? 0;
    const temperature = cpuTemp?.main ?? null;

    // RAM
    const totalRam = mem ? mem.total / (1024 ** 3) : 0;
    const usedRam = mem ? (mem.total - mem.available) / (1024 ** 3) : 0;
    const ramPercent = totalRam > 0 ? Math.round((usedRam / totalRam) * 100) : 0;

    // Disk (primary)
    const primaryFs = fsSize.length > 0 ? fsSize[0] : null;
    const diskTotal = primaryFs ? primaryFs.size / (1024 ** 3) : 0;
    const diskUsed = primaryFs ? primaryFs.used / (1024 ** 3) : 0;
    const diskPercent = primaryFs ? Math.round(primaryFs.use ?? 0) : 0;
    const fsType = primaryFs?.type ?? "unknown";

    // Network
    const primaryNet = netStats.length > 0 ? netStats[0] : null;
    const rxSec = primaryNet?.rx_sec ?? previousNetStats?.rx_sec ?? 0;
    const txSec = primaryNet?.tx_sec ?? previousNetStats?.tx_sec ?? 0;
    if (primaryNet) {
      previousNetStats = { rx_sec: rxSec, tx_sec: txSec };
    }

    // Battery
    const hasBattery = battery?.hasBattery ?? false;
    const batteryPercent = battery?.percent ?? 0;
    const isCharging = battery?.isCharging ?? false;
    const timeRemaining = battery?.timeRemaining
      ? battery.timeRemaining > 0
        ? battery.timeRemaining
        : null
      : null;

    // Stress Score
    const { stressScore, stressAlerts } = this.calculateStress(
      cpuUsage,
      ramPercent,
      diskPercent,
      temperature,
    );

    const snapshot: HardwareSnapshot = {
      cpu: {
        usage: cpuUsage,
        model: cpuModel,
        cores: cpuCores,
        speed: cpuSpeed,
        temperature,
      },
      ram: {
        usagePercent: ramPercent,
        usedGb: Math.round(usedRam * 10) / 10,
        totalGb: Math.round(totalRam * 10) / 10,
      },
      disk: {
        usagePercent: diskPercent,
        usedGb: Math.round(diskUsed * 10) / 10,
        totalGb: Math.round(diskTotal * 10) / 10,
        fsType,
      },
      network: {
        rxSec: Math.round(rxSec),
        txSec: Math.round(txSec),
        interfaceName: primaryNet?.iface ?? "unknown",
      },
      battery: {
        hasBattery,
        percent: batteryPercent,
        isCharging,
        timeRemaining,
      },
      stressScore,
      stressAlerts,
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
  ): { stressScore: number; stressAlerts: string[] } {
    let score = 0;
    const alerts: string[] = [];

    // CPU stress
    if (cpuUsage > 95) {
      score += 35;
      alerts.push("CPU em carga crítica (>95%)");
    } else if (cpuUsage > 90) {
      score += 30;
      alerts.push("CPU em carga alta (>90%)");
    } else if (cpuUsage > 75) {
      score += 15;
    }

    // RAM stress
    if (ramPercent > 95) {
      score += 30;
      alerts.push("Memória RAM quase esgotada (>95%)");
    } else if (ramPercent > 85) {
      score += 25;
      alerts.push("Memória RAM em estado crítico (>85%)");
    } else if (ramPercent > 70) {
      score += 10;
    }

    // Disk stress
    if (diskPercent > 95) {
      score += 25;
      alerts.push("Disco quase cheio (>95%)");
    } else if (diskPercent > 90) {
      score += 20;
      alerts.push("Espaço em disco baixo (>90%)");
    } else if (diskPercent > 80) {
      score += 10;
    }

    // Temperature stress
    if (temperature !== null) {
      if (temperature > 90) {
        score += 25;
        alerts.push(`Temperatura CPU perigosa (${temperature}°C)`);
      } else if (temperature > 80) {
        score += 15;
        alerts.push(`Temperatura CPU elevada (${temperature}°C)`);
      }
    }

    return {
      stressScore: Math.min(100, score),
      stressAlerts: alerts,
    };
  }
}
