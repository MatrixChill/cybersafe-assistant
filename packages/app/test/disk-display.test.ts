import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DiskSnapshot, DiskVolumeSnapshot } from "@cybersafe/shared-types";
import {
  diskDetailText,
  diskFreeText,
  diskOtherVolumesText,
  diskReadLabel,
  diskReadTone,
  diskReservedVolumesText,
  diskUnavailableText,
  diskUsagePercentText,
  diskVolumeRows,
  formatGb,
  formatPercent,
  humanAge,
} from "../src/lib/diskDisplay";

/**
 * APRESENTAÇÃO do armazenamento — a regra que o utilizador viu falhar.
 *
 * O PC Center escrevia `Math.round(hardware.disk.usagePercent)%` sem guarda e,
 * sem leitura, mostrava "0%" e "0,0 / 0,0 GB" como se fossem medições. Aqui
 * fixa-se o contrato: sem leitura é "—"/"Indisponível" + motivo, NUNCA "0%".
 * Estes testes cobrem o que o Dashboard e o PC Center mostram, porque ambos
 * consomem exatamente estas funções (é a garantia de consistência entre ecrãs).
 */

const volume = (overrides: Partial<DiskVolumeSnapshot> = {}): DiskVolumeSnapshot => ({
  mount: "C:",
  fileSystem: "NTFS",
  totalGb: 952.9,
  usedGb: 846.1,
  freeGb: 106.8,
  usagePercent: 88.8,
  kind: "working",
  readOnly: false,
  ...overrides,
});

const ok = (overrides: Partial<DiskSnapshot> = {}): DiskSnapshot => ({
  readStatus: "ok",
  reason: null,
  lastGoodAt: "2026-10-09T22:00:00.000Z",
  volumes: [volume()],
  primary: volume(),
  usagePercent: 88.8,
  usedGb: 846.1,
  totalGb: 952.9,
  fsType: "NTFS",
  ...overrides,
});

const unavailable = (overrides: Partial<DiskSnapshot> = {}): DiskSnapshot => ({
  readStatus: "unavailable",
  reason: "O serviço de armazenamento do Windows não respondeu (timeout de WMI).",
  lastGoodAt: null,
  volumes: [],
  primary: null,
  usagePercent: null,
  usedGb: null,
  totalGb: null,
  fsType: "unknown",
  ...overrides,
});

describe("armazenamento: nunca mostrar 0% sem leitura", () => {
  test("sem leitura: percentagem é — e o espaço livre é —", () => {
    const disk = unavailable();
    assert.equal(diskUsagePercentText(disk), "—");
    assert.notEqual(diskUsagePercentText(disk), "0%");
    assert.equal(diskFreeText(disk), "—");
    assert.equal(diskDetailText(disk), "sem leitura do volume");
  });

  test("0% REAL (volume mesmo vazio) continua a ser mostrado — é uma medição", () => {
    const vazio = volume({ usedGb: 0, freeGb: 500, totalGb: 500, usagePercent: 0 });
    const disk = ok({ volumes: [vazio], primary: vazio, usagePercent: 0, usedGb: 0, totalGb: 500 });
    // A distinção que interessa: 0 MEDIDO aparece como número ("0,0%"),
    // ausência de leitura aparece como "—". Antes, ambos apareciam iguais.
    assert.equal(diskUsagePercentText(disk), "0,0%");
    assert.notEqual(diskUsagePercentText(disk), "—");
    assert.equal(diskDetailText(disk), "C: · 500 GB no total · 0,0% usado");
  });

  test("sem leitura o motivo é mostrado tal como veio, com o estado ao lado", () => {
    const disk = unavailable();
    assert.equal(diskReadLabel(disk), "Indisponível");
    assert.equal(diskReadTone(disk), "unknown");
    assert.equal(diskUnavailableText(disk, Date.now()), disk.reason);
  });

  test("stale mostra os valores retidos E a idade da leitura", () => {
    const now = Date.parse("2026-10-09T22:05:00.000Z");
    const disk = ok({
      readStatus: "stale",
      reason: "O serviço de armazenamento do Windows não respondeu (timeout de WMI).",
      lastGoodAt: "2026-10-09T22:04:00.000Z",
    });

    assert.equal(diskReadLabel(disk), "Última leitura válida");
    assert.equal(diskReadTone(disk), "warn");
    assert.equal(diskUsagePercentText(disk), "88,8%", "o valor retido é real e pode ser mostrado");
    assert.match(String(diskUnavailableText(disk, now)), /Valores há 1 min\.$/);
  });

  test("com leitura boa não há motivo a mostrar", () => {
    assert.equal(diskUnavailableText(ok(), Date.now()), null);
  });
});

