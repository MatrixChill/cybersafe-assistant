/**
 * PC Center — gráficos de evolução (uso e temperatura ao longo do tempo).
 *
 * O que este ficheiro fixa, e porque:
 *
 *  1. O PC Center consome os buffers que a aquisição central já enche em
 *     `App.tsx`. Uma página que volte a perguntar ao Windows a mesma métrica é
 *     exatamente o desperdício que o objetivo proíbe; e se alguma vez o nome de
 *     um canal for alterado num lado e não no outro, o gráfico não rebenta —
 *     fica silenciosamente vazio. A comparação dos nomes é a única coisa que
 *     apanha esse erro.
 *  2. Sem amostras, o gráfico declara o estado («A recolher dados…») e não
 *     desenha linha nem ponto. Uma linha a zero pareceria uma medição.
 *  3. O histórico térmico diz «Sem leitura de temperatura», não «sem dados
 *     genéricos» e não «sensor inexistente»: afirma a ausência de leitura, que
 *     é o que se sabe.
 *  4. Sem GPU presente não há gráfico da GPU. Um cartão decorativo de uma
 *     funcionalidade que a máquina não tem é o oposto do que se pede.
 *
 * LIMITES DECLARADOS: não há DOM nem jsdom no package, por isso
 * `renderToStaticMarkup` não corre efeitos. Prova-se por render o estado
 * inicial e a presença/ausência de desenho; o `unavailableLabel` (que só
 * aparece após o prazo, dentro de `useEffect`) prova-se pela estrutura. O
 * aspeto real em ecrã, o `aria-live` e a cadência visual ficam para o teste
 * humano. As séries abaixo são FIXTURES, não leituras desta máquina.
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
import { AdvancedView } from "../src/pages/PCCenterPage";
import { addTelemetrySample, getTelemetrySamples } from "../src/components/TelemetrySparkline";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Os ficheiros estão em CRLF no working tree; os regex precisam de uma só forma de linha. */
const lf = (texto: string) => texto.replace(/\r\n/g, "\n");
const read = (...parts: string[]) => lf(fs.readFileSync(path.join(HERE, "..", ...parts), "utf8"));

const app = read("src", "App.tsx");
const pagina = read("src", "pages", "PCCenterPage.tsx");

/** Canais que o PC Center mostra. `net-*` ficam no Dashboard. */
const CANAIS = ["cpu", "cpu-temp", "ram", "gpu", "gpu-temp"] as const;

const tracos = (source: string, re: RegExp) =>
  [...source.matchAll(re)].map((m) => m[1]).sort();

/** A assinatura do traço do sparkline: os ícones lucide usam `stroke-width="2"`. */
const LINHA = 'stroke-width="1.5"';
/** O ponto da última amostra; `r` é 2.5 só aqui. */
const PONTO = 'r="2.5"';

function snapshot(comGpu: boolean): HardwareSnapshot {
  const at = new Date(Date.now() - 1_000).toISOString();
  return {
    timestamp: at,
    cpu: {
      usage: 42,
      usageStatus: "available",
      usageUpdatedAt: at,
      model: "AMD Ryzen 9 7900X",
      cores: 12,
      speed: 4.7,
      temperature: comGpu ? 71 : 71,
      temperatureStatus: "available",
    },
    ram: { usagePercent: 55, usedGb: 8.8, totalGb: 16, usageStatus: "available", updatedAt: at },
    disk: {
      readStatus: "available",
      reason: null,
      lastGoodAt: at,
      volumes: [],
      primary: null,
      usagePercent: 60,
      usedGb: 300,
      totalGb: 500,
      fsType: "NTFS",
    },
    network: { rxSec: 120, txSec: 40, readStatus: "available", interfaceName: "Ethernet" },
    battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null, status: "absent" },
    gpu: comGpu
      ? {
          available: true,
          model: "AMD Radeon RX 5600 XT",
          usagePercent: 37,
          temperature: 61,
          temperatureSensor: "GPU Core",
          temperatureSource: "ADL",
          temperatureStatus: "available",
          vramTotalMb: 6144,
          vramUsedMb: 2048,
        }
      : null,
    system: { uptime: 1000, platform: "win32", osVersion: "10", hostname: "TEST" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    stressScore: 40,
    stressContributions: { cpu: 15, ram: 15, temperature: 10, gpu: 0 },
    alerts: [],
  } as unknown as HardwareSnapshot;
}

