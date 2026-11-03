import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiskSnapshot,
  describeDiskRead,
  initialDiskSnapshot,
  pickPrimaryVolume,
  worstWorkingVolume,
  DISK_STALE_TTL_MS,
} from "../dist/index.js";

/**
 * ARMAZENAMENTO — as regras que impedem o ecrã de mentir.
 *
 * Contexto (auditoria 2026-10-09): uma leitura falhada era escrita como 0 e o
 * PC Center mostrava "0,0%" e "0,0 / 0,0 GB" como se fossem medições, enquanto o
 * Dashboard dizia "sem leitura do volume" — os dois ao mesmo tempo. Estes testes
 * fixam o contrato: `null` (nunca 0) sem leitura, motivo sempre presente, último
 * valor bom retido dentro do TTL, e partição reservada que não conta como disco
 * de trabalho.
 */

const GB = 1024 ** 3;

/** Entrada como `si.fsSize()` a devolve (bytes). */
const fsEntry = (mount, { totalGb, usedGb, type = "NTFS", rw = true } = {}) => ({
  mount,
  type,
  size: Math.round(totalGb * GB),
  used: Math.round(usedGb * GB),
  available: Math.round((totalGb - usedGb) * GB),
  rw,
});

const machineVolumes = () => [
  fsEntry("C:", { totalGb: 952.9, usedGb: 846.1 }),
  fsEntry("D:", { totalGb: 0.05, usedGb: 0.03 }), // "Reservado pelo Sistema"
  fsEntry("E:", { totalGb: 595.6, usedGb: 0.5 }),
  fsEntry("F:", { totalGb: 476.1, usedGb: 284.5 }),
];

const NOW = Date.parse("2026-10-09T22:00:00.000Z");
const ISO = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

