import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, EngineHealth, Finding, PcState } from "@cybersafe/shared-types";

// Render real como em scanner-page-render.test.ts: `tsx` compila JSX com o
// runtime clássico e é esse global que o satisfaz fora do Vite.
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: DashboardPage, PcStateAttention } = await import("../src/pages/DashboardPage");

const ler = (ficha: string) => readFileSync(new URL(`../src/${ficha}`, import.meta.url), "utf8");
const dashboardSource = ler("pages/DashboardPage.tsx");
const detailsSource = ler("components/ProtectionDetails.tsx");
const controlSource = ler("components/ProtectionControl.tsx");
const healthSource = ler("components/PCHealthSection.tsx");

/** Motor medido nesta máquina (clamav sem base, WFP não iniciado). */
const ENGINE = {
  serviceRunning: true,
  anyEngineDegraded: true,
  degradedReasons: ["ClamAV: degraded", "Filtro WFP: unavailable"],
  yara: { status: "active", detail: "Loaded 1 rule(s) from file", coverage: "limited" },
  hashDb: { status: "active", detail: "Loaded 4 signature(s)" },
  clamav: { status: "degraded", detail: "sem base de assinaturas" },
  nativeEngine: { status: "active" },
  wfp: { status: "unavailable", detail: "WFP filter not started" },
} as unknown as EngineHealth;

const findingDe = (overrides: Partial<Finding> = {}): Finding => ({
  id: "security:engine-unavailable",
  category: "security",
  severity: "attention",
  title: "Proteção parcialmente indisponível",
  summary: "2 componentes de proteção precisam de atenção.",
  source: "protection-engine",
  firstSeen: "2026-10-11T08:00:00.000Z",
  lastSeen: "2026-10-11T08:20:00.000Z",
  actionable: false,
  ...overrides,
});

const pcStateDe = (overrides: Partial<PcState> = {}): PcState => ({
  overall: "attention",
  security: "attention",
  performance: "good",
  privacy: "good",
  system: "good",
  findings: [findingDe()],
  counts: { urgent: 0, attention: 1, recommended: 2, informative: 1 },
  principalFinding: findingDe(),
  generatedAt: "2026-10-11T08:20:00.000Z",
  ...overrides,
});

const resumo = (extra: Partial<DashboardSummary> = {}) =>
  ({
    riskScore: 68,
    totalEvents: 3,
    highSeverityEvents: 0,
    downloadRisk: "low",
    recentThreats: [],
    alerts: [],
    systemStatus: "attention",
    engineHealth: ENGINE,
    ...extra,
  }) as unknown as DashboardSummary;

const renderDashboard = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(DashboardPage, { dashboard: resumo(), isLoading: false, ...props } as never),
    ),
  );

const renderAtencao = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(PcStateAttention, props as never));

describe("R3-C 1 — hierarquia: pergunta, resposta e DUAS medidas separadas", () => {
  test("a pergunta está no topo e o veredicto de proteção responde-lhe", () => {
    // O App real passa SEMPRE a leitura do tempo real à página. Sem
    // `enabled: true` o DashboardPage faz bem o que lhe cabe — responder
    // "Monitorização não verificada" em vez do veredicto de nivel —, mas nao
    // e esse o caminho que este teste fixa. A fixture espelha o wiring real.
    const html = renderDashboard({ pcState: null, realtime: { disponivel: true, enabled: true } });
    const pergunta = html.indexOf("O meu computador está bem?");
    assert.ok(pergunta >= 0, "a pergunta do utilizador tem de ser o título");
    // Com `systemStatus: attention` e motores degradados, o nível derivado é
    // `degraded` — e a resposta do produto a esse nível é "A meio.".
    assert.ok(html.indexOf("A meio.") > pergunta, "a resposta vem a seguir à pergunta");
  });

  test("a nota é identificada como PONTUAÇÃO DE PROTEÇÃO, não como um número solto", () => {
    const html = renderDashboard({ pcState: pcStateDe() });
    // R4/L2 pediu o círculo em contexto explícito: a etiqueta diz o que é medido.
    assert.match(html, />Pontuação de proteção</);
    assert.ok(html.includes("/100"), "o denominador acompanha o número");
    // Proveniência declarada no título do número, para ninguém somar o que não soma.
    assert.ok(html.includes("Nota de proteção: 100 menos o risco efetivo"));
  });

  test("o estado do PC é um bloco à parte, com palavra própria e SEM número emprestado", () => {
    const html = renderDashboard({ pcState: pcStateDe() });
    const inicio = html.indexOf("Estado do PC");
    assert.ok(inicio >= 0, "o segundo eixo tem de aparecer identificado");
    assert.match(html.slice(inicio, inicio + 400), /Atenção/, "o veredicto do motor de estado");
    // A nota de proteção não pode aparecer dentro deste bloco.
    assert.equal(html.slice(inicio).includes("/100"), false, "o /100 pertence ao bloco da proteção");
  });

  test("motor de estado sem leitura diz 'Sem leitura', nunca 'Estável'", () => {
    const html = renderDashboard({ pcState: pcStateDe({ overall: "unknown" }) });
    assert.match(html, /Estado do PC[\s\S]{0,220}Sem leitura/);
  });
});