function limpar() {
  for (const canal of CANAIS) getTelemetrySamples(canal).length = 0;
}

const render = (comGpu = true) =>
  renderToStaticMarkup(createElement(AdvancedView, { hardware: snapshot(comGpu), batteryOrigin: "LIVE" }));

describe("PC Center — evolução temporal", () => {
  test("os canais lidos existem na aquisição central (nem um gráfico silenciosamente vazio)", () => {
    const escritos = tracos(app, /addTelemetrySample\(\s*"([^"]+)"/g);
    const lidos = tracos(pagina, /useTelemetryHistory\(\s*"([^"]+)"/g);
    assert.deepEqual(lidos, [...CANAIS].sort(), "o PC Center mostra exatamente estes canais");
    for (const canal of lidos) {
      assert.ok(escritos.includes(canal), `canal «${canal}» é lido mas ninguém o escreve`);
    }
  });

  test("sem amostras: cada gráfico diz que está a recolher e não desenha linha nem ponto", () => {
    limpar();
    const html = render();
    assert.equal((html.match(/role="img"/g) ?? []).length, CANAIS.length);
    // Contamos o texto DESENHADO: a mesma frase vive também em `aria-label` e
    // `<title>`, e somar as três fontes daria um número que ninguém vê.
    assert.equal((html.match(/<text[^>]*>A recolher dados/g) ?? []).length, CANAIS.length);
    assert.ok(!html.includes(LINHA), "linha desenhada sem histórico seria uma medição inventada");
    assert.ok(!html.includes(PONTO), "ponto atual sem amostra não existe");
    // O nome acessível transporta o estado, não só a métrica.
    assert.match(html, /aria-label="Histórico de utilização da CPU: A recolher dados\.\.\."/);
  });

  test("com amostras: linha e ponto atual aparecem e o nome acessível fica só com a métrica", () => {
    limpar();
    for (const canal of CANAIS) for (const v of [10, 20, 30]) addTelemetrySample(canal, v);
    const html = render();
    assert.equal((html.match(new RegExp(LINHA, "g")) ?? []).length, CANAIS.length);
    assert.equal((html.match(new RegExp(PONTO, "g")) ?? []).length, CANAIS.length);
    assert.ok(!html.includes("A recolher dados"), "com histórico o estado de espera desaparece");
    assert.match(html, /aria-label="Histórico de utilização da CPU"[^>]*><title>Histórico de utilização da CPU<\/title>/);
  });

  test("a temperatura sem leitura tem rótulo próprio, não genérico nem falsa ausência de sensor", () => {
    const proprios = pagina.match(/unavailableLabel="([^"]+)"/g) ?? [];
    assert.equal(proprios.length, 2, "os dois gráficos térmicos (CPU e GPU) trazem rótulo próprio");
    for (const atributo of proprios) {
      assert.match(atributo, /Sem leitura de temperatura/);
      // «Sensor indisponível»/«sem sensor» diria mais do que se sabe: ausência de
      // leitura não é prova de que o hardware não tem sensor.
      assert.doesNotMatch(atributo, /sem sensor/i);
    }
  });

  test("sem GPU presente não há gráfico da GPU", () => {
    limpar();
    const html = render(false);
    assert.ok(!html.includes("Histórico de utilização da GPU"), "cartão decorativo de funcionalidade inexistente");
    assert.ok(!html.includes("Histórico da temperatura da GPU"));
    assert.equal((html.match(/role="img"/g) ?? []).length, CANAIS.length - 2);
  });
});