describe("armazenamento: por unidade e partições reservadas", () => {
  const machine: DiskSnapshot = ok({
    volumes: [
      volume(),
      volume({ mount: "F:", totalGb: 476.1, usedGb: 284.5, freeGb: 191.6, usagePercent: 59.8 }),
      volume({ mount: "D:", totalGb: 0.1, usedGb: 0.1, freeGb: 0, usagePercent: 100, kind: "system-reserved" }),
    ],
  });

  test("os outros volumes aparecem com o espaço livre, o reservado não conta como disco", () => {
    // ≥ 100 GB arredonda ao inteiro (191,6 GB → "192 GB"); a partição reservada
    // mantém a casa decimal para não virar "0 GB".
    assert.equal(diskOtherVolumesText(machine), "F: 192 GB livres");
    assert.equal(diskReservedVolumesText(machine), "D: partição de sistema (0,1 GB)");
  });

  test("as linhas por unidade trazem capacidade, usado, livre e percentagem", () => {
    const rows = diskVolumeRows(machine);
    assert.equal(rows.length, 3);

    const c = rows.find((row) => row.mount === "C:");
    assert.equal(c?.usedText, "846 GB");
    assert.equal(c?.totalText, "953 GB");
    assert.equal(c?.freeText, "107 GB");
    assert.equal(c?.usagePercentText, "88,8%");
    assert.equal(c?.kindLabel, "Volume de trabalho");

    const d = rows.find((row) => row.mount === "D:");
    assert.equal(d?.kindLabel, "Partição de sistema");
  });

  test("volumeKind distingue sempre 'logical' — nunca confunde com disco físico", () => {
    const rows = diskVolumeRows(machine);
    for (const row of rows) {
      assert.equal(row.volumeKind, "logical",
        `todos os volumes são lógicos (letras), nunca discos físicos (modelo/serial/SMART)`);
    }
  });

  test("sem leitura não há linhas nenhumas (nem zeros inventados)", () => {
    assert.deepEqual(diskVolumeRows(unavailable()), []);
    assert.equal(diskOtherVolumesText(unavailable()), null);
    assert.equal(diskReservedVolumesText(unavailable()), null);
  });
});

describe("formatação PT-PT", () => {
  test("GB grandes arredondam, GB pequenos mantêm uma decimal", () => {
    assert.equal(formatGb(952.9), "953 GB");
    assert.equal(formatGb(106.8), "107 GB");
    assert.equal(formatGb(0.1), "0,1 GB");
    assert.equal(formatGb(0.05), "0,1 GB", "52 MB não pode aparecer como 0 GB");
  });

  test("percentagem com vírgula decimal", () => {
    assert.equal(formatPercent(88.8), "88,8%");
    assert.equal(formatPercent(0), "0,0%");
  });

  test("idade legível e nunca negativa", () => {
    assert.equal(humanAge(5_000), "há 5 s");
    assert.equal(humanAge(90_000), "há 1 min");
    assert.equal(humanAge(3_900_000), "há 1 h 5 min");
    assert.equal(humanAge(-1), null);
    assert.equal(humanAge(Number.NaN), null);
  });
});
