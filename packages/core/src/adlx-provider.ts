// ── Provider de temperatura AMD ADLX (GPU Radeon, user-mode) ──
// Contrato puro: recebe amostras JÁ LIDAS por uma fonte injetada e publica
// apenas temperaturas plausíveis de GPU AMD DEDICADA.
//
// Limites deliberados:
//  - Não lança processos, não carrega DLLs e não instala drivers. A fonte que
//    fala com o SDK ADLX ainda não existe; sem fonte o provider fica
//    indisponível e nunca publica 0 °C, NaN ou valores antigos.
//  - Não está ligado à cadeia por omissão de `readTemperature()`.
//  - Só preenche GPU (gpuCoreC / gpuHotspotC). Nunca toca em CPU nem em
//    motherboard, e nunca promove o hotspot a temperatura principal.
//  - Nenhuma fonte pode usar o driver WinRing0 (ver temperature.ts).
import type { TemperatureProvider, TemperatureReading } from "./temperature-provider.js";
import { isDedicatedGpu } from "./gpu-selection.js";

/** Métricas de uma GPU tal como devolvidas pelo ADLX (IADLXGPUMetrics). */
export interface AdlxGpuSample {
  /** Nome comercial do adaptador, p.ex. "AMD Radeon RX 5600 XT". */
  model: string;
  /** GPUTemperature (°C), ou null se o driver não a reportar. */
  temperatureC?: number | null;
  /** GPUHotspotTemperature (°C), ou null se não existir. */
  hotspotC?: number | null;
}

/** Fonte injetada. Devolve null quando o ADLX não está disponível. */
export type AdlxSampleSource = () => Promise<AdlxGpuSample[] | null>;

const ADLX_SENSOR_CORE = "GPU Core (AMD ADLX GPUTemperature)";
const ADLX_SENSOR_HOTSPOT = "GPU Hotspot (AMD ADLX GPUHotspotTemperature)";

/** Mesmo intervalo plausível usado pelo provider systeminformation. */
function plausibleTemperature(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw <= 0 || raw > 150) return null;
  return Math.round(raw);
}

function isAmdDedicated(sample: AdlxGpuSample): boolean {
  const model = (sample.model ?? "").trim();
  return /\bRadeon\b/i.test(model) && isDedicatedGpu(model);
}

function emptyReading(source: string): TemperatureReading {
  return {
    cpuPackageC: null, cpuCoreMaxC: null, gpuCoreC: null, gpuHotspotC: null, gpuMemoryJunctionC: null,
    gpuCoreSensor: null, gpuHotspotSensor: null,
    nvme: [], motherboard: [], fans: [], source, timestamp: new Date().toISOString(),
  };
}

export class AdlxGpuTemperatureProvider implements TemperatureProvider {
  name = "AMD ADLX";
  private readonly source: AdlxSampleSource;

  constructor(source: AdlxSampleSource) {
    this.source = source;
  }

  private async samples(): Promise<AdlxGpuSample[]> {
    try {
      const result = await this.source();
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    const reading = await this.read();
    return reading.gpuCoreC !== null || reading.gpuHotspotC !== null;
  }

  async read(): Promise<TemperatureReading> {
    const reading = emptyReading(this.name);
    // Só a GPU AMD dedicada conta. Uma iGPU Radeon fica de fora.
    const gpu = (await this.samples()).find(isAmdDedicated);
    if (!gpu) return reading;

    const core = plausibleTemperature(gpu.temperatureC);
    if (core !== null) {
      reading.gpuCoreC = core;
      reading.gpuCoreSensor = ADLX_SENSOR_CORE;
    }
    const hotspot = plausibleTemperature(gpu.hotspotC);
    if (hotspot !== null) {
      reading.gpuHotspotC = hotspot;
      reading.gpuHotspotSensor = ADLX_SENSOR_HOTSPOT;
    }
    return reading;
  }
}
