import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiskSnapshot, HardwareSnapshot } from "@cybersafe/shared-types";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: PCCenterPage } = await import("../src/pages/PCCenterPage");

const C_VOLUME = {
  mount: "C:",
  fileSystem: "NTFS",
  totalGb: 476.9,
  usedGb: 425,
  freeGb: 51.9,
  usagePercent: 89.1,
  kind: "working" as const,
  readOnly: false,
};

const DISK: DiskSnapshot = {
  readStatus: "ok",
  reason: null,
  lastGoodAt: "2026-10-10T13:00:00.000Z",
  volumes: [C_VOLUME],
  primary: C_VOLUME,
  usagePercent: 89.1,
  usedGb: 425,
  totalGb: 476.9,
  fsType: "NTFS",
};

/** Snapshot com o MESMO estado medido neste PC (sem sensor térmico seguro). */
function snapshot(temperature: number | null): HardwareSnapshot {
  return {
    cpu: {
      usage: 7,
      model: "AMD Ryzen 5 5600",
      cores: 6,
      speed: 3.5,
      temperature,
      temperatureStatus: temperature === null ? "unavailable" : "available",
    },
    ram: { usagePercent: 51, usedGb: 15.8, totalGb: 30.9 },
    disk: DISK,
    network: { rxSec: 1024, txSec: 512, interfaceName: "Ethernet" },
    battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null },
    gpu: {
      usagePercent: null,
      vramTotalMb: 6128,
      vramUsedMb: null,
      temperature: null,
      model: "AMD Radeon RX 5600 XT",
      temperatureStatus: "unavailable",
    },
    system: { uptime: 3600, platform: "win32", osVersion: "10.0.26300", hostname: "PC" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    stressScore: 0,
    stressContributions: { cpu: 0, ram: 0, temperature: 0, gpu: 0 },
    alerts: [],
    timestamp: "2026-10-10T13:00:00.000Z",
  } as unknown as HardwareSnapshot;
}

const render = (temperature: number | null) =>
  renderToStaticMarkup(createElement(PCCenterPage, { hardware: snapshot(temperature) }));

/**
 * Regressão do FAIL humano de 2026-10-10: o índice mostrava "0/100" com a
 * temperatura em "A recolher dados...". O 0 do índice era aritmética correta
 * (CPU 7% < 75 e RAM 51% < 70 não somam pontos), mas a linha "Temperatura 0"
 * lia-se como "medi e não há stress térmico" — uma afirmação que ninguém mediu.
 * Sem sensor, a contribuição tem de aparecer como não medida.
 */
describe("PC Center — falta de temperatura não vira medição térmica", () => {
  test("sem temperatura: a contribuição térmica é 's/ leitura', não 0", () => {
    const html = render(null);
    assert.match(html, /s\/ leitura/, "a contribuição térmica diz que não foi medida");
    assert.match(html, /não é medida neste PC/, "a legenda explica porque não entra no índice");
    assert.doesNotMatch(
      html,
      /CPU \+ RAM \+ Temperatura/,
      "sem sensor não se afirma que a temperatura entra no índice",
    );
  });

  test("com temperatura medida: o valor entra e a legenda volta ao normal", () => {
    const html = render(65);
    assert.doesNotMatch(html, /Temperatura \(s\/ leitura\)/, "a temperatura medida não é rotulada como não medida");
    assert.match(html, /CPU \+ RAM \+ Temperatura/);
  });

  test("a secção de saúde do Windows tem prazo duro (nunca 'a carregar' para sempre)", () => {
    // Guarda de regressão ao nível da fonte: o `await` direto ao bridge foi o que
    // deixou o `finally`/`setLoading(false)` inalcançável quando o pedido não
    // respondia. A leitura tem de passar por `withDeadline`.
    const src = readFileSync(new URL("../src/components/PCHealthSection.tsx", import.meta.url), "utf8");
    assert.match(src, /withDeadline\(/, "a leitura de saúde corre sob prazo");
    assert.doesNotMatch(
      src,
      /await window\.electronAPI\.getWindowsHealth\(\)/,
      "sem prazo duro, um pedido pendurado gira para sempre",
    );
    assert.match(src, /setReadError\(/, "o insucesso termina num estado honesto");
  });
});
