/**
 * ── PROVIDER ADL: temperatura real de GPU (e CPU) pelo driver AMD ────────────
 *
 * Fonte: `atiadlxx.dll`, API user-mode distribuída com o AMD Software que já
 * está instalado no PC. Não instala nada, não carregam drivers de kernel, não
 * exige elevação. É o caminho legítimo para a Radeon RX 5600 XT quando as APIs
 * genéricas (systeminformation/WMI) não devolvem sensor nenhum.
 *
 * O que este provider NUNCA faz:
 *   - chamar ADL dentro do processo do serviço (vai no worker: ver
 *     `adl-bridge.ts`; a ADL desta máquina rebentou com access violation);
 *   - transformar falha/ausência em número. Sem leitura plausível, os campos
 *     ficam `null` e o estado do snapshot é indisponível;
 *   - apresentar zona térmica ou sensor de um adaptador como sendo de outro.
 *
 * Identidade: cada campo publicado leva o nome do sensor e o modelo do
 * adaptador de onde veio, porque misturar origens sem rótulo é exatamente o
 * erro que este subsistema já cometeu.
 */

import type { TemperatureProvider, TemperatureReading } from "./temperature-provider.js";
import {
  readAdlSensors,
  type AdlAdapterSample,
  type AdlBridgeOptions,
  type AdlReading,
} from "./adl-bridge.js";
import { isDedicatedGpu } from "./gpu-selection.js";

export type AdlReader = (options?: AdlBridgeOptions) => Promise<AdlReading>;

/** Rótulos nomeiam o sensor EXATO que a ADL expõe neste driver. O valor
 *  publicado como temperatura do núcleo vem de `TEMPERATURE_EDGE` (o sensor que
 *  as ferramentas chamam "GPU Temperature"); dizer "Package" ou fingir um
 *  `TEMPERATURE_GFX` que o driver não expõe seria mentira sobre a origem. */
const SENSOR_GPU_CORE = "GPU Edge (AMD ADL PMLog TEMPERATURE_EDGE)";
const SENSOR_GPU_HOTSPOT = "GPU Hotspot (AMD ADL PMLog TEMPERATURE_HOTSPOT)";
const SENSOR_GPU_MEMORY = "GPU Memory Junction (AMD ADL PMLog TEMPERATURE_MEM)";
const SENSOR_CPU = "CPU (AMD ADL PMLog TEMPERATURE_CPU)";
/** Origem alternativa, só quando é dela que o valor veio. */
const SENSOR_GPU_CORE_OD6 = "GPU Core (AMD ADL Overdrive6 Temperature)";

/** °C só quando fisicamente possível: 0, negativos, >150 e NaN são "sem leitura". */
export function adlCelsius(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value <= 0 || value > 150) return null;
  return Math.round(value);
}

/** Percentagens de utilização: 0 é um valor válido e significa 0%. */
function adlPercent(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return Math.round(value);
}

function adlRpm(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 25_000) return null;
  return Math.round(value);
}

const hasGpuTemperature = (sample: AdlAdapterSample): boolean =>
  adlCelsius(sample.pmlog.gpuCoreC) !== null || adlCelsius(sample.od6Celsius) !== null;

/**
 * Escolhe o adaptador a publicar como "a GPU".
 * Critério verificável, por ordem:
 *   1. presente e dedicado pelo nome do modelo (nunca a iGPU do CPU);
 *   2. qualquer adaptador presente com temperatura de GPU;
 *   3. o adaptador que reportar temperatura de CPU (caso de iGPU com PMLog).
 * Devolve `null` quando a amostra não tem sensor nenhum utilizável.
 */
export function pickGpuSample(samples: AdlAdapterSample[]): AdlAdapterSample | null {
  const usable = samples.filter((s) => hasGpuTemperature(s));
  const dedicated = usable.find(
    (s) => s.present !== false && /\bRadeon\b/i.test(s.adapterName) && isDedicatedGpu(s.adapterName),
  );
  if (dedicated) return dedicated;
  const anyGpu = usable.find((s) => s.present !== false) ?? usable[0] ?? null;
  if (anyGpu) return anyGpu;
  return samples.find((s) => adlCelsius(s.pmlog.cpuC) !== null) ?? null;
}

function emptyAdlReading(): TemperatureReading {
  return {
    cpuPackageC: null,
    cpuCoreMaxC: null,
    gpuCoreC: null,
    gpuHotspotC: null,
    gpuMemoryJunctionC: null,
    gpuCoreSensor: null,
    gpuHotspotSensor: null,
    cpuSensor: null,
    nvme: [],
    motherboard: [],
    fans: [],
    source: "AMD ADL",
    timestamp: new Date().toISOString(),
  };
}

