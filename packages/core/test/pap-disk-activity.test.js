import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diskActivityReadings } from "../dist/hardware-normalize.js";
import { PdhDiskProbe } from "../dist/win-pdh.js";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * TP-PAP-DISK-ACTIVITY — atividade de disco medida por PDH.
 *
 * A regra que este ficheiro protege é uma só, em três camadas: **um número que
 * não foi medido não pode chegar ao ecrã como 0 B/s**. É o caso concreto do
 * primeiro poll de uma query PDH recém-aberta (ainda não existe intervalo entre
 * dois `PdhCollectQueryData`, logo não há taxa) e é exatamente o género de
 * falsos "discos calmos" que o objetivo proíbe.
 *
 * Nada aqui toca em hardware nem abre DLL: o probe recebe `bindings` falsos e o
 * engine recebe o seam `pollDiskActivity` sobreposto.
 */

const amostra = (overrides = {}) => ({
  counter: "\\\\LogicalDisk(C:)\\\\Disk Read Bytes/sec",
  cStatus: 0,
  value: null,
  measured: false,
  ...overrides,
});

const volume = (instance, valores = {}) => ({
  instance,
  readBytesPerSec: amostra(valores.lidos),
  writeBytesPerSec: amostra(valores.escritos),
  readsPerSec: amostra(valores.operacoesLeitura),
  writesPerSec: amostra(valores.operacoesEscrita),
  idlePercent: amostra(valores.idle),
});

describe("diskActivityReadings", () => {
  it("primeira amostra sem intervalo: unavailable com valores a null, nunca 0", () => {
    const [reading] = diskActivityReadings([volume("_Total")]);
    assert.equal(reading.status, "unavailable");
    assert.equal(reading.readBytesPerSec, null);
    assert.equal(reading.writeBytesPerSec, null);
    assert.equal(reading.idlePercent, null);
    assert.equal(reading.updatedAt, undefined, "sem medição não há timestamp");
  });

  it("medição publicada com montante, fonte e 0 legítimo preservado", () => {
    const [reading] = diskActivityReadings([
      volume("C:", { lidos: { measured: true, value: 0 }, escritos: { measured: true, value: 1_048_576.4 }, idle: { measured: true, value: 42.5 } }),
    ]);
    assert.equal(reading.mount, "C:");
    assert.equal(reading.status, "available");
    assert.equal(reading.readBytesPerSec, 0, "0 B/s medido é um número, não ausência");
    assert.equal(reading.writeBytesPerSec, 1_048_576, "arredondado, sem unidades inventadas");
    assert.equal(reading.idlePercent, 42.5);
    assert.match(reading.source, /PDH LogicalDisk\(C:\)/);
    assert.ok(reading.updatedAt);
  });

  it("_Total é agregado: mount null, para não ser mostrado como um volume", () => {
    const [reading] = diskActivityReadings([volume("_Total", { lidos: { measured: true, value: 10 } })]);
    assert.equal(reading.mount, null);
    assert.equal(reading.status, "available");
  });

  it("fonte não identificável nunca é inventada: device permanece null", () => {
    const [reading] = diskActivityReadings([volume("C:", { lidos: { measured: true, value: 10 } })]);
    assert.equal(reading.device, null, "LogicalDisk não diz a que PHYSICALDRIVE pertence");
  });

  it("valores impossíveis são rejeitados, não absolvidos", () => {
    const negativos = diskActivityReadings([volume("C:", { lidos: { measured: true, value: -5 } })])[0];
    assert.equal(negativos.readBytesPerSec, null, "taxa negativa é erro de fonte");
    assert.equal(negativos.status, "unavailable", "e um erro não publica a tabela como medida");

    const nan = diskActivityReadings([volume("C:", { lidos: { measured: true, value: Number.NaN } })])[0];
    assert.equal(nan.readBytesPerSec, null);

    const idleFora = diskActivityReadings([
      volume("C:", { lidos: { measured: true, value: 1 }, idle: { measured: true, value: 130 } }),
    ])[0];
    assert.equal(idleFora.idlePercent, null, "130% de idle não é uma percentagem");
    assert.equal(idleFora.status, "available", "e não apaga as taxas que foram medidas");
  });

  it("amostra malformada ou ausente devolve tabela vazia", () => {
    assert.deepEqual(diskActivityReadings(null), []);
    assert.deepEqual(diskActivityReadings(undefined), []);
  });
});

