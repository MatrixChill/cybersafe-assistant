import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateDiskHealth,
  diskHealthLabel,
  diskHealthDetail,
  parseReliabilityCounterOutput,
  DISK_HEALTH_THRESHOLDS,
  type DiskHealthReading,
} from "../src/lib/diskHealth";

describe("R3-B2 T3 P1 — saúde do disco (SMART/NVMe, read-only)", () => {

  describe("evaluateDiskHealth — nunca inventa", () => {
    test("sem nenhum contador real → unavailable", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: null,
        wearPercent: null,
        hoursUsed: null,
        reallocatedSectorCount: null,
        errorCount: null,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "unavailable");
    });

    test("1 contador → healthy (abaixo de tudo)", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: 35,
        wearPercent: null,
        hoursUsed: null,
        reallocatedSectorCount: null,
        errorCount: null,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "healthy");
    });

    test("temperatura crítica (≥ 70°C) → critical", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: 70,
        wearPercent: null,
        hoursUsed: 5000,
        reallocatedSectorCount: null,
        errorCount: 0,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "critical");
    });

    test("wear crítico (≥ 90%) → critical", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: 40,
        wearPercent: 91,
        hoursUsed: null,
        reallocatedSectorCount: null,
        errorCount: null,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "critical");
    });

    test("reallocated sectors crítico (≥ 10) → critical", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: null,
        wearPercent: null,
        hoursUsed: null,
        reallocatedSectorCount: 10,
        errorCount: 0,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "critical");
    });

    test("temperatura warning (55-69°C) → warning", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: 60,
        wearPercent: null,
        hoursUsed: null,
        reallocatedSectorCount: null,
        errorCount: null,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "warning");
    });

    test("wear warning (80-89%) → warning", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: null,
        wearPercent: 85,
        hoursUsed: null,
        reallocatedSectorCount: null,
        errorCount: null,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "warning");
    });

    test("HDD sem wear (wearPercent=null) mas hoursUsed → healthy", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: 38,
        wearPercent: null,
        hoursUsed: 8760,
        reallocatedSectorCount: 0,
        errorCount: 0,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "healthy");
      assert.equal(r.wearPercent, null, "HDD não tem wear — nunca inventado");
    });

    test("temperatura baixa + reallocated sectors warning → warning (OR)", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: 38,
        wearPercent: null,
        hoursUsed: null,
        reallocatedSectorCount: 1,
        errorCount: 0,
        reason: null,
      };
      assert.equal(evaluateDiskHealth(r), "warning");
    });
  });

  describe("diskHealthLabel — PT-PT", () => {
    test("healthy → 'Saudável'", () => {
      assert.equal(diskHealthLabel("healthy"), "Saudável");
    });
    test("warning → 'Atenção'", () => {
      assert.equal(diskHealthLabel("warning"), "Atenção");
    });
    test("critical → 'Crítico'", () => {
      assert.equal(diskHealthLabel("critical"), "Crítico");
    });
    test("unavailable → 'Indisponível'", () => {
      assert.equal(diskHealthLabel("unavailable"), "Indisponível");
    });
  });

  describe("diskHealthDetail — nunca fabrica", () => {
    test("unavailable mostra o motivo", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: null,
        wearPercent: null,
        hoursUsed: null,
        reallocatedSectorCount: null,
        errorCount: null,
        reason: "Get-PhysicalDisk precisa de elevação ( administrador ).",
      };
      assert.equal(diskHealthDetail(r), "Get-PhysicalDisk precisa de elevação ( administrador ).");
    });

    test("unavailable sem motivo usa fallback honesto", () => {
      const r: DiskHealthReading = {
        status: "unavailable",
        temperatureC: null,
        wearPercent: null,
        hoursUsed: null,
        reallocatedSectorCount: null,
        errorCount: null,
        reason: null,
      };
      assert.equal(
        diskHealthDetail(r),
        "SMART/NVMe não disponível neste disco ou sem privilégios de administrador.",
      );
    });

    test("todos os contadores reais são listados", () => {
      const r: DiskHealthReading = {
        status: "healthy",
        temperatureC: 42,
        wearPercent: 12.5,
        hoursUsed: 3200,
        reallocatedSectorCount: 0,
        errorCount: 2,
        reason: null,
      };
      const detail = diskHealthDetail(r);
      assert.match(detail, /Temperatura: 42 °C/);
      assert.match(detail, /Desgaste: 12,5%/);
      assert.match(detail, /Horas: 3200/);
      assert.match(detail, /Setores remapeados: 0/);
      assert.match(detail, /Erros: 2/);
    });

    test("nulls são omitidos (não aparecem como 'null' ou 'NaN')", () => {
      const r: DiskHealthReading = {
        status: "healthy",
        temperatureC: 42,
        wearPercent: null,
        hoursUsed: null,
        reallocatedSectorCount: null,
        errorCount: null,
        reason: null,
      };
      const detail = diskHealthDetail(r);
      assert.equal(detail, "Temperatura: 42 °C");
      assert.equal(detail.includes("null"), false);
      assert.equal(detail.includes("NaN"), false);
    });
  });

  describe("parseReliabilityCounterOutput — parser puro", () => {
    test("JSON válido com contadores → reading com valores reais", () => {
      const json = JSON.stringify([
        {
          FriendlyName: "Samsung SSD 870",
          MediaType: "SSD",
          Temperature: 45,
          WearPercentage: 12,
          PowerOnHours: 5000,
          ReallocatedSectorCount: 0,
          CorrectableErrorCount: 1,
        },
      ]);
      const r = parseReliabilityCounterOutput(json);
      assert.equal(r.status, "healthy");
      assert.equal(r.temperatureC, 45);
      assert.equal(r.wearPercent, 12);
      assert.equal(r.hoursUsed, 5000);
      assert.equal(r.reallocatedSectorCount, 0);
      assert.equal(r.errorCount, 1);
    });

    test("string vazia → unavailable", () => {
      const r = parseReliabilityCounterOutput("");
      assert.equal(r.status, "unavailable");
      assert.ok(r.reason?.includes("nenhum"), "motivo deve mencionar nada encontrado");
    });

    test("null → unavailable", () => {
      const r = parseReliabilityCounterOutput(null);
      assert.equal(r.status, "unavailable");
    });

    test("JSON inválido → unavailable com motivo", () => {
      const r = parseReliabilityCounterOutput("not json at all");
      assert.equal(r.status, "unavailable");
      assert.ok(r.reason?.includes("JSON"), "motivo deve mencionar JSON");
    });

    test("array vazio → unavailable", () => {
      const r = parseReliabilityCounterOutput("[]");
      assert.equal(r.status, "unavailable");
    });

    test("HDD sem WearPercentage → wearPercent null", () => {
      const json = JSON.stringify([
        {
          FriendlyName: "WDC WD10EZ",
          MediaType: "HDD",
          Temperature: 38,
        },
      ]);
      const r = parseReliabilityCounterOutput(json);
      assert.equal(r.wearPercent, null, "HDD não reporta wear — null não 0");
    });
  });

  describe("DISC HEALTH_THRESHOLDS são constantes públicas", () => {
    test("thresholds são números finitos", () => {
      assert.ok(Number.isFinite(DISK_HEALTH_THRESHOLDS.temperatureWarning));
      assert.ok(Number.isFinite(DISK_HEALTH_THRESHOLDS.temperatureCritical));
      assert.ok(Number.isFinite(DISK_HEALTH_THRESHOLDS.wearCritical));
      assert.ok(Number.isFinite(DISK_HEALTH_THRESHOLDS.reallocatedCritical));
    });
  });
});