describe("armazenamento: leitura crua → volumes", () => {
  test("lê TODOS os volumes e marca a partição reservada do sistema", () => {
    const read = describeDiskRead(machineVolumes());

    assert.equal(read.ok, true);
    assert.equal(read.reason, null);
    assert.equal(read.volumes.length, 4);

    const reserved = read.volumes.filter((volume) => volume.kind === "system-reserved");
    assert.deepEqual(reserved.map((volume) => volume.mount), ["D:"]);
    assert.equal(reserved[0].totalGb < 1, true, "D: tem 0,05 GB e é reservado");

    const working = read.volumes.filter((volume) => volume.kind === "working");
    assert.deepEqual(working.map((volume) => volume.mount).sort(), ["C:", "E:", "F:"]);
  });

  test("ordena por ocupação dentro do mesmo tipo e nunca escolhe volumes[0] cego", () => {
    const read = describeDiskRead(machineVolumes());
    // C: (88,8%) à frente de F: (59,8%) e E: (0,1%); o reservado no fim.
    const mounts = read.volumes.map((volume) => volume.mount);
    assert.deepEqual(mounts, ["C:", "F:", "E:", "D:"]);
  });

  test("o volume principal é o do Windows (C:), não o mais cheio por acaso", () => {
    const volumes = describeDiskRead(machineVolumes()).volumes;
    assert.equal(pickPrimaryVolume(volumes)?.mount, "C:");
    // Sem C: na lista, cai no volume de trabalho mais cheio.
    const semC = volumes.filter((volume) => volume.mount !== "C:");
    assert.equal(pickPrimaryVolume(semC)?.mount, "F:");
    // Sem nenhum volume de trabalho (só reservados) não há principal.
    assert.equal(pickPrimaryVolume(volumes.filter((v) => v.kind === "system-reserved")), null);
  });

  test("em Linux o principal é a raiz `/`, não o volume mais cheio (era `/mnt/c`)", () => {
    // Forma medida em WSL2: uma partilha 9p do Windows a 84,6% e a raiz ext4 a
    // 1,6%. «O mais cheio» apontava o PC Center para o disco do Windows.
    const linux = describeDiskRead([
      fsEntry("/mnt/c", { totalGb: 952.9, usedGb: 806.1, type: "9p" }),
      fsEntry("/", { totalGb: 1007, usedGb: 16, type: "ext4" }),
    ]).volumes;
    assert.equal(pickPrimaryVolume(linux)?.mount, "/", "a raiz do sistema é a máquina");
    // A letra C: continua a ganhar quando existe: o caminho Windows não mudou.
    assert.equal(pickPrimaryVolume(describeDiskRead(machineVolumes()).volumes)?.mount, "C:");
    // Sem C: e sem `/`, mantém-se a queda para o mais cheio (comportamento antigo).
    const semLetraSemRaiz = describeDiskRead([
      fsEntry("E:", { totalGb: 100, usedGb: 20 }),
      fsEntry("F:", { totalGb: 100, usedGb: 90 }),
    ]).volumes;
    assert.equal(pickPrimaryVolume(semLetraSemRaiz)?.mount, "F:");
  });

  test("um volume só-leitura nunca é o «mais cheio» do aviso de espaço", () => {
    // Medido em WSL2: `/usr/lib/wsl/drivers` (9p, `ro`) era o maior «uso» da
    // máquina. O aviso diz «apague ficheiros neste volume» — num `ro` isso é
    // impossível de executar, logo é um alarme falso.
    const linux = describeDiskRead([
      fsEntry("/usr/lib/wsl/drivers", { totalGb: 953, usedGb: 916, type: "9p", rw: false }),
      fsEntry("/mnt/c", { totalGb: 953, usedGb: 600, type: "9p" }),
      fsEntry("/", { totalGb: 1007, usedGb: 16, type: "ext4" }),
    ]).volumes;
    assert.equal(linux.find((v) => v.mount === "/usr/lib/wsl/drivers").readOnly, true);
    assert.equal(worstWorkingVolume(linux)?.mount, "/mnt/c");
    // A mesma regra em forma Windows (DVD/ISO montado, partição protegida).
    const win = describeDiskRead([
      fsEntry("D:", { totalGb: 8, usedGb: 7.9, rw: false }),
      fsEntry("E:", { totalGb: 500, usedGb: 300 }),
    ]).volumes;
    assert.equal(worstWorkingVolume(win)?.mount, "E:");
    // Todos só-leitura: sem aviso, porque não há onde o utilizador possa agir.
    assert.equal(worstWorkingVolume(win.filter((v) => v.readOnly)), null);
  });

  test("capacidade, usado, livre e percentagem são coerentes com os bytes lidos", () => {
    const c = describeDiskRead(machineVolumes()).volumes.find((volume) => volume.mount === "C:");
    assert.equal(c.totalGb, 952.9);
    assert.equal(c.usedGb, 846.1);
    assert.equal(c.freeGb, 106.8);
    assert.equal(c.usagePercent, 88.8);
    assert.equal(c.fileSystem, "NTFS");
  });

  test("o aviso de pouco espaço sai do volume de trabalho mais cheio, nunca do reservado", () => {
    const volumes = describeDiskRead([
      fsEntry("C:", { totalGb: 500, usedGb: 100 }),
      fsEntry("D:", { totalGb: 0.05, usedGb: 0.049 }), // 98% cheio, mas é reservado
    ]).volumes;
    assert.equal(worstWorkingVolume(volumes)?.mount, "C:");
  });

  test("leitura vazia e falha têm motivo legível (e nenhum número)", () => {
    const vazio = describeDiskRead([]);
    assert.equal(vazio.ok, false);
    assert.equal(vazio.reason, "Nenhum volume foi reportado pelo sistema.");
    assert.deepEqual(vazio.volumes, []);

    const falha = describeDiskRead(null, "timeout de WMI");
    assert.equal(falha.ok, false);
    assert.match(falha.reason, /não respondeu \(timeout de WMI\)/);

    const naoLista = describeDiskRead(undefined);
    assert.equal(naoLista.ok, false);
    assert.match(naoLista.reason, /não devolveu a lista de volumes/);
  });

  test("entradas inválidas são ignoradas com o motivo agregado", () => {
    const read = describeDiskRead([{ size: 10 * GB }, { mount: "C:", size: 0 }, { mount: "E:", size: 10 * GB, used: 1 * GB }]);
    assert.equal(read.ok, true, "E: é válido, portanto a leitura é boa");
    assert.deepEqual(read.volumes.map((volume) => volume.mount), ["E:"]);

    const nenhum = describeDiskRead([{ size: 10 * GB }, { mount: "C:", size: 0 }]);
    assert.equal(nenhum.ok, false);
    assert.match(nenhum.reason, /sem ponto de montagem/);
    assert.match(nenhum.reason, /sem capacidade legível/);
  });
});

