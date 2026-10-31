import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, DiskSnapshot, HardwareSnapshot } from "@cybersafe/shared-types";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { GPU_ABSENT_LABEL, GPU_NO_SENSOR_LABEL, GPU_PENDING_LABEL, gpuPresence } = await import(
  "../src/lib/gpuDisplay"
);
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: PCCenterPage } = await import("../src/pages/PCCenterPage");
const { default: DashboardPage } = await import("../src/pages/DashboardPage");

/**
 * P0 ARMAZENAMENTO + P1 GPU (FAIL humano de 2026-10-10).
 *
 * O que o utilizador viu, ao mesmo tempo:
 *   - Dashboard: cartão Disco a "—" com "Ainda sem leitura do armazenamento
 *     desde o arranque";
 *   - PC Center: cartão Armazenamento a "— / Indisponível";
 *   - Saúde do Windows: C: a 89% com 106,4 GB livres.
 *
 * A causa-raiz era comum (um snapshot de hardware em cache que nunca era
 * reconstruído — ver os testes de `hardware.snapshot` no serviço e do primeiro
 * snapshot no core). Estes testes prendem o contrato da CAMADA DE ECRÃ, que é o
 * que o humano vê:
 *   1. os dois consumidores de `HardwareSnapshot.disk` (Dashboard e PC Center)
 *      dizem a MESMA coisa e nenhum inventa uma percentagem;
 *   2. "sem leitura da GPU" nunca é apresentado como "não detetada" — a máquina
 *      tem uma AMD Radeon RX 5600 XT.
 */

const C_VOLUME = {
  mount: "C:",
  fileSystem: "NTFS",
  totalGb: 952.9,
  usedGb: 846.1,
  freeGb: 106.8,
  usagePercent: 88.8,
  kind: "working" as const,
  readOnly: false,
};

const diskOk = (): DiskSnapshot => ({
  readStatus: "ok",
  reason: null,
  lastGoodAt: "2026-10-10T14:00:00.000Z",
  volumes: [C_VOLUME],
  primary: C_VOLUME,
  usagePercent: 88.8,
  usedGb: 846.1,
  totalGb: 952.9,
  fsType: "NTFS",
});

/** O estado que o utilizador viu: nenhuma leitura publicada desde o arranque. */
const diskNeverRead = (): DiskSnapshot => ({
  readStatus: "unavailable",
  reason: "Ainda sem leitura do armazenamento desde o arranque.",
  lastGoodAt: null,
  volumes: [],
  primary: null,
  usagePercent: null,
  usedGb: null,
  totalGb: null,
  fsType: "unknown",
});

type GpuFixture = HardwareSnapshot["gpu"];

function snapshot(disk: DiskSnapshot, gpu: GpuFixture): HardwareSnapshot {
  return {
    cpu: {
      usage: 7,
      model: "AMD Ryzen 5 5600",
      cores: 6,
      speed: 3.5,
      temperature: null,
      temperatureStatus: "unavailable",
    },
    ram: { usagePercent: 51, usedGb: 15.8, totalGb: 30.9 },
    disk,
    network: { rxSec: 1024, txSec: 512, interfaceName: "Ethernet" },
    battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null },
    gpu,
    system: { uptime: 3600, platform: "win32", osVersion: "10.0.26300", hostname: "PC" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    stressScore: 0,
    stressContributions: { cpu: 0, ram: 0, temperature: 0, gpu: 0 },
    alerts: [],
    timestamp: "2026-10-10T14:00:00.000Z",
  } as unknown as HardwareSnapshot;
}

/** Placa PRESENTE (a deste PC) sem sensor térmico seguro. */
const GPU_PRESENT: GpuFixture = {
  available: true,
  usagePercent: null,
  vramTotalMb: 6128,
  vramUsedMb: null,
  temperature: null,
  model: "AMD Radeon RX 5600 XT",
  temperatureStatus: "unavailable",
};

/** Nenhum controlador gráfico reportado pelo sistema. */
const GPU_ABSENT = { model: "Não disponível neste sistema", available: false } as unknown as GpuFixture;

const renderPcCenter = (disk: DiskSnapshot, gpu: GpuFixture) =>
  renderToStaticMarkup(createElement(PCCenterPage, { hardware: snapshot(disk, gpu) }));

const renderDashboard = (disk: DiskSnapshot, gpu: GpuFixture) =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(DashboardPage, {
        dashboard: {
          totalEvents: 0,
          highSeverityEvents: 0,
          downloadRisk: "low",
          recentThreats: [],
          alerts: [],
          systemStatus: "safe",
          riskScore: 78,
        } as unknown as DashboardSummary,
        isLoading: false,
        hardware: snapshot(disk, gpu),
      }),
    ),
  );

