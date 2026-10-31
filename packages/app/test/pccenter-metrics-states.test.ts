import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HardwareSnapshot } from "@cybersafe/shared-types";
import { GPU_PENDING_LABEL, GPU_ABSENT_LABEL } from "../src/lib/gpuDisplay";

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: PCCenterPage, AdvancedView } = await import("../src/pages/PCCenterPage");

type Overrides = {
  cpu?: Record<string, unknown>;
  disk?: Record<string, unknown>;
  network?: Record<string, unknown>;
  origin?: "LIVE" | "CACHED" | "UNAVAILABLE";
};

function snapshot(o: Overrides = {}): HardwareSnapshot {
  const at = new Date(Date.now() - 90_000).toISOString();
  return {
    cpu: { usage: 7, usageStatus: "available", usageUpdatedAt: at, model: "AMD Ryzen 5 5600", cores: 6, speed: 3.5, temperature: null, temperatureStatus: "unavailable", ...o.cpu },
    ram: { usagePercent: 51, usedGb: 15.8, totalGb: 30.9, usageStatus: "available" },
    disk: {
      readStatus: "ok",
      reason: null,
      lastGoodAt: at,
      volumes: [],
      primary: { mount: "C:", fileSystem: "NTFS", usagePercent: 62, usedGb: 300, freeGb: 200, totalGb: 500 },
      usagePercent: 62,
      usedGb: 300,
      totalGb: 500,
      fsType: "NTFS",
      ...o.disk,
    },
    network: { rxSec: 1024, txSec: 512, interfaceName: "Ethernet", readStatus: "available", updatedAt: at, ...o.network },
    battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null, status: "absent" },
    gpu: { usagePercent: null, vramTotalMb: 6128, vramUsedMb: null, temperature: null, model: "AMD Radeon RX 5600 XT", temperatureStatus: "unavailable" },
    system: { uptime: 3600, platform: "win32", osVersion: "10.0.26300", hostname: "PC" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    stressScore: 0,
    stressContributions: { cpu: 0, ram: 0, temperature: 0, gpu: 0 },
    alerts: [],
    timestamp: at,
  } as unknown as HardwareSnapshot;
}

const render = (o: Overrides = {}) =>
  renderToStaticMarkup(createElement(PCCenterPage, { hardware: snapshot(o), dataOrigin: o.origin ?? "LIVE" }));

describe("PC Center Simples — estados por métrica (atual)", () => {
  test("LIVE com leituras válidas mostra valores e nenhum aviso de cache", () => {
    const html = render();
    assert.match(html, />7%</);
    assert.match(html, />51%</);
    assert.doesNotMatch(html, /não são atuais/);
    assert.doesNotMatch(html, /Sem leitura/);
  });
});

describe("PC Center Simples — estados por métrica (cache)", () => {
  test("CPU stale mostra o último valor rotulado, não como agora", () => {
    const html = render({ cpu: { usage: 33, usageStatus: "stale" }, origin: "CACHED" });
    assert.match(html, /33% \(última leitura\)/);
    assert.match(html, /não são atuais/);
  });

  test("rede stale mostra rótulo de última leitura", () => {
    const html = render({ network: { readStatus: "stale" }, origin: "CACHED" });
    assert.match(html, /Última leitura/);
  });
});

describe("PC Center Simples — indisponível / pendente (sem zero inventado)", () => {
  test("CPU unavailable com usage 0 NÃO mostra 0%", () => {
    const html = render({ cpu: { usage: 0, usageStatus: "unavailable" } });
    assert.match(html, /Sem leitura/);
    assert.doesNotMatch(html, />0%</);
  });

  test("disco unavailable mostra travessão, nunca 0%", () => {
    const html = render({ disk: { readStatus: "unavailable", reason: "Sem leitura do volume.", primary: null, usagePercent: null, usedGb: null, totalGb: null } });
    assert.doesNotMatch(html, />0%</);
    assert.match(html, /—/);
  });

  test("rede unavailable mostra 'Sem leitura', nunca 0 B/s", () => {
    const html = render({ network: { readStatus: "unavailable", rxSec: 0, txSec: 0 } });
    assert.match(html, /Sem leitura/);
    assert.doesNotMatch(html, /0 B\/s/);
  });

  test("rede pending mostra 'A medir…'", () => {
    const html = render({ network: { readStatus: "pending", rxSec: 0, txSec: 0 } });
    assert.match(html, /A medir/);
  });
});

