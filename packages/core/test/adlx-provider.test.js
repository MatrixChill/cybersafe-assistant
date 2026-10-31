import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { AdlxGpuTemperatureProvider } from "../dist/adlx-provider.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DIST_ADLX = path.resolve(__dirname, "..", "dist", "adlx-provider.js");

const RX_5600_XT = { model: "AMD Radeon RX 5600 XT", temperatureC: 62, hotspotC: 74 };

describe("AdlxGpuTemperatureProvider", () => {
  it("publica core e hotspot de uma GPU AMD dedicada com proveniência", async () => {
    const provider = new AdlxGpuTemperatureProvider(async () => [RX_5600_XT]);
    const reading = await provider.read();
    assert.equal(reading.gpuCoreC, 62);
    assert.equal(reading.gpuHotspotC, 74);
    assert.match(reading.gpuCoreSensor, /GPUTemperature/);
    assert.match(reading.gpuHotspotSensor, /GPUHotspotTemperature/);
    assert.equal(await provider.isAvailable(), true);
  });

  it("nunca preenche CPU, motherboard ou ventoinhas", async () => {
    const provider = new AdlxGpuTemperatureProvider(async () => [RX_5600_XT]);
    const reading = await provider.read();
    assert.equal(reading.cpuPackageC, null);
    assert.equal(reading.cpuCoreMaxC, null);
    assert.deepEqual(reading.motherboard, []);
    assert.deepEqual(reading.fans, []);
  });

  it("ignora a iGPU Radeon (não é dedicada)", async () => {
    const provider = new AdlxGpuTemperatureProvider(async () => [
      { model: "AMD Radeon(TM) Graphics", temperatureC: 58, hotspotC: null },
    ]);
    const reading = await provider.read();
    assert.equal(reading.gpuCoreC, null);
    assert.equal(await provider.isAvailable(), false);
  });

  it("ignora GPU que não seja AMD", async () => {
    const provider = new AdlxGpuTemperatureProvider(async () => [
      { model: "NVIDIA GeForce RTX 3060", temperatureC: 60, hotspotC: 70 },
    ]);
    const reading = await provider.read();
    assert.equal(reading.gpuCoreC, null);
    assert.equal(reading.gpuHotspotC, null);
  });

  it("fonte ausente (null) → indisponível, nunca 0 °C", async () => {
    const provider = new AdlxGpuTemperatureProvider(async () => null);
    const reading = await provider.read();
    assert.equal(reading.gpuCoreC, null);
    assert.equal(reading.gpuHotspotC, null);
    assert.equal(await provider.isAvailable(), false);
  });

  it("fonte que lança erro → indisponível, sem propagar exceção", async () => {
    const provider = new AdlxGpuTemperatureProvider(async () => {
      throw new Error("ADLX runtime not found");
    });
    const reading = await provider.read();
    assert.equal(reading.gpuCoreC, null);
    assert.equal(await provider.isAvailable(), false);
  });

  it("rejeita valores fora de 0–150 °C, NaN e não numéricos", async () => {
    for (const bad of [0, -5, 151, Number.NaN, "62", null, undefined]) {
      const provider = new AdlxGpuTemperatureProvider(async () => [
        { model: "AMD Radeon RX 5600 XT", temperatureC: bad, hotspotC: bad },
      ]);
      const reading = await provider.read();
      assert.equal(reading.gpuCoreC, null, `core aceitou ${String(bad)}`);
      assert.equal(reading.gpuHotspotC, null, `hotspot aceitou ${String(bad)}`);
    }
  });

  it("hotspot sem core não é promovido a temperatura principal", async () => {
    const provider = new AdlxGpuTemperatureProvider(async () => [
      { model: "AMD Radeon RX 5600 XT", temperatureC: null, hotspotC: 79 },
    ]);
    const reading = await provider.read();
    assert.equal(reading.gpuCoreC, null);
    assert.equal(reading.gpuHotspotC, 79);
  });

  it("o bundle não contém spawn nem acesso a drivers", () => {
    const source = fs.readFileSync(DIST_ADLX, "utf8");
    for (const forbidden of ["spawn(", "child_process", "WinRing0", "LibreHardwareMonitor", "exec("]) {
      assert.ok(!source.includes(forbidden), `adlx-provider.js não pode conter \"${forbidden}\"`);
    }
  });
});
