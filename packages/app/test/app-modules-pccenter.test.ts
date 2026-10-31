/**
 * TP-APP-MODULES-FREEBUFF-20261024 — PC Center.
 *
 * O defeito humano era «stress0» ao lado de «Windows BOM»: eixos diferentes,
 * mas a UI usava o stress (que soma zero quando não há leitura) para declarar
 * «Sistema Saudável» quando o serviço ainda não tinha entregado o PcState.
 * Estes testes fixam a regra: o título «Achados do sistema» só recebe veredicto
 * do serviço; sem leitura, diz que não há leitura. E um índice de stress sem
 * nenhuma entrada medida não se apresenta como 0 medido.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HardwareSnapshot, PcState } from "@cybersafe/shared-types";
import PCCenterPage from "../src/pages/PCCenterPage";

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const at = new Date(Date.now() - 90_000).toISOString();

function snapshot(overrides: {
  cpu?: Record<string, unknown>;
  ram?: Record<string, unknown>;
} = {}): HardwareSnapshot {
  return {
    timestamp: at,
    cpu: {
      usage: 0,
      usageStatus: "unavailable",
      usageUpdatedAt: at,
      model: "AMD Ryzen 5 5600",
      cores: 6,
      speed: 3.5,
      temperature: null,
      temperatureStatus: "unavailable",
      ...overrides.cpu,
    },
    ram: {
      usagePercent: null,
      usedGb: null,
      totalGb: null,
      usageStatus: "unavailable",
      ...overrides.ram,
    },
    disk: {
      readStatus: "unavailable",
      reason: "Sem leitura do volume.",
      lastGoodAt: null,
      volumes: [],
      primary: null,
      usagePercent: null,
      usedGb: null,
      totalGb: null,
      fsType: "NTFS",
    },
    network: { rxSec: 0, txSec: 0, readStatus: "unavailable", interfaceName: "" },
    battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null, status: "absent" },
    gpu: null,
    topProcessesByCpu: [],
    topProcessesByRam: [],
    stressScore: 0,
    stressContributions: { cpu: 0, ram: 0, temperature: 0, gpu: 0 },
    alerts: [],
  } as unknown as HardwareSnapshot;
}

const pcStateBom: PcState = {
  overall: "good",
  security: "good",
  performance: "good",
  system: "good",
  privacy: "good",
  counts: { urgent: 0, attention: 0, recommended: 0 },
  findings: [],
} as unknown as PcState;

const texto = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const render = (hardware: HardwareSnapshot, pcState: PcState | null) =>
  renderToStaticMarkup(createElement(PCCenterPage, { hardware, pcState, dataOrigin: "LIVE" }));

describe("PC Center — veredicto sem PcState", () => {
  test("sem PcState e sem leituras não declara «Sistema Saudável»", () => {
    const t = texto(render(snapshot(), null));
    assert.doesNotMatch(t, /Sistema Saudável/, "stress 0 por ausência não é um veredicto de saúde");
    assert.match(t, /Estado dos achados indisponível/i);
    assert.match(t, /ainda não devolveu uma avaliação/i);
  });

  test("sem PcState, o índice de stress sem entradas medidas mostra —/100", () => {
    const t = texto(render(snapshot(), null));
    assert.match(t, /—\/100/, "0/100 seria uma medição que não existe");
    assert.doesNotMatch(t, /0\/100/, "0/100 com CPU/RAM/temperatura sem leitura é inventado");
  });

  test("com CPU medida, um stress 0 real continua a ser 0/100", () => {
    const t = texto(render(snapshot({ cpu: { usage: 0, usageStatus: "available" } }), null));
    assert.match(t, /0\/100/, "0 medido é um valor válido");
    assert.doesNotMatch(t, /—\/100/);
  });

  test("com PcState do serviço, o veredicto é o do serviço", () => {
    const t = texto(render(snapshot(), pcStateBom));
    assert.match(t, /Sistema Saudável/);
    assert.match(t, /Achados do sistema/);
  });
});
