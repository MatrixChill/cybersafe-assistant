import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, HardwareSnapshot } from "@cybersafe/shared-types";

// Render real como nos outros testes da app (sem DOM, sem Electron).
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: DashboardPage } = await import("../src/pages/DashboardPage");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ler = (...p: string[]) => fs.readFileSync(path.join(HERE, ...p), "utf8");
const css = ler("..", "src", "index.css");
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");
const settings = ler("..", "src", "pages", "SettingsPage.tsx");

const volume = (mount: string, totalGb: number, usedGb: number, kind = "working") => ({
  mount, fileSystem: "NTFS", totalGb, usedGb, freeGb: totalGb - usedGb,
  usagePercent: Math.round((usedGb / totalGb) * 1000) / 10, kind, readOnly: false,
});

const DISCO_OK = {
  readStatus: "ok", reason: null, lastGoodAt: new Date().toISOString(),
  volumes: [volume("C:", 953, 846), volume("D:", 2000, 400), volume("E:", 100, 30, "system-reserved")],
  primary: volume("C:", 953, 846), usagePercent: 88, usedGb: 846, totalGb: 953, fsType: "NTFS",
};

const snapshot = (disk: unknown): HardwareSnapshot => ({
  cpu: { usage: 12, model: "", cores: 8, speed: 0, temperature: null },
  ram: { usagePercent: 44, usedGb: 7, totalGb: 16 },
  disk, network: { rxSec: 0, txSec: 0 }, gpu: null, alerts: [], timestamp: new Date().toISOString(),
}) as unknown as HardwareSnapshot;

const render = (hardware: HardwareSnapshot) =>
  renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(DashboardPage, {
    dashboard: {
      totalEvents: 0, highSeverityEvents: 0, downloadRisk: "low", recentThreats: [], alerts: [],
      systemStatus: "safe", riskScore: 78,
    } as unknown as DashboardSummary,
    isLoading: false, hardware,
    // CONFIRMADO pelo root: o App passa sempre a leitura do tempo real. Sem
    // enabled:true a pagina responde "Monitorização não verificada" — correta,
    // mas nao e o caminho que estes testes fixam (protegido/motivos dos motores).
    realtime: { disponivel: true, enabled: true },
  })));

describe("R4-L2 1 — a pontuação aparece com o sujeito escrito", () => {
  test("«Pontuação de proteção» + valor + teto, e o porquê do nível", () => {
    const html = render(snapshot(DISCO_OK));
    assert.match(html, /<h3>Pontuação de proteção<\/h3>/);
    // Migração V2-FIRST: o valor vem com a frase de proveniência colada
    // (`78/100. Indicador de risco observado.`), não dentro de um `<span>` do
    // medidor de V1. Número e denominador são os mesmos.
    assert.match(html, /78\/100\. Indicador de risco observado/);
    assert.match(html, /Motores sem leitura: o teto não se calcula/, "sem engines medidos, a legenda diz o facto: o teto não se calcula");
    // O porquê continua a vir por palavra, não por cor — extraído do markup,
    // não adivinhado por regex composta.
    const h2 = /<h2[^>]*>([^<]+)<\/h2>/.exec(html)?.[1]?.trim() ?? "";
    assert.ok(
      ["A consultar a proteção…", "Monitorização não verificada", "Monitorização em pausa", "Monitorização desligada", "Proteção com limitações", "Ligação não confirmada", "Monitorização ligada"].includes(h2),
      `o herói não mostrou um veredicto conhecido: "${h2}"`,
    );
    const razao = /<\/h2><p>([^<]+)<\/p>/.exec(html)?.[1]?.trim() ?? "";
    assert.ok(razao.length >= 20, `o nível vem sem razão escrita: "${razao}"`);
    assert.doesNotMatch(razao, /graus?|%/, "a razão do nível não é uma cor nem um número emprestado");
  });

  test("a secção de uso chama-se «Leituras do computador» (não colide com o estado do PC)", () => {
    const html = render(snapshot(DISCO_OK));
    assert.match(html, /<h3>Leituras do computador<\/h3>/);
    assert.equal(html.includes(">A usar agora<"), false, "o título de V1 não coexiste com o do lab");
    assert.match(html, /<h3>Estado do PC<\/h3>/, "as duas medidas continuam com nomes diferentes");
  });
});