export class AdlSensorProvider implements TemperatureProvider {
  name = "AMD ADL";

  private readonly reader: AdlReader;
  private readonly options: AdlBridgeOptions;

  /** Estado da última tentativa, para os consumidores distinguirem
   *  `unsupported` (não há ADL aqui) de `error`/`timeout` (havia e falhou). */
  lastStatus: AdlReading["status"] | null = null;
  lastReason: string | null = null;

  constructor(reader: AdlReader = readAdlSensors, options: AdlBridgeOptions = {}) {
    this.reader = reader;
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    const reading = await this.read();
    return (
      reading.cpuPackageC !== null ||
      reading.gpuCoreC !== null ||
      reading.gpuHotspotC !== null ||
      reading.gpuMemoryJunctionC !== null
    );
  }

  async read(): Promise<TemperatureReading> {
    const out = emptyAdlReading();
    let bridge: AdlReading;
    try {
      bridge = await this.reader(this.options);
    } catch {
      // O bridge não deve lançar; se lançar, é indisponibilidade, não 0 °C.
      this.lastStatus = "error";
      this.lastReason = "bridge-threw";
      return out;
    }
    this.lastStatus = bridge.status;
    this.lastReason = bridge.reason;
    if (bridge.status !== "ok") return out;

    // CPU: a ADL reporta TEMPERATURE_CPU no adaptador que expõe esse sensor
    // (tipicamente o iGPU do Ryzen). É uma temperatura de CPU medida pelo
    // driver — NÃO a confundir com CPU Package/Tdie, por isso o rótulo diz
    // exatamente de onde veio e nunca afirma "Package".
    const cpuSample = bridge.samples.find((s) => adlCelsius(s.pmlog.cpuC) !== null);
    if (cpuSample) {
      out.cpuPackageC = adlCelsius(cpuSample.pmlog.cpuC);
      out.cpuSensor = `${SENSOR_CPU} @ ${cpuSample.adapterName || `adapter ${cpuSample.adapterIndex}`}`;
    }

    const gpu = pickGpuSample(bridge.samples);
    if (gpu) {
      const identity = gpu.adapterName || `adapter ${gpu.adapterIndex}`;
      const fromPmlog = adlCelsius(gpu.pmlog.gpuCoreC);
      const core = fromPmlog ?? adlCelsius(gpu.od6Celsius);
      if (core !== null) {
        out.gpuCoreC = core;
        // O rótulo tem de acompanhar a origem real do número: um valor vindo do
        // Overdrive6 não pode ser apresentado como leitura de PMLog.
        out.gpuCoreSensor =
          `${fromPmlog !== null ? SENSOR_GPU_CORE : SENSOR_GPU_CORE_OD6} @ ${identity}`;
      }
      const hotspot = adlCelsius(gpu.pmlog.gpuHotspotC);
      if (hotspot !== null) {
        out.gpuHotspotC = hotspot;
        out.gpuHotspotSensor = `${SENSOR_GPU_HOTSPOT} @ ${identity}`;
      }
      const memory = adlCelsius(gpu.pmlog.gpuMemoryC);
      if (memory !== null) {
        out.gpuMemoryJunctionC = memory;
        out.gpuMemorySensor = `${SENSOR_GPU_MEMORY} @ ${identity}`;
      }

      const rpm = adlRpm(gpu.pmlog.fanRpm);
      if (rpm !== null) out.fans.push({ name: `GPU Fan (AMD ADL) @ ${identity}`, rpm });

      // Utilização no mesmo sample: a temperatura já obrigou o PMLog a ser lido,
      // por isto custa zero e é a ÚNICA fonte de utilização do GPU neste sistema
      // (o `utilizationGpu` do systeminformation devolve null no driver AMD atual).
      const util = adlUtilization(gpu);
      if (util.gpuPercent !== null || util.memoryPercent !== null) {
        out.gpuPercent = util.gpuPercent;
        out.gpuMemoryPercent = util.memoryPercent;
        out.gpuPercentSensor = `GPU_ACTIVITY/GPU_ACTIVITY_MEM @ ${identity}`;
      }
    }

    // O timestamp do provider é o momento da aquisição no processo pai.
    out.timestamp = bridge.acquiredAt;
    return out;
  }
}

/** Utilitário de diagnóstico para testes/integração: percentagens ADL lidas. */
export function adlUtilization(sample: AdlAdapterSample): {
  gpuPercent: number | null;
  memoryPercent: number | null;
} {
  return {
    gpuPercent: adlPercent(sample.pmlog.gpuUtilPercent),
    memoryPercent: adlPercent(sample.pmlog.memUtilPercent),
  };
}
