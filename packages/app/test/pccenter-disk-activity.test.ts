/**
 * PC Center — superfície da atividade de disco.
 *
 * Dois defeitos distintos, um só teste para os dois:
 *  · a aquisição media velocidades por volume e NENHUMA vista as mostrava — o
 *    esforço (uma query PDH viva) era pago e o resultado ficava invisível;
 *  · o motivo de indisponibilidade tem de se distinguir da medição: «ainda sem
 *    intervalo» não é «0 B/s» nem «sensor em falta».
 *
 * Os números em baixo são FIXTURES de teste. As leituras reais desta máquina
 * estão documentadas na entrega, com a fonte.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HardwareSnapshot } from "@cybersafe/shared-types";
import { HardwareDetailPanel } from "../src/components/HardwareDetailPanel";

(globalThis as Record<string, unknown>).React = React;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pagina = fs.readFileSync(path.join(HERE, "..", "src", "pages", "PCCenterPage.tsx"), "utf8");

const base = {
  timestamp: "2026-10-26T12:00:00.000Z",
  cpu: { usage: 42, usageStatus: "available", model: "AMD Ryzen 9 7900X", cores: 12, speed: 4.7, temperature: null, temperatureStatus: "unavailable" },
  ram: { usagePercent: 55, usedGb: 8.8, totalGb: 16, usageStatus: "available" },
  network: { rxSec: 0, txSec: 0, interfaceName: "", readStatus: "unavailable", adapters: [] },
  battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null },
  gpu: null,
  system: { uptime: 1, platform: "win32", osVersion: "10", hostname: "TEST" },
  topProcessesByCpu: [],
  topProcessesByRam: [],
  stressScore: 0,
  alerts: [],
};

const MEDIDO = {
  ...base,
  disk: {
    readStatus: "ok",
    activityStatus: "available",
    activityDetail: null,
    activity: [
      {
        mount: "C:", device: null, readBytesPerSec: 11_264, writeBytesPerSec: 770_048,
        readsPerSec: 4, writesPerSec: 66, idlePercent: 99.75, status: "available",
        source: "PDH LogicalDisk(C:)",
      },
      {
        mount: "D:", device: null, readBytesPerSec: 0, writeBytesPerSec: 0,
        readsPerSec: 0, writesPerSec: 0, idlePercent: 100, status: "available",
        source: "PDH LogicalDisk(D:)",
      },
      {
        mount: null, device: null, readBytesPerSec: 98, writeBytesPerSec: 770_048,
        readsPerSec: 4, writesPerSec: 66, idlePercent: null, status: "available",
        source: "PDH LogicalDisk(_Total)",
      },
    ],
  },
} as unknown as HardwareSnapshot;

const SEM_INTERVALO = {
  ...MEDIDO,
  disk: {
    readStatus: "ok",
    activityStatus: "unavailable",
    activityDetail: "contadores PDH sem intervalo medido ainda",
    activity: [],
  },
} as unknown as HardwareSnapshot;

const CONTADORES_FALTAM = {
  ...MEDIDO,
  disk: {
    readStatus: "ok",
    activityStatus: "unavailable",
    activityDetail: "ffi-indisponivel:pdh.dll não carregável",
    activity: [],
  },
} as unknown as HardwareSnapshot;

const texto = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const render = (hardware: HardwareSnapshot) =>
  texto(renderToStaticMarkup(createElement(HardwareDetailPanel, { hardware, mostrarBateria: false })));

describe("PC Center — atividade de disco na interface", () => {
  test("o cartão de armazenamento consome a atividade medida", () => {
    assert.match(pagina, /const atividade = diskActivityRows\(disk\);/);
    assert.match(pagina, /data-testid="disk-activity"/);
    assert.match(pagina, /data-testid="disk-activity-state"/);
    assert.match(pagina, /data-testid="disk-activity-provenance"/);
    assert.match(pagina, /\{diskAtividadeIndisponivelTexto\(disk\)\}/);
  });

  test("com leitura: velocidades, operações, ocioso e a fonte declarada", () => {
    const t = render(MEDIDO);
    assert.match(t, /Armazenamento — atividade medida/);
    assert.match(t, /C: 11 KB\/s lidos · 752 KB\/s escritos/);
    assert.match(t, /operações 4 ops\/s \/ 66 ops\/s · tempo ocioso 99,8 %/);
    assert.match(t, /D: 0 B\/s lidos · 0 B\/s escritos/, "zero medido mostra-se como zero");
    assert.match(t, /Todos os volumes 98 B\/s lidos/);
    assert.match(t, /Contadores de desempenho do Windows \(PDH\), os mesmos do Monitor de Recursos/);
    assert.match(t, /pode ler 100 % enquanto há escrita/);
  });

  test("ainda sem intervalo: explica o estado e não publica nenhuma velocidade", () => {
    const t = render(SEM_INTERVALO);
    assert.match(t, /Contadores de disco A medir — os contadores de taxa precisam de duas amostras/);
    assert.doesNotMatch(t, /KB\/s|B\/s/, "sem medição não há números");
    assert.doesNotMatch(t, /0 B\/s/);
  });

  test("contadores indisponíveis: o motivo cru chega à vista, não um genérico", () => {
    const t = render(CONTADORES_FALTAM);
    assert.match(t, /Sem contadores de desempenho nativos nesta máquina \(ffi-indisponivel:pdh\.dll não carregável\)/);
    assert.doesNotMatch(t, /A medir/);
  });
});
