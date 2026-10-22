import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * TP-PAP-HARDWARE-TRUTH — B1: frescura da temperatura da CPU.
 *
 * Defeito medido (2026-10-18, providers reais): `slowMetrics.cpuTemperature`
 * só era escrito quando a leitura vinha não-nula; `temperatureStatus` era
 * derivado de `!== null`. Um único valor válido ficava "available" para sempre,
 * mesmo que o sensor desaparecesse — um valor em cache sem idade.
 *
 * Estes testes fixam o modelo da GPU aplicado à CPU (TTL de 25 s): valor bom
 * mantém-se dentro do TTL como "stale" e expira para null/"unavailable" depois.
 * Nenhum teste faz I/O real: usa os seams do motor como os testes da GPU.
 */

function engine() {
  // Campos privados do TS são compile-time: em runtime (dist) são acessíveis.
  return new HardwareHealthEngine();
}

describe("CPU temperature freshness (TTL 25 s)", () => {
  it("leitura válida publica valor e estado available", () => {
    const e = engine();
    e.applyCpuTemperature(57);

    const cpu = e.buildCpuTemperature();
    assert.equal(cpu.value, 57);
    assert.equal(cpu.status, "available");
    assert.ok(e.cpuTempState.updatedAt > 0, "o instante da leitura boa tem de ficar registado");
  });

  it("poll falhada dentro do TTL mantém o último valor bom como stale", () => {
    const e = engine();
    e.applyCpuTemperature(57);
    e.cpuTempState.updatedAt = Date.now() - 5_000; // dentro dos 25 s
    e.applyCpuTemperature(null);

    const cpu = e.buildCpuTemperature();
    assert.equal(cpu.value, 57, "uma falha isolada não apaga um valor recente");
    assert.equal(cpu.status, "stale");
  });

  it("duas polls falhadas seguidas (tick de 10 s) ainda não apagam o valor", () => {
    const e = engine();
    e.applyCpuTemperature(57);
    e.cpuTempState.updatedAt = Date.now() - 20_000;
    e.applyCpuTemperature(null);

    const cpu = e.buildCpuTemperature();
    assert.equal(cpu.value, 57);
    assert.equal(cpu.status, "stale");
  });

  it("passado o TTL a temperatura passa a indisponível (nunca valor fantasma)", () => {
    const e = engine();
    e.applyCpuTemperature(57);
    e.cpuTempState.updatedAt = Date.now() - 60_000;
    e.applyCpuTemperature(null);

    const cpu = e.buildCpuTemperature();
    assert.equal(cpu.value, null);
    assert.equal(cpu.status, "unavailable");
  });

  it("o valor também expira no build sem nova poll (tick atrasado/processo suspenso)", () => {
    const e = engine();
    e.applyCpuTemperature(57);
    e.cpuTempState.updatedAt = Date.now() - 60_000;

    const cpu = e.buildCpuTemperature();
    assert.equal(cpu.value, null, "a idade é recalculada no instante do snapshot");
    assert.equal(cpu.status, "unavailable");
  });

  it("sem nenhuma leitura válida o estado é indisponível (nunca 0 °C)", () => {
    const e = engine();
    const cpu = e.buildCpuTemperature();
    assert.equal(cpu.value, null);
    assert.equal(cpu.status, "unavailable");
  });

  it("0 °C / NaN / 150 não são aceites como leitura (contrato do provider: <=0 é sem leitura)", () => {
    const e = engine();
    e.applyCpuTemperature(57);
    e.cpuTempState.updatedAt = Date.now() - 5_000;

    e.applyCpuTemperature(0);
    assert.equal(e.buildCpuTemperature().value, 57, "0 não substitui um valor real");
    assert.equal(e.buildCpuTemperature().status, "stale");

    e.applyCpuTemperature(Number.NaN);
    assert.equal(e.buildCpuTemperature().value, 57);

    e.applyCpuTemperature(150);
    assert.equal(e.buildCpuTemperature().value, 57);

    e.applyCpuTemperature(120); // válido (>0 e <150)
    assert.equal(e.buildCpuTemperature().value, 120);
    assert.equal(e.buildCpuTemperature().status, "available");
  });

  it("temperatura expirada não contribui para o stress nem gera alerta térmico", () => {
    const e = engine();
    e.applyCpuTemperature(87); // seria >80: 25 pontos + alerta, se estivesse fresca
    e.cpuTempState.updatedAt = Date.now() - 60_000;

    const effective = e.buildCpuTemperature();
    const result = e.calculateStress(10, 10, initialDiskSnapshot(), effective.value, [], []);

    assert.equal(effective.value, null);
    assert.equal(result.contributions.temperature, 0);
    assert.ok(
      !result.alerts.some((a) => a.category === "cpu" && /Temperatura/i.test(a.title)),
      "um valor expirado não pode continuar a gerar alertas térmicos",
    );
  });

  it("temperatura fresca continua a contribuir para o stress (caminho normal intacto)", () => {
    const e = engine();
    e.applyCpuTemperature(87);

    const effective = e.buildCpuTemperature();
    const result = e.calculateStress(10, 10, initialDiskSnapshot(), effective.value, [], []);

    assert.equal(effective.status, "available");
    assert.equal(result.contributions.temperature, 25);
    assert.ok(result.alerts.some((a) => a.category === "cpu" && /Temperatura/i.test(a.title)));
  });
});
