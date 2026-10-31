// ── Temperature Provider Abstraction ──
// Providers tentados em ordem: AMD ADL → systeminformation → ACPI → unavailable.
// A ordem É a prioridade verificável: cada campo do reading mergeado guarda a
// origem que o preencheu (`cpuSensor`, `gpuCoreSensor`, …), por isso um valor
// nunca troca de fonte em silêncio.
//
// SEGURANÇA: não existe (nem pode existir) um provider baseado em
// LibreHardwareMonitor/WinRing0. A LHM ≤ 0.9.5-pre453 embute o driver WinRing0
// (VulnerableDriver:WinNT/Winring0, CVE-2020-14979, blocklisted pelo Defender) e
// extrai-o em runtime para o disco como `<executável>.sys`. Uma temperatura que
// só seja possível obter carregando esse driver deve ficar indisponível.

export interface TemperatureReading {
  cpuPackageC: number | null;
  cpuCoreMaxC: number | null;
  /** Nome do sensor/proveniência de `cpuPackageC`. Obrigatório quando o valor é
   *  publicado: uma temperatura de CPU sem origem identificada não pode ser
   *  mostrada como se fosse a do processador certo. */
  cpuSensor?: string | null;
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
  /** Nome do sensor que originou `gpuMemoryJunctionC`. */
  gpuMemorySensor?: string | null;
  nvme: Array<{ name: string; tempC: number }>;
  motherboard: Array<{ name: string; tempC: number }>;
  fans: Array<{ name: string; rpm: number }>;
  /**
   * Utilização do GPU em %, medida no MESMO PMLog que dá a temperatura: uma
   * aquisição, dois indicadores, nenhum custo extra. `undefined` = este provider
   * não reporta utilização; `null` = reporta e não havia valor válido. A
   * diferença importa: só a segunda é uma ausência medida.
   */
  gpuPercent?: number | null;
  /** Utilização da memória do GPU (VRAM) em %, do mesmo PMLog (ActivityMemory). */
  gpuMemoryPercent?: number | null;
  /** Nome exato dos contadores que encheram as percentagens acima. */
  gpuPercentSensor?: string | null;
  source: string;
  timestamp: string;
}

export interface TemperatureProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  read(): Promise<TemperatureReading>;
}