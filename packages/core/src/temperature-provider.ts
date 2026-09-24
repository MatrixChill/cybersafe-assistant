// ── Temperature Provider Abstraction ──
// Providers tentados em ordem: systeminformation → ACPI → unavailable.
//
// SEGURANÇA: não existe (nem pode existir) um provider baseado em
// LibreHardwareMonitor/WinRing0. A LHM ≤ 0.9.5-pre453 embute o driver WinRing0
// (VulnerableDriver:WinNT/Winring0, CVE-2020-14979, blocklisted pelo Defender) e
// extrai-o em runtime para o disco como `<executável>.sys`. Uma temperatura que
// só seja possível obter carregando esse driver deve ficar indisponível.

export interface TemperatureReading {
  cpuPackageC: number | null;
  cpuCoreMaxC: number | null;
  /** Temperatura principal/core da GPU — é a única que pode ser mostrada como "GPU". */
  gpuCoreC: number | null;
  /** Hotspot da GPU (separado: não é a temperatura principal). */
  gpuHotspotC: number | null;
  /** Memory Junction da GPU (separado: não é a temperatura principal). */
  gpuMemoryJunctionC: number | null;
  /** Nome do sensor que originou `gpuCoreC` (proveniência auditável). */
  gpuCoreSensor?: string | null;
  /** Nome do sensor que originou `gpuHotspotC`. */
  gpuHotspotSensor?: string | null;
  nvme: Array<{ name: string; tempC: number }>;
  motherboard: Array<{ name: string; tempC: number }>;
  fans: Array<{ name: string; rpm: number }>;
  source: string;
  timestamp: string;
}

export interface TemperatureProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  read(): Promise<TemperatureReading>;
}