describe("PdhDiskProbe com bindings falsos", () => {
  /** Finge a DLL: conta chamadas e devolve handles determinísticos. */
  function fakeBindings({ falharContador = null, collectCode = 0, valores = { cStatus: 0, value: 123 } } = {}) {
    const chamadas = { open: 0, add: 0, collect: 0, read: 0, close: 0 };
    let seq = 1n;
    const paths = [];
    const bindings = {
      openQuery() {
        chamadas.open++;
        return 42n;
      },
      addEnglishCounter(query, path) {
        chamadas.add++;
        paths.push(path);
        if (falharContador && path.includes(falharContador)) return null;
        seq += 1n;
        return seq;
      },
      collect() {
        chamadas.collect++;
        return collectCode;
      },
      formattedDouble() {
        chamadas.read++;
        return valores;
      },
      closeQuery() {
        chamadas.close++;
      },
    };
    return { bindings, chamadas, paths };
  }

  it("adiciona os cinco contadores por instância e lê taxas verdadeiras", () => {
    const fake = fakeBindings();
    const probe = new PdhDiskProbe({ bindings: fake.bindings });
    const resultado = probe.poll(["C:", "_Total"]);
    assert.equal(resultado.status, "ok");
    assert.equal(fake.chamadas.open, 1, "uma única query para todo o ciclo de vida");
    assert.equal(fake.chamadas.add, 10, "5 contadores × 2 instâncias");
    assert.equal(resultado.value.length, 2);
    assert.equal(resultado.value[0].readBytesPerSec.measured, true);
    assert.equal(resultado.value[0].readBytesPerSec.value, 123);
    probe.close();
    assert.equal(fake.chamadas.close, 1, "o handle nativo é libertado explicitamente");
  });

  it("instância com um contador a faltar fica de fora: metade não é uma leitura", () => {
    const fake = fakeBindings({ falharContador: "% Idle Time" });
    const probe = new PdhDiskProbe({ bindings: fake.bindings });
    const resultado = probe.poll(["C:", "_Total"]);
    assert.equal(resultado.status, "unavailable");
    assert.match(resultado.reason, /nenhum contador LogicalDisk disponível/);
  });

  it("lista vazia diz que nada foi pedido, e não que os contadores faltam", () => {
    // Causas diferentes, soluções diferentes: «ainda não há volumes lidos»
    // resolve-se no próximo tick; «LogicalDisk inacessível» é da máquina.
    // Comprovado em máquina real: a mesma DLL aceita ["C:","_Total"] e devolve
    // taxas medidas, mas com a lista vazia caía no motivo de baixo.
    const fake = fakeBindings();
    const probe = new PdhDiskProbe({ bindings: fake.bindings });
    const resultado = probe.poll([]);
    assert.equal(resultado.status, "unavailable");
    assert.match(resultado.reason, /nenhuma instância de disco pedida/);
    assert.doesNotMatch(resultado.reason, /nenhum contador/);
    assert.equal(fake.chamadas.add, 0, "sem instância não se toca na DLL");
  });

  it("o segundo poll usa a MESMA query e passa a ler a taxa", () => {
    const fake = fakeBindings();
    const probe = new PdhDiskProbe({ bindings: fake.bindings });
    probe.poll(["C:"]);
    const segundo = probe.poll(["C:"]);
    assert.equal(segundo.status, "ok");
    assert.equal(fake.chamadas.open, 1, "a query sobrevive entre ticks — é o que dá intervalo às taxas");
    assert.equal(fake.chamadas.add, 5, "os contadores não são re-adicionados por poll");
    assert.equal(fake.chamadas.collect, 2);
  });

  it("instância retirada deixa de ser lida (volume desmontado)", () => {
    const fake = fakeBindings();
    const probe = new PdhDiskProbe({ bindings: fake.bindings });
    probe.poll(["C:", "D:"]);
    const depois = probe.poll(["C:"]);
    assert.equal(depois.value.length, 1);
    assert.equal(depois.value[0].instance, "C:");
  });

  it("collect com código de erro devolve indisponível com o código, sem inventar", () => {
    const fake = fakeBindings({ collectCode: 0xc0000008 });
    const probe = new PdhDiskProbe({ bindings: fake.bindings });
    const resultado = probe.poll(["C:"]);
    assert.equal(resultado.status, "unavailable");
    assert.match(resultado.reason, /PdhCollectQueryData 0xC0000008/);
  });

  it("estado de dados inválido na amostra não é medido", () => {
    const fake = fakeBindings({ valores: { cStatus: 0x800007d5, value: 0 } });
    const probe = new PdhDiskProbe({ bindings: fake.bindings });
    const resultado = probe.poll(["C:"]);
    const amostraLida = resultado.value[0].readBytesPerSec;
    assert.equal(amostraLida.measured, false, "cStatus que não é VALID/NEW não é medição");
    assert.equal(amostraLida.value, null, "e o número que a API pôs no buffer não sai");
  });
});