describe("P0 armazenamento — Dashboard e PC Center dizem a mesma verdade", () => {
  test("com leitura válida, os dois ecrãs mostram a mesma percentagem medida", () => {
    const dashboard = renderDashboard(diskOk(), GPU_PRESENT);
    const pcCenter = renderPcCenter(diskOk(), GPU_PRESENT);

    for (const [nome, html] of [["Dashboard", dashboard], ["PC Center", pcCenter]] as const) {
      assert.match(html, /88,8%/, `${nome} não mostra a percentagem medida`);
      assert.doesNotMatch(html, /Ainda sem leitura do armazenamento/, `${nome} diz que não há leitura com leitura válida`);
      assert.doesNotMatch(html, /sem leitura do volume/, `${nome} diz que não há volume com a leitura boa`);
    }
    // A percentagem do volume principal vem da MESMA medição nos dois ecrãs.
    // Migração V2-FIRST: a linha do Painel é a do diagnóstico (`<volume> · X
    // livres · Y% usado`); a capacidade total continua a ser dita pelo PC
    // Center, logo é lá que se procura. O que não pode mudar é o número.
    assert.match(dashboard, /C: · [^\s]+ [^\s]* ?livres · 88,8% usado/, "o Dashboard não dá o espaço livre medido");
    assert.match(dashboard, /88,8% usado/, "o Dashboard não dá a percentagem medida do volume");
    assert.match(pcCenter, /Capacidade usada em C:/, "o PC Center não identifica o volume principal");
  });

  test("sem leitura, os dois ecrãs dizem indisponível e nenhum inventa 0%", () => {
    const dashboard = renderDashboard(diskNeverRead(), GPU_PRESENT);
    const pcCenter = renderPcCenter(diskNeverRead(), GPU_PRESENT);

    for (const [nome, html] of [["Dashboard", dashboard], ["PC Center", pcCenter]] as const) {
      assert.match(html, /Indisponível/, `${nome} não identifica o estado da leitura`);
      assert.match(html, /—/, `${nome} não usa o traço para "sem medição"`);
      assert.doesNotMatch(html, /88,8%/, `${nome} mostrou a leitura antiga como se fosse atual`);
    }
    // Nenhuma superfície pode afirmar uma medição que não existe.
    assert.doesNotMatch(pcCenter, /0,0%|0% de 0/, "o PC Center fabricou uma medição de armazenamento");
    assert.doesNotMatch(dashboard, /0,0%/, "o Dashboard fabricou uma medição de armazenamento");
  });
});

describe("P1 GPU — sem leitura não é 'não detetada'", () => {
  test("gpuPresence distingue os três estados", () => {
    assert.equal(gpuPresence(null), "pending");
    assert.equal(gpuPresence(undefined), "pending");
    assert.equal(gpuPresence(GPU_ABSENT), "absent");
    assert.equal(gpuPresence(GPU_PRESENT), "present");
    // Sem o campo (snapshots antigos) o modelo reportado continua a ser prova de placa.
    assert.equal(gpuPresence({ model: "AMD Radeon RX 5600 XT" } as unknown as GpuFixture), "present");
  });

  test("sem leitura publicada: 'Sem leitura da GPU', nunca 'Não detetada'", () => {
    const html = renderPcCenter(diskOk(), null);

    assert.match(html, new RegExp(GPU_PENDING_LABEL), "o estado pendente não é nomeado");
    assert.doesNotMatch(
      html,
      new RegExp(GPU_ABSENT_LABEL),
      "acusou o hardware de estar ausente só porque a leitura ainda não chegou",
    );
  });

  test("placa detetada sem sensor: o modelo aparece e a placa não é dada como ausente", () => {
    const html = renderPcCenter(diskOk(), GPU_PRESENT);

    assert.match(html, /AMD Radeon RX 5600 XT/, "a placa detetada tem de ser nomeada");
    assert.match(html, new RegExp(GPU_NO_SENSOR_LABEL));
    assert.doesNotMatch(html, new RegExp(GPU_ABSENT_LABEL));
  });

  test("nenhum controlador reportado: aí sim, 'Não detetada'", () => {
    const html = renderPcCenter(diskOk(), GPU_ABSENT);

    assert.match(html, new RegExp(GPU_ABSENT_LABEL));
    assert.doesNotMatch(html, new RegExp(GPU_PENDING_LABEL));
  });
});