describe("R3-C 2 e 5 — problema principal compacto, ação real, detalhe colapsado", () => {
  test("o detalhe técnico vive dentro de <details> e vem depois da linha principal", () => {
    const html = renderAtencao({ pcState: pcStateDe(), engine: ENGINE });
    const titulo = html.indexOf("Proteção parcialmente indisponível");
    const summary = html.indexOf("<details");
    assert.ok(titulo >= 0 && summary > titulo, "título primeiro, detalhe depois");
    assert.match(html, /<summary[^>]*>Detalhe técnico<\/summary>/);
    // O Dado não desaparece: está dentro do <details>, não à vista por defeito.
    const dentro = html.slice(summary);
    assert.match(dentro, /ClamAV: Degradado/, "a linha medida continua acessível");
    assert.ok(dentro.indexOf("ClamAV: Degradado") > 0);
    assert.equal(html.slice(0, summary).includes("ClamAV: Degradado"), false, "e não está aberto por defeito");
  });

  test("proteção desligada com contrato real: oferece 'Ativar proteção'", () => {
    const html = renderAtencao({
      pcState: pcStateDe(),
      realtime: { disponivel: true, enabled: false },
      onSetProtection: () => {},
      serviceConnected: true,
    });
    assert.match(html, /<button[^>]*>[^<]*Ativar proteção[^<]*<\/button>/);
    // A oferta é verde (ação disponível), não mais vermelho em cima do aviso.
    assert.match(html, /class="[^"]*border-cyber-green\/40[^"]*"[^>]*>\s*Ativar proteção/);
  });

  test("sem leitura do tempo real NÃO há botão: não se oferece o que não se sabe", () => {
    const html = renderAtencao({
      pcState: pcStateDe(),
      onSetProtection: () => {},
      serviceConnected: true,
    });
    assert.equal(html.includes("Ativar proteção"), false, "ausência de dado não é convite à ação");
  });

  test("proteção ativa: nada de botão de ativação (o problema principal não é esse)", () => {
    const html = renderAtencao({
      pcState: pcStateDe(),
      realtime: { disponivel: true, enabled: true },
      onSetProtection: () => {},
      serviceConnected: true,
    });
    assert.equal(html.includes("Ativar proteção"), false);
  });

  test("sem serviço ligado ou com pedido em voo, o botão não aparece (não é decorativo)", () => {
    for (const contexto of [
      { serviceConnected: false },
      { serviceConnected: true, protectionPending: "starting" },
      { serviceConnected: null },
    ]) {
      const html = renderAtencao({
        pcState: pcStateDe(),
        realtime: { disponivel: true, enabled: false },
        onSetProtection: () => {},
        ...contexto,
      });
      assert.equal(html.includes("Ativar proteção"), false, JSON.stringify(contexto));
    }
  });

  test("pausa real oferece retomar, não 'ativar'", () => {
    const html = renderAtencao({
      pcState: pcStateDe(),
      realtime: { disponivel: true, enabled: true, pausedUntil: "2026-10-11T09:00:00.000Z" },
      onSetProtection: () => {},
      serviceConnected: true,
    });
    assert.match(html, /Retomar proteção agora/);
    assert.equal(html.includes(">Ativar proteção<"), false);
  });

  test("a contagem da secção vem de pcState.counts, a UI não conta nada", () => {
    const html = renderDashboard({
      pcState: pcStateDe({ counts: { urgent: 1, attention: 3, recommended: 2, informative: 0 } }),
    });
    assert.match(html, /1 agora · 3 problema\(s\)/);
    assert.match(dashboardSource, /pcState\.counts\.urgent\} agora/);
    assert.equal(/findings\.filter\([\s\S]{0,80}\)\.length\s*[>½]/.test(dashboardSource), false);
  });
});

