import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeStorageHealth } from "../dist/storage-health.js";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * Correções P0 pedidas na revisão do Codex.
 *
 * P0-SMART: `available` só com um valor utilizável; `invalid` quando o disco
 * responde sem valores; suporte parcial explícito; o estado global não pode
 * esconder indisponibilidade.
 *
 * P0-TIMESTAMP: `physicalUpdatedAt` é a hora do FIM da leitura real, preservada
 * entre snapshots; expiração marcada com `physicalStale`; erro não torna dados
 * antigos recentes.
 */

const DISCO = (id, health = "Healthy", media = "SSD") => ({
  DeviceId: String(id),
  FriendlyName: `Disco ${id}`,
  MediaType: media,
  BusType: "SATA",
  Size: 500_000_000_000,
  HealthStatus: health,
  OperationalStatus: "OK",
});

const CONTADORES = (id, extra = {}) => ({
  id: String(id),
  temperature: 38,
  wear: 5,
  hours: 1200,
  readErr: 0,
  readUnc: 0,
  writeErr: 0,
  writeUnc: 0,
  ...extra,
});

const PERMISSAO = "PermissionDenied: Acesso a um recurso CIM não estava disponível para o cliente.";

describe("P0 SMART: disponibilidade dos contadores", () => {
  it("todos os contadores null → invalid, nunca available", () => {
    const s = describeStorageHealth({
      physicalDisks: [DISCO(1)],
      counters: [{ id: "1", temperature: null, wear: null, hours: null, readErr: null, readUnc: null, writeErr: null, writeUnc: null }],
    });
    assert.equal(s.status, "invalid");
    assert.equal(s.disks[0].countersStatus, "invalid");
    assert.match(s.detail, /nenhum disco devolveu um valor utilizável/i);
  });

  it("contadores todos inválidos (fora de intervalo) → invalid", () => {
    const s = describeStorageHealth({
      physicalDisks: [DISCO(1)],
      counters: [CONTADORES(1, { temperature: 999, wear: 150, hours: -2, readErr: -1, readUnc: 1.5, writeErr: 1.5, writeUnc: -1 })],
    });
    assert.equal(s.status, "invalid");
    assert.equal(s.disks[0].temperatureC, null, "null, nunca 0");
    assert.equal(s.disks[0].wearPercent, null, "não se mostra 0% de desgaste sem leitura");
  });

  it("um contador válido chega para o disco ser available", () => {
    const s = describeStorageHealth({
      physicalDisks: [DISCO(1)],
      counters: [CONTADORES(1, { temperature: null, wear: 7, hours: null, readErr: null, readUnc: null, writeErr: null, writeUnc: null })],
    });
    assert.equal(s.status, "available");
    assert.equal(s.disks[0].countersStatus, "available");
    assert.equal(s.disks[0].wearPercent, 7);
    assert.equal(s.disks[0].temperatureC, null);
  });

  it("todos os discos sem contadores → unsupported, nunca available", () => {
    const s = describeStorageHealth({ physicalDisks: [DISCO(1), DISCO(2)] });
    assert.equal(s.status, "unsupported");
    assert.equal(s.disks.every((d) => d.countersStatus === "unsupported"), true);
    assert.match(s.detail, /Nenhum disco expôs contadores/);
  });

  it("permissão negada tem precedência e estado próprio", () => {
    const s = describeStorageHealth({ physicalDisks: [DISCO(1)], countersError: PERMISSAO });
    assert.equal(s.status, "denied");
    assert.equal(s.disks[0].countersStatus, "denied");
    assert.equal(s.disks[0].temperatureC, null);
  });

  it("suporte parcial: um disco com contadores e outro sem → partial explícito", () => {
    const s = describeStorageHealth({
      physicalDisks: [DISCO(1), DISCO(2)],
      counters: [CONTADORES(1)],
    });
    assert.equal(s.status, "partial");
    assert.match(s.detail, /1 de 2 discos/);
    assert.equal(s.disks.find((d) => d.deviceId === "1").countersStatus, "available");
    assert.equal(s.disks.find((d) => d.deviceId === "2").countersStatus, "unsupported");
  });

  it("falha de leitura (não permissão) → unavailable", () => {
    const s = describeStorageHealth({
      physicalDisks: [DISCO(1)],
      countersError: "O serviço de armazenamento não respondeu a tempo.",
    });
    assert.equal(s.status, "unavailable");
    assert.equal(s.disks[0].countersStatus, "unavailable");
  });

  it("disco Healthy mas sem contadores NÃO é SMART validado", () => {
    const s = describeStorageHealth({ physicalDisks: [DISCO(1, "Healthy")] });
    assert.equal(s.disks[0].healthStatus, "healthy");
    assert.equal(s.disks[0].countersStatus, "unsupported");
    assert.equal(s.status, "unsupported", "Healthy do Windows não prova atributos SMART");
    assert.equal(s.disks[0].temperatureC, null);
  });

  it("mistura de válido, inválido e sem suporte resume-se em partial", () => {
    const s = describeStorageHealth({
      physicalDisks: [DISCO(1), DISCO(2), DISCO(3)],
      counters: [
        CONTADORES(1),
        { id: "2", temperature: null, wear: null, hours: null, readErr: null, readUnc: null, writeErr: null, writeUnc: null },
      ],
    });
    assert.equal(s.status, "partial");
    assert.match(s.detail, /1 de 3 discos/);
    assert.equal(s.disks.find((d) => d.deviceId === "2").countersStatus, "invalid");
    assert.equal(s.disks.find((d) => d.deviceId === "3").countersStatus, "unsupported");
  });
});