describe("armazenamento: estado publicado (null em vez de 0, TTL do último valor bom)", () => {
  test("estado inicial é unavailable com números null — nunca 0", () => {
    const inicial = initialDiskSnapshot();
    assert.equal(inicial.readStatus, "unavailable");
    assert.equal(inicial.usagePercent, null);
    assert.equal(inicial.usedGb, null);
    assert.equal(inicial.totalGb, null);
    assert.equal(inicial.primary, null);
    assert.deepEqual(inicial.volumes, []);
    assert.match(inicial.reason, /Ainda sem leitura/);
  });

  test("leitura boa publica ok, com lastGoodAt e o motivo a null", () => {
    const { snapshot, lastGood } = buildDiskSnapshot({
      read: describeDiskRead(machineVolumes()),
      lastGood: null,
      nowMs: NOW,
      nowIso: ISO(),
    });

    assert.equal(snapshot.readStatus, "ok");
    assert.equal(snapshot.reason, null);
    assert.equal(snapshot.lastGoodAt, ISO());
    assert.equal(snapshot.primary?.mount, "C:");
    assert.equal(snapshot.usagePercent, 88.8);
    assert.equal(snapshot.fsType, "NTFS");
    assert.equal(snapshot.volumes.length, 4);
    assert.equal(lastGood?.at, ISO());
  });

  test("falha dentro do TTL mantém o último valor bom e marca stale", () => {
    const boa = buildDiskSnapshot({
      read: describeDiskRead(machineVolumes()),
      lastGood: null,
      nowMs: NOW,
      nowIso: ISO(),
    });

    const falha = buildDiskSnapshot({
      read: describeDiskRead(null, "timeout de WMI"),
      lastGood: boa.lastGood,
      nowMs: NOW + 30_000,
      nowIso: ISO(30_000),
    });

    assert.equal(falha.snapshot.readStatus, "stale");
    assert.equal(falha.snapshot.usagePercent, 88.8, "o valor bom não é descartado por uma falha passageira");
    assert.equal(falha.snapshot.volumes.length, 4);
    assert.equal(falha.snapshot.lastGoodAt, ISO());
    assert.match(falha.snapshot.reason, /não respondeu/);
  });

  test("falha depois do TTL expira o valor: unavailable com null (não 0)", () => {
    const boa = buildDiskSnapshot({
      read: describeDiskRead(machineVolumes()),
      lastGood: null,
      nowMs: NOW,
      nowIso: ISO(),
    });

    const expirada = buildDiskSnapshot({
      read: describeDiskRead(null, "timeout de WMI"),
      lastGood: boa.lastGood,
      nowMs: NOW + DISK_STALE_TTL_MS + 1,
      nowIso: ISO(DISK_STALE_TTL_MS + 1),
    });

    assert.equal(expirada.snapshot.readStatus, "unavailable");
    assert.equal(expirada.snapshot.usagePercent, null);
    assert.equal(expirada.snapshot.usedGb, null);
    assert.equal(expirada.snapshot.totalGb, null);
    assert.equal(expirada.snapshot.fsType, "unknown");
    assert.deepEqual(expirada.snapshot.volumes, []);
    assert.equal(expirada.snapshot.lastGoodAt, ISO(), "sabe-se quando foi a última leitura boa");
  });

  test("uma boa leitura volta a ok e renova a idade", () => {
    const boa = buildDiskSnapshot({ read: describeDiskRead(machineVolumes()), lastGood: null, nowMs: NOW, nowIso: ISO() });
    const stale = buildDiskSnapshot({
      read: describeDiskRead(null, "falha"),
      lastGood: boa.lastGood,
      nowMs: NOW + 10_000,
      nowIso: ISO(10_000),
    });
    const recuperada = buildDiskSnapshot({
      read: describeDiskRead(machineVolumes()),
      lastGood: stale.lastGood,
      nowMs: NOW + 20_000,
      nowIso: ISO(20_000),
    });

    assert.equal(recuperada.snapshot.readStatus, "ok");
    assert.equal(recuperada.snapshot.reason, null);
    assert.equal(recuperada.snapshot.lastGoodAt, ISO(20_000));
    assert.equal(recuperada.lastGood?.at, ISO(20_000));
  });

  test("TTL é configurável — o teste não depende do valor de produção", () => {
    const boa = buildDiskSnapshot({ read: describeDiskRead(machineVolumes()), lastGood: null, nowMs: NOW, nowIso: ISO() });
    const comTtlZero = buildDiskSnapshot({
      read: describeDiskRead(null, "falha"),
      lastGood: boa.lastGood,
      nowMs: NOW + 1,
      nowIso: ISO(1),
      ttlMs: 0,
    });
    assert.equal(comTtlZero.snapshot.readStatus, "unavailable");
  });
});
