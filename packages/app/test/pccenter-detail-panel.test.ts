/**
 * PC Center — painel de detalhe medido.
 *
 * A aquisição do serviço passou a medir coisas que nenhum cartão mostrava:
 * utilização por processador lógico, frequência atual vs. referência,
 * compromisso e ficheiro de paginação, módulos de RAM, adaptadores por
 * interface e estado do adaptador de alimentação. Um número medido e não
 * mostrado é meio desperdício; mostrado como `0` é pior do que escondido.
 *
 * Este ficheiro fixa as duas metades:
 *  · com leitura, o valor aparece com a unidade e o estado certos;
 *  · sem leitura, aparece a palavra do estado — nunca `0 %`, `0 GHz`, `0 GB`,
 *    nem uma saúde inventada — e as origens derivadas dizem que o são.
 *
 * FIXTURES: os números abaixo são de teste, não leituras desta máquina.
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

const GIB = 1024 ** 3;

/** Nada medido além do estranho ao painel: sem núcleo, sem frequência, sem energia. */
const SEM_LEITURA = {
  timestamp: "2026-10-26T12:00:00.000Z",
  cpu: { usage: 0, usageStatus: "unavailable", model: "AMD Ryzen 9 7900X", cores: 12, speed: 0, temperature: null, temperatureStatus: "unavailable" },
  ram: { usagePercent: null, usedGb: null, totalGb: null, usageStatus: "unavailable" },
  network: { rxSec: 0, txSec: 0, interfaceName: "", readStatus: "unavailable", adapters: [] },
  battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null },
  gpu: null,
  system: { uptime: 1, platform: "win32", osVersion: "10", hostname: "TEST" },
  topProcessesByCpu: [],
  topProcessesByRam: [],
  stressScore: 0,
  alerts: [],
} as unknown as HardwareSnapshot;

/** Tudo o que o contrato consegue trazer medido ao mesmo tempo. */
const MEDIDO = {
  ...SEM_LEITURA,
  cpu: {
    ...SEM_LEITURA.cpu,
    usage: 42,
    usageStatus: "available",
    speed: 4.7,
    logicalCores: 24,
    physicalCores: 12,
    perCoreUpdatedAt: "2026-10-26T12:00:00.000Z",
    frequency: {
      currentMHz: 5_450,
      referenceMHz: 4_700,
      measuredAsCurrent: true,
      status: "available",
      source: "PDH Processor Information",
    },
    perCore: [
      { index: 0, percent: 80, status: "available" },
      { index: 1, percent: null, status: "unsupported" },
    ],
  },
  ram: {
    ...SEM_LEITURA.ram,
    usagePercent: 55,
    usedGb: 8.8,
    totalGb: 16,
    usageStatus: "available",
    availableGb: 7.2,
    reservedGb: 3.1,
    reservedIsDerived: true,
    commit: { usedBytes: 11 * GIB, limitBytes: 26 * GIB, availableBytes: 15 * GIB, status: "available", source: "kernel32" },
    pagefile: { totalBytes: 10 * GIB, usedBytes: 2 * GIB, totalIsDerived: true, status: "available", source: "kernel32" },
    layout: {
      modules: [
        { bank: "DIMM 0", capacityBytes: 16 * GIB, type: "DDR5", speedMHz: 5600, manufacturer: "Corsair", partNumber: "CMK32" },
      ],
      slotsOccupied: 2,
      slotsTotal: 4,
      status: "available",
      source: "Win32_PhysicalMemory",
    },
  },
  network: {
    ...SEM_LEITURA.network,
    adapters: [
      {
        iface: "eth0",
        label: "Realtek PCIe GbE",
        kind: "wired",
        operstate: "up",
        speedMbps: 1000,
        ip4: "192.168.1.20",
        mac: "AA:BB:CC:DD:EE:FF",
        rxBytesTotal: 10_000,
        txBytesTotal: 20_000,
        rxBytesPerSec: 1_250_000,
        txBytesPerSec: null,
        status: "available",
      },
    ],
  },
  power: { acLine: "on", hasBattery: false, isCharging: null, batteryPercent: null, remainingMinutes: null, batteryLow: false, status: "available", source: "kernel32" },
  battery: { ...SEM_LEITURA.battery, healthStatus: "absent", healthDetail: "Máquina de secretária sem bateria." },
} as unknown as HardwareSnapshot;

const texto = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const render = (hardware: HardwareSnapshot, mostrarBateria = true) =>
  texto(renderToStaticMarkup(createElement(HardwareDetailPanel, { hardware, mostrarBateria })));

