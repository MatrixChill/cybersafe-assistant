/**
 * TP-3H-RAM-REVIEW-FIX — o PC Center tem de renderizar em Node/SSR (sem o
 * `import.meta.env` do Vite) e, nesse ambiente, não emite os atributos de
 * trace DEV-only. Esta é a regressão do `import.meta.env?.DEV === true`:
 * antes, `import.meta.env.DEV` rebentava em SSR (`Cannot read properties of
 * undefined (reading 'DEV')`).
 *
 * NÃO se simula DEV=true: o ponto é exatamente não haver `import.meta.env`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";
import PCCenterPage from "../src/pages/PCCenterPage";
import type { HardwareSnapshot } from "@cybersafe/shared-types";

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function snapshot(overrides: { ram?: Record<string, unknown> } = {}): HardwareSnapshot {
  const at = new Date(Date.now() - 90_000).toISOString();
  return {
    timestamp: at,
    cpu: { usage: 7, usageStatus: "available", usageUpdatedAt: at, model: "AMD Ryzen 5 5600", cores: 6, speed: 3.5, temperature: null, temperatureStatus: "unavailable" },
    ram: { usagePercent: 51, usedGb: 15.8, totalGb: 30.9, usageStatus: "available", ...overrides.ram },
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
    },
    network: { rxSec: 0, txSec: 0 },
    gpu: null,
    battery: { status: "absent", percent: null, isCharging: false, timeRemaining: null },
    stressScore: 0,
    stressContributions: { cpu: 0, ram: 0, temperature: 0, gpu: 0 },
    alerts: [],
    topProcessesByRam: [],
  } as unknown as HardwareSnapshot;
}

function render(hardware: HardwareSnapshot): string {
  return renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(PCCenterPage as never, { hardware, pcState: null, dataOrigin: "LIVE" } as never),
    ),
  );
}

test("PC Center renderiza em Node/SSR (sem import.meta.env) e sem atributos de trace", () => {
  const html = render(snapshot());
  assert.doesNotMatch(html, /data-cs-/, "sem Vite env não há trace DEV-only no DOM");
  assert.match(html, /51%/, "RAM com leitura válida é apresentada");
});

test("snapshot legado (sem usageStatus): estado NÃO CONFIRMADO, nunca 0%", () => {
  const html = render(snapshot({ ram: { usageStatus: undefined, usagePercent: 42, usedGb: 12, totalGb: 30 } }));
  assert.match(html, /Não confirmado/, "a RAM legada não é apresentada como medição");
  assert.doesNotMatch(html, />0%</, "não há 0% cego");
});
