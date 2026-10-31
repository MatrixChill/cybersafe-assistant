import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DiskSnapshot, DiskVolumeSnapshot } from "@cybersafe/shared-types";
import {
  diskDetailText,
  diskFreeText,
  diskUsagePercentText,
  diskVolumeRows,
  formatGb,
  formatPercent,
} from "../src/lib/diskDisplay";

/**
 * R3-B2 T1 P0 — NaN / undefined em diskDisplay.ts.
 *
 * O core (packages/core/src/disk.ts) valida com `toFiniteNumber` e nunca produz
 * NaN. Mas o dado viaja por IPC (JSON), e snapshots parciais (serviços antigos,
 * serialização) podem trazer `undefined` em vez de `null` — e `undefined` passa
 * direto pelo `== null` ou `=== null` e chega a `formatPercent`, que faz
 * `Intl.NumberFormat.format(undefined)` → "NaN".
 *
 * Este teste prova os casos que o código ACTUAL tem de falhar:
 *   - usagePercent === undefined  → mostra "0,0%" ou "NaN%"
 *   - usagePercent === NaN        → mostra "NaN%"
 *   - primary.totalGb === NaN     → mostra "NaN GB"
 *   - volume.usagePercent === NaN → "NaN%" na linha de volume
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

function nanVolume(overrides: Partial<DiskVolumeSnapshot> = {}): DiskVolumeSnapshot {
  return volume({ totalGb: NaN, usedGb: NaN, freeGb: NaN, usagePercent: NaN, ...overrides });
}

describe("R3-B2 T1 P0 — NaN/undefined em diskDisplay", () => {

  test("formatPercent( NaN ) não devolve 'NaN%' — devolve '—'", () => {
    assert.equal(formatPercent(NaN), "—", "NaN não pode virar 'NaN%'");
    assert.equal(formatPercent(Infinity), "—");
    assert.equal(formatPercent(-Infinity), "—");
    assert.equal(formatPercent(0), "0,0%", "0 real continua a aparecer");
    assert.equal(formatPercent(50), "50,0%", "valor real continua a aparecer");
  });

  test("formatGb( NaN ) não devolve 'NaN GB' — devolve '—'", () => {
    assert.equal(formatGb(NaN), "—", "NaN não pode virar 'NaN GB'");
    assert.equal(formatGb(Infinity), "—");
    assert.equal(formatGb(0.1), "0,1 GB", "valor real continua a aparecer");
  });

  test("diskUsagePercentText: usagePercent undefined → '—' (não 'NaN%')", () => {
    const disk = ok({ usagePercent: undefined as unknown as number });
    assert.equal(diskUsagePercentText(disk), "—", "undefined não pode virar 'NaN%'");
    assert.notEqual(diskUsagePercentText(disk), "NaN%");
  });

  test("diskUsagePercentText: usagePercent NaN → '—' (não 'NaN%')", () => {
    const disk = ok({ usagePercent: NaN });
    assert.equal(diskUsagePercentText(disk), "—", "NaN não pode virar 'NaN%'");
    assert.notEqual(diskUsagePercentText(disk), "NaN%");
  });

  test("diskFreeText: primary presente mas freeGb NaN → '—' (não 'NaN GB livres')", () => {
    const disk = ok({ primary: volume({ freeGb: NaN }), usagePercent: NaN });
    assert.equal(diskFreeText(disk), "—", "NaN não pode virar 'NaN GB livres'");
    assert.equal(diskFreeText(disk).includes("NaN"), false, "não pode conter NaN");
  });

  test("diskDetailText: totalGb NaN → 'sem leitura do volume' (não 'NaN GB')", () => {
    const disk = ok({ primary: volume({ totalGb: NaN }), usagePercent: NaN });
    assert.equal(diskDetailText(disk), "sem leitura do volume", "NaN não pode virar 'NaN GB no total'");
    assert.equal(diskDetailText(disk).includes("NaN"), false, "não pode conter NaN");
  });

  test("diskVolumeRows: volume com NaN → usagePercentText '—', usagePercent 0 (não NaN)", () => {
    const disk = ok({
      volumes: [nanVolume()],
      primary: nanVolume(),
    });
    const rows = diskVolumeRows(disk);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usagePercentText, "—", "NaN na linha de volume vir '—'");
    assert.equal(rows[0].usagePercent, 0, "usagePercent numérico deve ser 0 não NaN para getUsageColor");
    assert.equal(rows[0].totalText, "—");
    assert.equal(rows[0].freeText, "—");
    assert.equal(rows[0].usedText, "—");
  });

  test("sem regressão — leitura boa continua a mostrar valores reais", () => {
    assert.equal(diskUsagePercentText(ok()), "88,8%");
    assert.equal(diskFreeText(ok()), "107 GB livres");
    assert.equal(diskDetailText(ok()), "C: · 953 GB no total · 88,8% usado");
  });
});