describe("PC Center — painel de detalhe medido", () => {
  test("o painel está montado dentro da vista detalhada", () => {
    assert.match(pagina, /<HardwareDetailPanel hardware=\{hardware\} mostrarBateria=\{batteryCardVisible\} \/>/);
    assert.match(pagina, /data-testid="hardware-detail-surface"/);
  });

  test("com leitura: núcleos, frequência, compromisso, paginação, módulos, adaptador e energia", () => {
    const t = render(MEDIDO);
    assert.match(t, /Processadores lógicos 24/);
    assert.match(t, /Núcleos físicos 12/);
    // 5 450 MHz → "5,45 GHz"; 4 700 → "4,7 GHz" (pt-PT, vírgula decimal).
    assert.match(t, /Frequência atual 5,45 GHz/);
    assert.match(t, /Frequência de referência 4,7 GHz Fonte: PDH/);
    assert.match(t, /por processador lógico \(2\)/);
    assert.match(t, /Compromisso \(Em utilização \/ Limite\) 11 GB \/ 26 GB/);
    assert.match(t, /paginação 2 GB usados de 10 GB/);
    assert.match(t, /O total é derivado do limite de compromisso/);
    assert.match(t, /Disponível 7,2 GB/);
    assert.match(t, /Reservada pelo sistema 3,1 GB/);
    assert.match(t, /Derivada de total − disponível − em uso/);
    assert.match(t, /Slots ocupados 2 de 4/);
    assert.match(t, /DIMM 0 · Corsair 16 GB · 5600 MT\/s · DDR5/);
    assert.match(t, /Realtek PCIe GbE wired estado: up ligação: 1 Gb\/s receção: 10 Mb\/s/);
    assert.match(t, /Ligado à corrente/);
    assert.match(t, /Sem bateria — computador de secretária/);
  });

  test("núcleo sem leitura não recebe barra nem 0 %; o estado escreve-se por letras", () => {
    const t = render(MEDIDO);
    // `percent: null` com status `unsupported`: a palavra é o valor.
    assert.match(t, /não suportado/);
    const html = renderToStaticMarkup(createElement(HardwareDetailPanel, { hardware: MEDIDO, mostrarBateria: true }));
    // Uma só barra desenhada (o núcleo medido); o outro não tem largura nenhuma.
    assert.equal((html.match(/width: 80%|width:80%/g) ?? []).length, 1);
    assert.ok(!/width: 0%|width:0%/.test(html), "largura 0 seria um núcleo medido a 0 %");
  });

  test("taxa de envio sem segunda amostra diz que não há amostras, não 0", () => {
    const t = render(MEDIDO);
    assert.match(t, /envio: sem duas amostras/);
    assert.doesNotMatch(t, /envio: 0/);
  });

  test("sem qualquer leitura: palavras de estado e nenhum zero inventado", () => {
    const t = render(SEM_LEITURA);
    assert.match(t, /Utilização por núcleo sem leitura por núcleo/);
    assert.match(t, /Frequência atual sem leitura de frequência/);
    assert.match(t, /Adaptadores sem leitura dos adaptadores/);
    assert.match(t, /Adaptador de alimentação sem leitura de energia/);
    assert.match(t, /Bateria sem leitura do kernel/);
    assert.match(t, /saúde não verificada/);
    assert.doesNotMatch(t, /0 GHz|0,0 GHz/, "frequência a zero seria uma medição");
    assert.doesNotMatch(t, /0 GB/, "0 GB seria capacidade medida");
    assert.doesNotMatch(t, /Sem bateria — computador de secretária/, "ausência de leitura não prova que não há bateria");
  });

  test("com o cartão da bateria escondido, o painel também não fala da bateria", () => {
    const escondida = render(SEM_LEITURA, false);
    assert.match(escondida, /Adaptador de alimentação sem leitura de energia/, "a fonte de energia não é um indicador de bateria");
    assert.doesNotMatch(escondida, /Bateria/, "o painel não pode reavivar o indicador que o cartão escondeu");
    assert.doesNotMatch(escondida, /Capacidade \/ desgaste \/ ciclos/);
  });

  test("pagefile com só uma das metades medida diz qual falta", () => {
    const meio = {
      ...MEDIDO,
      ram: {
        ...MEDIDO.ram,
        pagefile: { totalBytes: 16 * GIB, usedBytes: null, status: "available", source: "kernel32" },
      },
    } as unknown as HardwareSnapshot;
    const t = render(meio);
    assert.match(t, /utilização sem leitura · total 16 GB/);
    assert.doesNotMatch(t, /— usados/, "um traço dentro de «usados» faria crer que a utilização foi medida");
  });

  test("utilização de RAM nunca é apresentada como saúde", () => {
    const t = render(MEDIDO);
    assert.match(t, /Utilização não é saúde/);
    assert.doesNotMatch(t, /saude \d+%|saúde \d+%/);
  });

  test("a frequência que o OS devolve é nominal, e isso é dito", () => {
    const nominal = {
      ...MEDIDO,
      cpu: { ...MEDIDO.cpu, frequency: { ...MEDIDO.cpu.frequency, measuredAsCurrent: false } },
    } as unknown as HardwareSnapshot;
    const t = render(nominal);
    assert.match(t, /é o nominal declarado pelo OS, não uma contagem/);
  });
});