describe("R4-L2 2 — cartão de disco por volume, com escolha", () => {
  test("a unidade do sistema é a detetada, não uma letra assumida", () => {
    const html = render(snapshot(DISCO_OK));
    // Migração V2-FIRST: o cartão de disco de V1 (com `<span>` por volume e
    // «953 GB no total») saiu; o diagnóstico escreve a letra que o motor
    // apontou, com o espaço livre e a percentagem medidos.
    assert.match(html, /<h3>Disco<\/h3><p>Medido agora<\/p>/, "diz o estado da leitura");
    assert.match(html, /<p>C: · [0-9.,]+ GB livres · 88,8% usado<\/p>/);
    // Prova de que não é literal: com o motor a apontar outro volume, a linha
    // muda de unidade.
    const doutro = {
      ...DISCO_OK,
      primary: volume("D:", 2000, 400),
      usagePercent: 20,
      usedGb: 400,
      totalGb: 2000,
    };
    const htmlD = render(snapshot(doutro));
    assert.match(htmlD, /<p>D: · [0-9.,]+ GB livres · 20,0% usado<\/p>/);
    assert.equal(htmlD.includes("<p>C: · "), false, "C: não é a resposta por defeito");
  });

  test("mais do que um volume de trabalho dá seletor; um só não dá", () => {
    const dois = render(snapshot(DISCO_OK));
    // O nome acessível vem do `<label>` que envolve o `<select>` — não de um
    // `aria-label` colado ao controlo.
    assert.match(dois, /<label>Volume de trabalho<select[^>]*>/);
    assert.match(dois, /<option value="C:"[^>]*>/);
    assert.match(dois, /<option value="D:"[^>]*>/);
    const umSo = { ...DISCO_OK, volumes: [DISCO_OK.volumes[0]] };
    const soUm = render(snapshot(umSo));
    assert.equal(soUm.includes("Volume de trabalho"), false, "um seletor para uma opção é ruído");
  });

  test("partições de sistema não se escolhem, e isso é dito", () => {
    const html = render(snapshot(DISCO_OK));
    assert.equal(/<option value="E:">/.test(html), false, "E: (system-reserved) não é escolha");
    assert.match(html, /Partições reservadas do sistema não são volumes de trabalho e não se escolhem\./);
    // O número mostrado é do volume escolhido, nunca de um agregado.
    assert.match(html, /<p>C: · [0-9.,]+ GB livres · 88,8% usado<\/p>/);
  });

  test("sem leitura não há número inventado", () => {
    const semLeitura = {
      readStatus: "unavailable", reason: "cim.dll indisponível", lastGoodAt: null, volumes: [],
      primary: null, usagePercent: null, usedGb: null, totalGb: null, fsType: "",
    };
    const html = render(snapshot(semLeitura));
    assert.doesNotMatch(html, /\d+ GB livres/, "sem leitura não há espaço livre");
    assert.match(html, /Indisponível|Sem leitura/, "o estado diz o que falhou");
  });
});

describe("R4-L2 3 — vidro em qualquer tema, não só no Líquido", () => {
  test("o vidro dá transparência própria às superficies elevadas", () => {
    // Causa real nos temas de `--card` opaco: sem isto o backdrop-filter não
    // tinha nada por trás e Vidro == Sólido.
    assert.match(decls, /\[data-surface="glass"\]\.dark \.stat-card \{\s*background-color: color-mix\(in oklch, var\(--card\) \d+%, transparent\);/);
    assert.match(decls, /\[data-surface="glass"\]\.dark \.sidebar-surface \{\s*background-color: color-mix\(in oklch, var\(--sidebar\) \d+%, transparent\);/);
    assert.match(decls, /\[data-surface="glass"\]:not\(\.dark\) \.stat-card/);
  });

  test("reduzido e sólido não recebem essa transparência nova", () => {
    assert.equal(decls.includes('[data-surface="reduced"].dark .stat-card'), false);
    // O único achatamento continua a ser o do sólido.
    const solido = decls.slice(decls.indexOf('[data-surface="solid"].dark .cyber-border'));
    assert.match(solido.slice(0, 700), /background-color: var\(--background\)/);
  });

  test("o vidro não converte as superficies repetidas em vidro", () => {
    assert.equal(/\.cyber-border[^{]*\{[^}]*background-color: color-mix\(in oklch, var\(--card\)/.test(decls), false,
      "~90 instâncias por ecrã: a camada de conteúdo não vira vidro");
  });
});

describe("R4-L2 4 — o preview acompanha quem ajusta", () => {
  test("os três grupos estão na coluna dos controlos, a amostra na outra", () => {
    const tema = settings.indexOf(">Tema base<");
    const material = settings.indexOf(">Material da interface<");
    const destaque = settings.indexOf(">Cor de destaque<");
    const aside = settings.indexOf("<aside");
    assert.ok(tema >= 0 && material > tema && destaque > material, "ordem dos três grupos");
    assert.ok(aside > destaque, "a amostra vem depois dos três, em coluna própria");
  });

  test("amostra sem position:fixed e sem sair do fluxo (R6-L5)", () => {
    assert.equal(/position:\s*fixed|fixed inset-0/.test(settings), false, "nada cobre a página");
  });

  test("em janela de definições usa coluna única no fluxo da página (R6-L5)", () => {
    assert.match(settings, /grid grid-cols-1 gap-6 items-start/);
  });
});
