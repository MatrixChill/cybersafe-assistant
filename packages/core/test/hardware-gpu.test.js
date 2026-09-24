import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDedicatedGpu, gpuSelectionScore, HardwareHealthEngine } from "../dist/hardware.js";
import { pickPrimaryGpuController } from "../dist/gpu-selection.js";

/**
 * Seleção determinística de GPU (multi-GPU).
 *
 * No hardware de desenvolvimento existem DUAS GPUs AMD:
 *   - "AMD Radeon(TM) Graphics"  → integrada (nunca deve ser escolhida)
 *   - "AMD Radeon RX 5600 XT"    → dedicada (deve ser escolhida)
 * O bug anterior escolhia a primeira listada (integrada) e deixava a
 * temperatura oscilar. Estes testes fixam a regra.
 */
describe("GPU disk selection (multi-GPU)", () => {
  it("classifica a integrada como não dedicada", () => {
    assert.equal(isDedicatedGpu("AMD Radeon(TM) Graphics"), false);
    assert.equal(isDedicatedGpu("AMD Radeon Graphics"), false);
    assert.equal(isDedicatedGpu("Intel(R) UHD Graphics 630"), false);
    assert.equal(isDedicatedGpu("Intel(R) Iris(R) Xe Graphics"), false);
  });

  it("classifica a dedicada como dedicada", () => {
    assert.equal(isDedicatedGpu("AMD Radeon RX 5600 XT"), true);
    assert.equal(isDedicatedGpu("NVIDIA GeForce RTX 4070"), true);
    assert.equal(isDedicatedGpu("NVIDIA GeForce GTX 1660"), true);
    assert.equal(isDedicatedGpu("AMD Radeon RX 7900 XTX"), true);
  });

  it("modelos vazios/desconhecidos não são dedicados", () => {
    assert.equal(isDedicatedGpu(""), false);
    assert.equal(isDedicatedGpu(null), false);
    assert.equal(isDedicatedGpu(undefined), false);
    assert.equal(isDedicatedGpu("Dispositivo gráfico"), false);
  });

  it("a dedicada ganha à integrada na pontuação", () => {
    const integrated = { model: "AMD Radeon(TM) Graphics", vramTotalMb: 512 };
    const discrete = { model: "AMD Radeon RX 5600 XT", vramTotalMb: 6144 };
    assert.ok(
      gpuSelectionScore(discrete) > gpuSelectionScore(integrated),
      "a GPU dedicada deve ter sempre pontuação superior",
    );

    // A escolha determinística ordena por pontuação, não pela ordem do controlador.
    const controllers = [integrated, discrete];
    const chosen = controllers
      .map((g, index) => ({ g, index, score: gpuSelectionScore(g) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0].g;
    assert.equal(chosen.model, "AMD Radeon RX 5600 XT");
  });

  it("duas dedicadas: desempata pela VRAM", () => {
    const lowVram = { model: "AMD Radeon RX 5600 XT", vramTotalMb: 6144 };
    const highVram = { model: "NVIDIA GeForce RTX 4090", vramTotalMb: 24576 };
    assert.ok(gpuSelectionScore(highVram) > gpuSelectionScore(lowVram));
  });

  it("pickPrimaryGpuController escolhe a dedicada e não a primeira da lista", () => {
    const controllers = [
      { model: "AMD Radeon(TM) Graphics", vram: 512 },
      { model: "AMD Radeon RX 5600 XT", vram: 6144 },
    ];
    assert.equal(pickPrimaryGpuController(controllers).model, "AMD Radeon RX 5600 XT");
    assert.equal(pickPrimaryGpuController([]), null);
  });

  it("a temperatura do systeminformation é lida da GPU dedicada, nunca da integrada", () => {
    // A ordenação usada pelo SystemInformationProvider: filtra controladores com
    // temperatura válida e prefere a dedicada.
    const controllers = [
      { model: "AMD Radeon(TM) Graphics", temperatureGpu: 41 },
      { model: "AMD Radeon RX 5600 XT", temperatureGpu: 58 },
    ].filter((g) => g.temperatureGpu != null && g.temperatureGpu > 0);
    const chosen = controllers.find((g) => isDedicatedGpu(g.model)) ?? controllers[0];
    assert.equal(chosen.model, "AMD Radeon RX 5600 XT");
    assert.equal(chosen.temperatureGpu, 58);
  });
});

/**
 * Mapeamento de sensores de temperatura da GPU. O bug real: qualquer sensor
 * não-hotspot (ex.: "GPU Memory") era publicado como temperatura principal.
 * Agora só o CORE alimenta o valor "GPU"; hotspot/junction ficam separados.
 */
describe("GPU temperature sensor mapping", () => {
  function engineWithGpu() {
    const engine = new HardwareHealthEngine();
    // Campos privados do TS são apenas compile-time: acessíveis em runtime no dist.
    engine.slowMetrics.gpu = {
      available: true,
      model: "AMD Radeon RX 5600 XT",
      usagePercent: 3,
      vramTotalMb: 6144,
      vramUsedMb: 512,
      gpus: [],
    };
    return engine;
  }

  it("core alimenta `temperature` e hotspot/junction ficam em campos próprios", () => {
    const engine = engineWithGpu();
    engine.applyGpuTemperature(58, "systeminformation", "GPU Core");
    engine.applyGpuSecondaryTemps(72, 62);

    const gpu = engine.buildGpuSnapshot();
    assert.equal(gpu.temperature, 58, "apenas a temperatura core é mostrada como GPU");
    assert.equal(gpu.coreTemperature, 58);
    assert.equal(gpu.hotspotTemperature, 72);
    assert.equal(gpu.memoryJunctionTemperature, 62);
    assert.equal(gpu.temperatureSensor, "GPU Core");
    assert.equal(gpu.temperatureSource, "systeminformation");
  });

  it("uma poll falhada não apaga um valor recente (status stale)", () => {
    const engine = engineWithGpu();
    engine.applyGpuTemperature(58, "systeminformation", "GPU Core");
    engine.gpuTempState.updatedAt = Date.now() - 5_000; // dentro do TTL (25s)
    engine.applyGpuTemperature(null, "systeminformation", "GPU Core");

    const gpu = engine.buildGpuSnapshot();
    assert.equal(gpu.temperature, 58, "o valor bom mantém-se dentro do TTL");
    assert.equal(gpu.temperatureStatus, "stale");
  });

  it("duas polls falhadas seguidas ainda não apagam o valor (10s de tick)", () => {
    const engine = engineWithGpu();
    engine.applyGpuTemperature(58, "systeminformation", "GPU Core");
    engine.gpuTempState.updatedAt = Date.now() - 20_000; // duas polls de 10s
    engine.applyGpuTemperature(null, "systeminformation", "GPU Core");

    const gpu = engine.buildGpuSnapshot();
    assert.equal(gpu.temperature, 58);
    assert.equal(gpu.temperatureStatus, "stale");
  });

  it("passado o TTL, a temperatura passa a indisponível (nunca valor fantasma)", () => {
    const engine = engineWithGpu();
    engine.applyGpuTemperature(58, "systeminformation", "GPU Core");
    engine.gpuTempState.updatedAt = Date.now() - 60_000; // além do TTL de 25s
    engine.applyGpuTemperature(null, "systeminformation", "GPU Core");

    const gpu = engine.buildGpuSnapshot();
    assert.equal(gpu.temperature, null);
    assert.equal(gpu.temperatureStatus, "unavailable");
  });
});
