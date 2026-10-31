import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCountersError,
  describeStorageHealth,
  mediaTypeOf,
  parseJsonOutput,
  readStorageHealth,
} from "../dist/storage-health.js";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * FASE 2 — saúde FÍSICA do armazenamento.
 *
 * As formas dos dados usadas aqui foram copiadas das respostas REAIS do
 * Windows nesta máquina:
 *   Get-PhysicalDisk → [{DeviceId,FriendlyName,MediaType,BusType,Size,HealthStatus,OperationalStatus}]
 *   Get-StorageReliabilityCounter (sem elevação) → PermissionDenied
 * Nenhum teste executa PowerShell: o runner é injetado.
 */

// Resposta real medida (3 discos, um HDD reportado como "Unspecified").
const DISKS = [
  {
    DeviceId: "2",
    FriendlyName: "SAMSUNG MZVLB1T0HALR-00000",
    MediaType: "SSD",
    BusType: "NVMe",
    Size: 1024209543168,
    HealthStatus: "Healthy",
    OperationalStatus: "OK",
  },
  {
    DeviceId: "1",
    FriendlyName: "S3SSDC512",
    MediaType: "SSD",
    BusType: "SATA",
    Size: 512110190592,
    HealthStatus: "Healthy",
    OperationalStatus: "OK",
  },
  {
    DeviceId: "0",
    FriendlyName: "SAMSUNG HD642JJ",
    MediaType: "Unspecified",
    BusType: "SATA",
    Size: 640135028736,
    HealthStatus: "Healthy",
    OperationalStatus: "OK",
  },
];

const PERMISSAO =
  "Get-StorageReliabilityCounter : Acesso a um recurso CIM não estava disponível para o cliente.\r\n" +
  "+ CategoryInfo          : PermissionDenied: (PS_StorageCmdlets:ROOT/Microsoft/...)";

describe("Armazenamento: saúde física dos discos", () => {
  it("sem elevação → estado denied explicado, contadores null (nunca 0)", () => {
    const s = describeStorageHealth({ physicalDisks: DISKS, countersError: PERMISSAO });
    assert.equal(s.status, "denied");
    assert.match(s.detail, /elevação/);
    assert.equal(s.disks.length, 3);
    for (const d of s.disks) {
      assert.equal(d.countersStatus, "denied");
      assert.equal(d.temperatureC, null);
      assert.equal(d.wearPercent, null);
      assert.equal(d.powerOnHours, null);
      assert.equal(d.readErrorsTotal, null);
    }
  });

  it("identidade dos discos é preservada mesmo sem contadores", () => {
    const s = describeStorageHealth({ physicalDisks: DISKS, countersError: PERMISSAO });
    const nvme = s.disks.find((d) => d.deviceId === "2");
    assert.equal(nvme.model, "SAMSUNG MZVLB1T0HALR-00000");
    assert.equal(nvme.mediaType, "ssd");
    assert.equal(nvme.busType, "NVMe");
    assert.equal(nvme.sizeGb, 953.9);
    assert.equal(nvme.healthStatus, "healthy");
  });

  it("HDD reportado como \"Unspecified\" fica unknown — não se adivinha o tipo", () => {
    const s = describeStorageHealth({ physicalDisks: DISKS, countersError: PERMISSAO });
    assert.equal(s.disks.find((d) => d.deviceId === "0").mediaType, "unknown");
  });

  it("contadores disponíveis → valores reais; inválidos ficam null", () => {
    const s = describeStorageHealth({
      physicalDisks: DISKS,
      counters: [
        {
          id: "2",
          temperature: 41,
          wear: 7,
          hours: 12345,
          readErr: 0,
          readUnc: 0,
          writeErr: 2,
          writeUnc: 0,
        },
      ],
    });
    const nvme = s.disks.find((d) => d.deviceId === "2");
    assert.equal(nvme.countersStatus, "available");
    assert.equal(nvme.temperatureC, 41);
    assert.equal(nvme.wearPercent, 7);
    assert.equal(nvme.powerOnHours, 12345);
    assert.equal(nvme.writeErrorsTotal, 2);
    // Sem contador para este disco: é "não expôs", não 0.
    const outro = s.disks.find((d) => d.deviceId === "1");
    assert.equal(outro.countersStatus, "unsupported");
    assert.equal(outro.temperatureC, null);
    assert.equal(s.status, "partial", "1 disco com contadores e 2 sem suporte não é disponibilidade total");
  });

  it("valores impossíveis são rejeitados em vez de publicados", () => {
    const s = describeStorageHealth({
      physicalDisks: [DISKS[0]],
      counters: [
        {
          id: "2",
          temperature: 999,
          wear: 150,
          hours: -1,
          readErr: -5,
          readUnc: 1.5,
          writeErr: "abc",
          writeUnc: null,
        },
      ],
    });
    const d = s.disks[0];
    assert.equal(d.temperatureC, null);
    assert.equal(d.wearPercent, null);
    assert.equal(d.powerOnHours, null);
    assert.equal(d.readErrorsTotal, null);
    assert.equal(d.readErrorsUncorrected, null);
    assert.equal(d.writeErrorsTotal, null);
    assert.equal(
      d.countersStatus,
      "invalid",
      "nenhum valor utilizável: não pode ser apresentado como available",
    );
  });

  it("um único disco devolvido como objecto (não array) é aceite", () => {
    const s = describeStorageHealth({ physicalDisks: DISKS[0], countersError: PERMISSAO });
    assert.equal(s.disks.length, 1);
  });

  it("sem discos → unavailable com motivo, sem lista falsa", () => {
    const s = describeStorageHealth({ physicalDisks: null });
    assert.equal(s.status, "unavailable");
    assert.equal(s.disks.length, 0);
    assert.match(s.detail, /nenhum disco/i);
  });

  it("disco sem DeviceId é ignorado (não é acompanhável)", () => {
    const s = describeStorageHealth({ physicalDisks: [{ FriendlyName: "x" }] });
    assert.equal(s.disks.length, 0);
    assert.equal(s.status, "unavailable");
  });

  it("HealthStatus é mapeado sem otimismo", () => {
    const mk = (h) => ({ ...DISKS[0], HealthStatus: h });
    assert.equal(describeStorageHealth({ physicalDisks: [mk("Healthy")] }).disks[0].healthStatus, "healthy");
    assert.equal(describeStorageHealth({ physicalDisks: [mk("Warning")] }).disks[0].healthStatus, "warning");
    assert.equal(describeStorageHealth({ physicalDisks: [mk("Unhealthy")] }).disks[0].healthStatus, "unhealthy");
    assert.equal(describeStorageHealth({ physicalDisks: [mk("??")] }).disks[0].healthStatus, "unknown");
  });

  it("classificação de erros distingue permissão de comando ausente", () => {
    assert.equal(classifyCountersError(PERMISSAO).status, "denied");
    assert.equal(classifyCountersError("O termo 'Get-PhysicalDisk' não é reconhecido").status, "unsupported");
    assert.equal(classifyCountersError("timeout").status, "unavailable");
    assert.equal(classifyCountersError(null).status, "unavailable");
  });

  it("parseJsonOutput sobrevive a BOM, vazio e lixo", () => {
    assert.deepEqual(parseJsonOutput("\uFEFF[1]"), [1]);
    assert.equal(parseJsonOutput(""), null);
    assert.equal(parseJsonOutput("   "), null);
    assert.equal(parseJsonOutput("não é json"), null);
    assert.equal(parseJsonOutput(null), null);
  });

  it("mediaTypeOf não inventa", () => {
    assert.equal(mediaTypeOf("SSD"), "ssd");
    assert.equal(mediaTypeOf("HDD"), "hdd");
    assert.equal(mediaTypeOf("Unspecified"), "unknown");
    assert.equal(mediaTypeOf(undefined), "unknown");
  });

  it("readStorageHealth com runner injetado: permissão nos contadores → denied", async () => {
    const calls = [];
    const run = async (script) => {
      calls.push(script);
      if (script.includes("Get-StorageReliabilityCounter")) return { stdout: "", error: PERMISSAO };
      return { stdout: JSON.stringify(DISKS), error: null };
    };
    const s = await readStorageHealth(run);
    assert.equal(calls.length, 2, "uma leitura de discos + uma de contadores");
    assert.equal(s.status, "denied");
    assert.equal(s.disks.length, 3);
  });

  it("readStorageHealth: falha total na leitura de discos → unavailable com motivo", async () => {
    const run = async () => ({ stdout: "", error: "O serviço de armazenamento não respondeu." });
    const s = await readStorageHealth(run);
    assert.equal(s.status, "unavailable");
    assert.equal(s.disks.length, 0);
    assert.match(s.detail, /armazenamento/);
  });
});