describe("R3-C 6 e 8 — métricas reais, legíveis, sem texto minúsculo", () => {
  test("nenhum dos ficheiros do Painel usa texto abaixo de 12px", () => {
    for (const [nome, src] of [
      ["DashboardPage", dashboardSource],
      ["ProtectionDetails", detailsSource],
      ["ProtectionControl", controlSource],
      ["PCHealthSection", healthSource],
    ] as const) {
      assert.doesNotMatch(src, /text-\[(9|10|11)px\]/, `${nome} tem texto abaixo de 12px`);
    }
  });

  test("CPU, RAM, disco, rede e proteção continuam todos presentes", () => {
    const html = renderDashboard({
      pcState: pcStateDe(),
      hardware: {
        cpu: { usage: 12, model: "" },
        ram: { usagePercent: 44, usedGb: 7, totalGb: 16 },
        disk: { usagePercent: 60, primary: { totalGb: 500, usedGb: 300 }, volumes: [] },
        network: { rxSec: 512_000, txSec: 20_000, interfaceName: "Ethernet" },
        alerts: [],
      },
    });
    for (const etiqueta of ["CPU", "RAM", "Disco", "Rede", "Proteção"]) {
      assert.ok(html.includes(etiqueta), `falta a métrica ${etiqueta}`);
    }
  });

  test("rede mostra tráfego por segundo e NÃO uma percentagem inventada", () => {
    const html = renderDashboard({
      hardware: {
        cpu: { usage: 12, model: "" },
        ram: { usagePercent: 44, usedGb: 7, totalGb: 16 },
        disk: { usagePercent: 60, primary: { totalGb: 500, usedGb: 300 }, volumes: [] },
        network: { rxSec: 512_000, txSec: 20_000, interfaceName: "Ethernet" },
        alerts: [],
      },
    });
    assert.match(html, /500,\d KB\/s/);
    assert.match(html, /Barra relativa: corresponde a 10 MB\/s no máximo/);
    // O parâmetro que alimenta a barra não pode ser o texto mostrado.
    assert.match(dashboardSource, /label="Rede" valueText=\{[^}]*formatThroughput/);
  });

  test("os quatro números de atividade identificam a fonte no title", () => {
    const html = renderDashboard({ pcState: pcStateDe() });
    assert.match(html, /Contagem do serviço de proteção desde que arrancou/);
    assert.match(html, /não é uma média/);
  });

  test("Melhorias conta a prioridade certa; a conflação com todos os achados saiu", () => {
    const html = renderDashboard({
      pcState: pcStateDe({ counts: { urgent: 0, attention: 1, recommended: 5, informative: 9 } }),
    });
    assert.match(html, />Melhorias</);
    assert.match(html, />5</);
    assert.equal(html.includes("Recomendações"), false, "a palavra antiga contava findings.length");
    assert.equal(dashboardSource.includes("Recomendações"), false);
    assert.match(dashboardSource, /counts\.recommended/);
  });
});

describe("R3-C 3, 4 e 9 — honestidade e contraste", () => {
  test("motor indisponível não afirma Windows desprotegido", () => {
    const html = renderAtencao({ pcState: pcStateDe(), engine: ENGINE });
    assert.match(html, /Isto não significa que o Firewall do Windows esteja desligado/);
    assert.equal(/todo o (Windows|PC) está desprotegido/i.test(html), false, "não se afirma o que não foi medido");
  });

  test("serviço do Windows parado: a frase diz a limitação do tipo de arranque", () => {
    assert.match(healthSource, /"service-down": "[\s\S]{0,400}arranque manual/);
    assert.equal(healthSource.includes("Funções como impressão"), false, "a frase antiga afirmava falha");
  });

  test("as duas notas têm nomes diferentes nos dois sítios", () => {
    assert.match(healthSource, />\s*Saúde do PC\s*</);
    assert.match(detailsSource, /nota de proteção é \{score\}\/100/);
    assert.equal(healthSource.includes(">Score<"), false, "a etiqueta crua 'Score' confundia as duas medidas");
  });

  test("nenhuma superficie do Painel usa cor crua white", () => {
    for (const src of [dashboardSource, detailsSource]) {
      assert.doesNotMatch(src, /bg-white\/|border-white\//, "superfície fora dos tokens");
    }
  });
});