/** Engine com a sondagem PDH sobreposta: nem uma DLL nem um volume real. */
class SeamEngine extends HardwareHealthEngine {
  constructor() {
    super();
    this.initialized = true;
    this.diskReadAttempted = true;
    this.diskSnapshot = { ...initialDiskSnapshot(), volumes: [{ mount: "C:", fileSystem: "NTFS", totalGb: 500, usedGb: 300, freeGb: 200, usagePercent: 60, kind: "system", readOnly: false }] };
    this.lastMediumTick = Date.now();
    this.lastFastTick = Date.now();
    this.polls = [];
    this.proximo = { status: "unavailable", reason: "sandbox" };
  }

  pollDiskActivity(instances) {
    this.polls.push(instances);
    return this.proximo;
  }

  async readNetworkStats() {
    return null;
  }
}

describe("engine publica atividade de disco", () => {
  it("PDH indisponível: tabela vazia com estado e motivo, campos de ocupação intactos", async () => {
    const e = new SeamEngine();
    e.lastMediumTick = 0;
    const snap = await e.getSnapshot([]);
    assert.equal(e.polls.length, 1, "uma sondagem por tick médio");
    assert.deepEqual(snap.disk.activity, []);
    assert.equal(snap.disk.activityStatus, "unavailable");
    assert.equal(snap.disk.activityDetail, "sandbox");
    assert.equal(snap.disk.volumes.length, 1, "a atividade não apaga os volumes lidos");
    assert.equal(snap.disk.volumes[0].usagePercent, 60, "nem altera a ocupação de cada um");
  });

  it("as instâncias pedidas vêm dos volumes já lidos, mais o agregado", async () => {
    const e = new SeamEngine();
    e.lastMediumTick = 0;
    await e.getSnapshot([]);
    assert.deepEqual(e.polls[0], ["C:", "_Total"]);
  });

  it("medição publicada por volume com unidades de bytes por segundo", async () => {
    const e = new SeamEngine();
    e.proximo = {
      status: "ok",
      value: [volume("C:", { lidos: { measured: true, value: 22_526_987 }, escritos: { measured: true, value: 54_496_304 } })],
    };
    e.lastMediumTick = 0;
    const snap = await e.getSnapshot([]);
    assert.equal(snap.disk.activityStatus, "available");
    const [leitura] = snap.disk.activity;
    assert.equal(leitura.mount, "C:");
    assert.equal(leitura.readBytesPerSec, 22_526_987);
    assert.equal(leitura.writeBytesPerSec, 54_496_304);
    assert.equal(leitura.status, "available");
  });

  it("tabela antiga não é republicada como se fosse atual", async () => {
    const e = new SeamEngine();
    e.proximo = { status: "ok", value: [volume("C:", { lidos: { measured: true, value: 10 } })] };
    e.lastMediumTick = 0;
    await e.getSnapshot([]);
    e.proximo = { status: "unavailable", reason: "ffi-indisponivel" };
    e.lastMediumTick = 0;
    const snap = await e.getSnapshot([]);
    assert.deepEqual(snap.disk.activity, [], "sem medição nova não há tabela");
    assert.equal(snap.disk.activityStatus, "unavailable");
  });
});