describe("PC Center Avançado — bateria decide pelo status (C2)", () => {
  const renderAdvanced = (battery: Record<string, unknown>, origin: "LIVE" | "CACHED" = "LIVE") =>
    renderToStaticMarkup(createElement(AdvancedView, {
      hardware: { ...snapshot(), battery } as unknown as HardwareSnapshot,
      batteryOrigin: origin,
    }));

  test("error com percentagem antiga NÃO aparece como leitura atual", () => {
    const html = renderAdvanced({ hasBattery: true, percent: 45, isCharging: false, timeRemaining: 90, status: "error" });
    assert.match(html, /Erro ao ler a bateria/);
    assert.doesNotMatch(html, />45</);
    assert.doesNotMatch(html, /restantes/);
  });

  test("present com 0% real mostra 0", () => {
    const html = renderAdvanced({ hasBattery: true, percent: 0, isCharging: false, timeRemaining: null, status: "present" });
    assert.match(html, />0</);
  });

  test("absent mostra 'Sem bateria'", () => {
    const html = renderAdvanced({ hasBattery: false, percent: 0, isCharging: false, timeRemaining: null, status: "absent" });
    assert.match(html, /Sem bateria/);
  });

  test("legado sem status e hasBattery false: cartão escondido", () => {
    const html = renderAdvanced({ hasBattery: false, percent: 0, isCharging: false, timeRemaining: null });
    assert.doesNotMatch(html, />Bateria</);
  });
});

describe("PC Center Avançado — GPU, disco e temperatura sem leitura (T4)", () => {
  const renderAdv = (o: { gpu?: unknown; disk?: Record<string, unknown>; temperature?: number | null }) => {
    const base = snapshot();
    const hw = {
      ...base,
      gpu: o.gpu === undefined ? base.gpu : o.gpu,
      disk: o.disk ? { ...base.disk, ...o.disk } : base.disk,
      cpu: { ...base.cpu, temperature: o.temperature === undefined ? null : o.temperature },
    } as unknown as HardwareSnapshot;
    return renderToStaticMarkup(createElement(AdvancedView, { hardware: hw, batteryOrigin: "LIVE" }));
  };

  test("GPU ainda sem leitura mostra 'Sem leitura da GPU', não 'sem placa'", () => {
    const html = renderAdv({ gpu: null });
    assert.match(html, new RegExp(GPU_PENDING_LABEL));
    assert.doesNotMatch(html, new RegExp(GPU_ABSENT_LABEL));
  });

  test("GPU detetada como ausente mostra o rótulo de ausência", () => {
    const html = renderAdv({ gpu: { available: false, usagePercent: null, vramTotalMb: 0, vramUsedMb: null, model: "", temperature: null, temperatureStatus: "unavailable" } });
    assert.match(html, new RegExp(GPU_ABSENT_LABEL));
  });

  test("disco sem leitura na Avançada não mostra 0%", () => {
    const html = renderAdv({ disk: { readStatus: "unavailable", reason: "Sem leitura do volume.", primary: null, usagePercent: null, usedGb: null, totalGb: null } });
    assert.match(html, /Sem leitura do volume/);
    assert.doesNotMatch(html, />0%</);
  });

  test("temperatura CPU sem leitura não mostra 0°C", () => {
    const html = renderAdv({ temperature: null });
    assert.doesNotMatch(html, />0°C</);
    assert.doesNotMatch(html, /0 °C/);
  });
});

describe("PC Center Simples — UNAVAILABLE global", () => {
  test("sem snapshot não há valor inventado: loading, não 0%", () => {
    const html = renderToStaticMarkup(createElement(PCCenterPage, { hardware: null, dataOrigin: "UNAVAILABLE" }));
    assert.doesNotMatch(html, />0%</);
  });
});
