import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AcpiProvider } from "../dist/index.js";

/**
 * FINAL-INTEGRATION-20261014 — orchestration-acpi-honesty (TDD, Kilo scope).
 *
 * Root autorização EXATA: packages/core/src/temperature.ts + este novo teste.
 *
 * PROBLEMA: AcpiProvider.read() popula cpuPackageC a partir de
 * MSAcpi_ThermalZoneTemperature — mas esta WMI reporta a ZONA TÉRMICA
 * (motherboard), NÃO CPU Package. Atribuir zone=motherboard a cpuPackageC é
 * uma alegação não provada. TDD RED→GREEN:
 *
 *   1. AcpiProvider.read() NUNCA popula cpuPackageC (null).
 *   2. Temperatura ACPI válida → motherboard[] com name identificado.
 *   3. ACPI stdout absent → motherboard [] (não inventa).
 *   4. PowerShell timeout/error → empty reading (source "ACPI"), não throws.
 *
 * Mock: injeta fixture stdout simulando MSAcpi_ThermalZoneTemperature.
 */

function mockAcpiProvider(stdout, execBehavior) {
  const exec = async (_cmd) => {
    if (execBehavior === "timeout") {
      const err = new Error("Command timed out");
      err.signal = "SIGTERM";
      throw err;
    }
    if (execBehavior === "error") {
      throw new Error("PowerShell não disponível");
    }
    return { stdout, stderr: "" };
  };
  return new AcpiProvider(exec);
}

describe("orchestration-acpi-honesty — AcpiProvider não false-proof", () => {
  it(" ACPI ThermalZone NÃO populate cpuPackageC; va para motherboard[]", async () => {
    // raw ACPI 3543 decikelvin → 81.15 → 81 C
    const provider = mockAcpiProvider("81\n", "ok");
    const reading = await provider.read();
    assert.equal(reading.cpuPackageC, null, "ACPI ThermalZone !== CPU Package");
    assert.equal(reading.cpuCoreMaxC, null, "não há core temp via ACPI zone");
    assert.equal(reading.motherboard.length, 1, "thermal zone -> motherboard[0]");
    assert.equal(reading.motherboard[0].tempC, 81, "valor em Celsius arredondado");
    assert.match(
      reading.motherboard[0].name,
      /thermal zone|acpi|zone/i,
      "nome identifica origem (motherboard thermal zone), não afirma 'CPU'"
    );
    assert.equal(reading.source, "ACPI");
  });

  it("ACPI stdout vazio/absente → motherboard [] vazio (não inventa)", async () => {
    const provider = mockAcpiProvider("", "ok");
    const reading = await provider.read();
    assert.equal(reading.cpuPackageC, null);
    assert.equal(reading.motherboard.length, 0, "não inventa entry quando não há zona");
    assert.equal(reading.source, "ACPI");
  });

  it("PowerShell timeout → reading vazio, não throws", async () => {
    const provider = mockAcpiProvider("", "timeout");
    const reading = await provider.read();
    assert.equal(reading.cpuPackageC, null);
    assert.equal(reading.motherboard.length, 0);
    assert.equal(reading.source, "ACPI");
  });

  it("PowerShell error → reading vazio, não throws", async () => {
    const provider = mockAcpiProvider("", "error");
    const reading = await provider.read();
    assert.equal(reading.cpuPackageC, null);
    assert.equal(reading.motherboard.length, 0);
    assert.equal(reading.source, "ACPI");
  });
});