describe("Snapshot: saúde física anexada ao disco", () => {
  class SeamEngine extends HardwareHealthEngine {
    constructor() {
      super();
      this.initialized = true;
      this.diskReadAttempted = true;
      this.diskSnapshot = initialDiskSnapshot();
      this.lastFastTick = Date.now();
      this.lastMediumTick = Date.now();
      this.lastSlowTick = Date.now();
    }
  }

  it("sem leitura de saúde, o snapshot não afirma nada sobre saúde física", async () => {
    const e = new SeamEngine();
    const s = await e.getSnapshot([]);
    assert.equal(s.disk.physical, undefined);
    assert.equal(s.disk.physicalStatus, undefined);
    assert.equal(s.disk.readStatus, "unavailable", "a ocupação continua com o estado dela");
  });

  it("com leitura, os discos e o motivo são publicados", async () => {
    const e = new SeamEngine();
    e.storageHealth = {
      result: describeStorageHealth({ physicalDisks: DISKS, countersError: PERMISSAO }),
      at: new Date().toISOString(),
    };
    const s = await e.getSnapshot([]);
    assert.equal(s.disk.physical.length, 3);
    assert.equal(s.disk.physicalStatus, "denied");
    assert.match(s.disk.physicalDetail, /elevação/);
    assert.ok(Number.isFinite(Date.parse(s.disk.physicalUpdatedAt)));
  });

  it("a saúde física não altera a ocupação publicada", async () => {
    const e = new SeamEngine();
    e.storageHealth = {
      result: describeStorageHealth({ physicalDisks: DISKS, countersError: PERMISSAO }),
      at: new Date().toISOString(),
    };
    const s = await e.getSnapshot([]);
    assert.equal(s.disk.usagePercent, null, "sem leitura de volumes não há percentagem");
    assert.equal(s.disk.volumes.length, 0);
  });
});
