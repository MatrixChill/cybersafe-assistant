import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiskSnapshot, HardwareSnapshot } from "@cybersafe/shared-types";
import {
  batteryReadout,
  diskReadProvenance,
  gpuTemperatureProvenance,
  secondaryGpuTemperatures,
  vramPercentOf,
  vramReadout,
} from "../src/pages/PCCenterPage";

/**
 * TP-RC22-PCCENTER — telemetria do PC Center.
 *
 * Regra: só se mostra o que o contrato JÁ mede. GPU (VRAM, sensor, fonte,
 * hotspot/junction, lista de placas), bateria (status/origem) e armazenamento
 * (readStatus/reason/lastGoodAt) existem em `@cybersafe/shared-types`. SMART,
 * desgaste, erros, modelo do disco, taxas de leitura/escrita e sensor da placa
 * NÃO existem: ficam “não lidos”, nunca estimados.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "src", "pages", "PCCenterPage.tsx"), "utf8");

type Gpu = NonNullable<HardwareSnapshot["gpu"]>;

const gpuBase: Gpu = {
  model: "NVIDIA GeForce RTX 3060",
  usagePercent: 41,
  vramTotalMb: 6144,
  vramUsedMb: 1229,
  temperature: 62,
};

// ── VRAM ──────────────────────────────────────────────────────────────────

test("VRAM: percentagem só com os dois números medidos", () => {
  assert.equal(vramPercentOf(1229, 6144), 20);
  assert.equal(vramPercentOf(3072, 6144), 50);
  assert.equal(vramPercentOf(0, 6144), 0);
});

test("VRAM: entradas em falta ou absurdas não produzem percentagem", () => {
  assert.equal(vramPercentOf(null, 6144), null, "usada em falta não é 0%");
  assert.equal(vramPercentOf(1024, null), null, "total em falta não é 0%");
  assert.equal(vramPercentOf(1024, 0), null, "total 0 não é divisível");
  assert.equal(vramPercentOf(-5, 6144), null);
  assert.equal(vramPercentOf(Number.NaN, 6144), null);
  assert.equal(vramPercentOf(9999, 6144), 100, "acima do total fica contido em 100");
});

test("VRAM: texto mostra usado/total e a percentagem, ou um traço honesto", () => {
  const comLeitura = vramReadout(gpuBase);
  assert.equal(comLeitura.text, "1.2 / 6.0 GB · 20%");
  assert.equal(comLeitura.percent, 20);
  assert.equal(vramReadout({ ...gpuBase, vramTotalMb: null }).text, "—");
  assert.equal(vramReadout({ ...gpuBase, vramUsedMb: null }).text, "6.0 GB", "sem usado mostra só o total");
  assert.equal(vramReadout(null).text, "—");
});

// ── Proveniência térmica da GPU ───────────────────────────────────────────

test("temperatura da GPU diz o sensor, a fonte e se é última leitura", () => {
  assert.equal(
    gpuTemperatureProvenance({
      ...gpuBase,
      temperatureSensor: "GPU Core",
      temperatureSource: "systeminformation",
    }),
    "GPU Core · systeminformation",
  );
  assert.equal(
    gpuTemperatureProvenance({
      ...gpuBase,
      temperatureSensor: "GPU Core",
      temperatureSource: "systeminformation",
      temperatureStatus: "stale",
    }),
    "GPU Core · systeminformation · última leitura guardada",
  );
  assert.equal(gpuTemperatureProvenance(gpuBase), "GPU Core", "sem sensor declarado, o rótulo é o do contrato");
  assert.equal(gpuTemperatureProvenance(null), "");
});

test("sensores secundários: hotspot/junction reais, nunca o core duplicado", () => {
  const linhas = secondaryGpuTemperatures({
    ...gpuBase,
    coreTemperature: 62,
    hotspotTemperature: 74,
    memoryJunctionTemperature: 80,
  });
  assert.deepEqual(linhas, [
    { label: "Hotspot", value: 74 },
    { label: "Memory Junction", value: 80 },
  ]);
  assert.deepEqual(
    secondaryGpuTemperatures({ ...gpuBase, coreTemperature: 62, hotspotTemperature: 62 }),
    [],
    "um sensor igual ao core não é secundário",
  );
  assert.deepEqual(secondaryGpuTemperatures({ ...gpuBase, hotspotTemperature: 0 }), []);
  assert.deepEqual(secondaryGpuTemperatures(null), []);
});

// ── Bateria ───────────────────────────────────────────────────────────────

test("bateria: sem leitura não há barra nem «— %»", () => {
  assert.deepEqual(batteryReadout(null), { text: "—", width: null });
  assert.deepEqual(batteryReadout(0), { text: "0", width: 0 }, "0% é real quando o status é present");
  assert.deepEqual(batteryReadout(18.6), { text: "19", width: 18.6 });
  assert.deepEqual(batteryReadout(150), { text: "100", width: 100 });
});

// ── Armazenamento ─────────────────────────────────────────────────────────

const diskBase: DiskSnapshot = {
  readStatus: "ok",
  reason: null,
  lastGoodAt: null,
  volumes: [],
  primary: null,
  usagePercent: null,
  usedGb: null,
  totalGb: null,
  fsType: "",
};

test("disco: proveniência distingue leitura agora, cache e falha", () => {
  assert.equal(diskReadProvenance(diskBase, Date.now()), "Volumes medidos agora pelo serviço.");
  const agora = Date.parse("2026-10-22T12:00:00.000Z");
  const stale = diskReadProvenance(
    { ...diskBase, readStatus: "stale", reason: "A leitura falhou.", lastGoodAt: new Date(agora).toISOString() },
    agora + 120_000,
  );
  assert.match(stale, /A leitura falhou\./);
  assert.match(stale, /Último valor bom há 2 min\./);
  assert.equal(
    diskReadProvenance({ ...diskBase, readStatus: "unavailable", reason: "Sem leitura fiável." }, agora),
    "Sem leitura fiável.",
  );
});

test("disco: sem leitura e sem motivo não fica em branco", () => {
  const texto = diskReadProvenance({ ...diskBase, readStatus: "unavailable", reason: null }, Date.now());
  assert.ok(texto.length > 10, "o motivo em falta tem de ser explicado");
  assert.doesNotMatch(texto, /0\s*%/);
});

// ── Ligação na interface (não constantes soltas) ─────────────────────────

test("o cartão de GPU usa os helpers de VRAM/proveniência e mostra sensores secundários", () => {
  assert.match(SRC, /\{vramReadout\(hardware\.gpu\)\.text\}/, "a VRAM não passa pelo helper");
  assert.match(SRC, /data-testid="gpu-temp-provenance"[\s\S]{0,120}gpuTemperatureProvenance\(hardware\.gpu\)/);
  assert.match(SRC, /data-testid="gpu-extra-sensors"/);
  assert.match(SRC, /data-testid="gpu-detected-list"/, "as GPUs detetadas não são listadas");
  assert.match(SRC, /\(hardware\.gpu\.gpus\?\.length \?\? 0\) > 1/, "a lista só aparece com mais do que uma placa");
});

test("o cartão de bateria usa a leitura do contrato e esconde a barra sem leitura", () => {
  assert.match(SRC, /const batteryCard = batteryReadout\(batteryDisp\.percent\)/);
  assert.match(SRC, /\{batteryCard\.text\}/);
  assert.match(SRC, /\{batteryCard\.width != null && \(/);
  assert.match(SRC, /data-testid="battery-source"/);
  assert.doesNotMatch(SRC, /batteryDisp\.percent \?\? 0/, "a barra voltou a usar 0 como leitura");
  assert.doesNotMatch(SRC, /hardware\.battery\.percent < 20/, "a cor voltou a usar a percentagem crua");
});

test("o armazenamento mostra a proveniência e declara o que não é lido", () => {
  assert.match(SRC, /data-testid="disk-read-provenance"/);
  assert.match(SRC, /diskReadProvenance\(disk, nowMs\)/);
  assert.match(SRC, /data-testid="disk-smart-note"/);
  assert.match(SRC, /data-testid="disk-sensor-state"/);
  assert.match(SRC, /data-testid="board-sensor-state"/);
});

test("negativo: a página não inventa SMART, desgaste nem sensores", () => {
  for (const proibido of ["wearPercent", "smartStatus", "powerOnHours", "readBytesPerSec", "writeBytesPerSec"]) {
    assert.equal(SRC.includes(proibido), false, `${proibido} não existe no contrato: não pode aparecer na página`);
  }
  assert.equal(SRC.includes("Sensor térmico ACPI"), false, "a origem da temperatura da CPU era afirmada sem estar no contrato");
  assert.equal(SRC.includes("Sem bateria"), false, "«Sem bateria» só pode sair de batteryDisplay com status absent");
  assert.equal(SRC.includes("hardware.battery.percent <"), false);
});