describe("P0 timestamp: hora da leitura, não do snapshot", () => {
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

  const boa = () => describeStorageHealth({ physicalDisks: [DISCO(1)], countersError: PERMISSAO });

  it("dois snapshots consecutivos sem nova leitura preservam o mesmo timestamp", async () => {
    const e = new SeamEngine();
    const at = new Date(Date.now() - 5_000).toISOString();
    e.storageHealth = { result: boa(), at };

    const a = await e.getSnapshot([]);
    const b = await e.getSnapshot([]);
    assert.equal(a.disk.physicalUpdatedAt, at);
    assert.equal(b.disk.physicalUpdatedAt, at, "getSnapshot não pode fabricar uma medição");
    assert.equal(a.disk.physicalStale, false);
  });

  it("uma nova leitura válida actualiza o timestamp", async () => {
    const e = new SeamEngine();
    const primeiro = new Date(Date.now() - 30_000).toISOString();
    e.storageHealth = { result: boa(), at: primeiro };
    const antes = await e.getSnapshot([]);

    const segundo = new Date().toISOString();
    e.storageHealth = { result: boa(), at: segundo };
    const depois = await e.getSnapshot([]);

    assert.equal(antes.disk.physicalUpdatedAt, primeiro);
    assert.equal(depois.disk.physicalUpdatedAt, segundo);
    assert.notEqual(antes.disk.physicalUpdatedAt, depois.disk.physicalUpdatedAt);
  });

  it("dados expirados são marcados e o último valor válido é preservado", async () => {
    const e = new SeamEngine();
    e.storageHealth = {
      result: boa(),
      at: new Date(Date.now() - 91_000).toISOString(),
    };
    const s = await e.getSnapshot([]);
    assert.equal(s.disk.physicalStale, true);
    assert.equal(s.disk.physical.length, 1, "não se apaga o último valor sem regra explícita");
    assert.ok(s.disk.physicalUpdatedAt, "a hora da última leitura continua visível");
  });

  it("erro na actualização não faz dados antigos parecerem recentes", async () => {
    const e = new SeamEngine();
    const antigo = new Date(Date.now() - 120_000).toISOString();
    e.storageHealth = { result: boa(), at: antigo };
    e.storageHealthError = {
      detail: "O serviço de armazenamento não respondeu.",
      at: new Date().toISOString(),
    };

    const s = await e.getSnapshot([]);
    assert.equal(s.disk.physicalUpdatedAt, antigo, "a hora é da última leitura BOA");
    assert.equal(s.disk.physicalStale, true);
    assert.match(s.disk.physicalErrorDetail, /não respondeu/);
    assert.equal(s.disk.physical.length, 1);
  });

  it("sem qualquer leitura boa, o erro é publicado sem timestamp de medição", async () => {
    const e = new SeamEngine();
    e.storageHealthError = {
      detail: "O Windows não devolveu nenhum disco físico.",
      at: new Date().toISOString(),
    };
    const s = await e.getSnapshot([]);
    assert.equal(s.disk.physicalStatus, "unavailable");
    assert.equal(s.disk.physicalUpdatedAt, undefined);
    assert.equal(s.disk.physical.length, 0);
    assert.match(s.disk.physicalDetail, /nenhum disco/i);
  });
});
