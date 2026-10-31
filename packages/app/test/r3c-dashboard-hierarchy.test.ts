import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, EngineHealth, Finding, PcState } from "@cybersafe/shared-types";

/**
 * R3-C — hierarquia, duas medidas e honestidade do Painel.
 *
 * MIGRAÇÃO V2-FIRST (TP V2-FIRST-TEST-MIGRATION, qoder, apenas testes). O alvo
 * deixou de ser o `DashboardPage` de V1 (que foi substituído pelo contentor de
 * dados + `LabDashboard`) e passou a ser a composição original do laboratório
 * mais o componente de diagnóstico que guarda as letras do produto:
 *   - cabeçalho/hero/grelha  -> `src/v2/dashboard/LabDashboard.tsx`
 *   - nota, estado do PC, Dado, leituras, disco -> `src/v2/dashboard/LabDiagnostics.tsx`
 *   - botão de proteção      -> `src/components/ProtectionControl.tsx` (o dono real)
 *   - disclaimer do Windows  -> `src/components/ProtectionDetails.tsx`
 * As asserções que eram GEOMETRIA DE V1 (título «O meu computador está bem?»,
 * tooltips `title=` dos números de atividade, barra relativa de rede com
 * «Barra relativa: corresponde a 10 MB/s no máximo», `label="Rede" valueText=`)
 * saíram por decisão explícita do proprietário; o mapa teste→requisito está em
 * `out/MAPA-TESTES-V2-FIRST.md`. Nenhuma delas era caso de verdade: o que cada
 * uma protegia (fonte da contagem, tráfego em KB/s, prioridade certa) foi
 * re-asseverado contra o markup V2.
 */

// Ver o comentário em scanner-page-render.test.ts: o `tsx` compila JSX com o
// runtime clássico e é este global que o satisfaz fora do Vite.
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: LabDashboard } = await import("../src/v2/dashboard/LabDashboard");
const ProtectionControl = (await import("../src/components/ProtectionControl")).default;
const ProtectionDetails = (await import("../src/components/ProtectionDetails")).default;

const ler = (ficha: string) => readFileSync(new URL(`../src/${ficha}`, import.meta.url), "utf8");
const diagnosticsSource = ler("v2/dashboard/LabDiagnostics.tsx");
const dashboardSource = ler("v2/dashboard/LabDashboard.tsx");
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
  // O bloco Dado só existe com evidência medida: sem `evidence`, o derivador
  // devolve `dado: []` e a UI não pode inventar linha nenhuma.
  evidence: { engine: "ClamAV, Filtro WFP do CyberSafe", engineStatus: "degraded, unavailable" },
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

const HARDWARE = {
  cpu: { usage: 12, model: "" },
  ram: { usagePercent: 44, usedGb: 7, totalGb: 16 },
  gpu: { usagePercent: 30, model: "", vramUsedMb: 0, vramTotalMb: 6144 },
  disk: {
    usagePercent: 60,
    primary: { mount: "C:", kind: "working", totalGb: 500, usedGb: 300, freeGb: 200, usagePercent: 60 },
    volumes: [
      { mount: "C:", kind: "working", totalGb: 500, usedGb: 300, freeGb: 200, usagePercent: 60 },
      { mount: "D:", kind: "working", totalGb: 1000, usedGb: 400, freeGb: 600, usagePercent: 40 },
      { mount: "E:", kind: "system-reserved", totalGb: 3, usedGb: 1, freeGb: 2, usagePercent: 30 },
    ],
  },
  network: { rxSec: 512_000, txSec: 20_000, interfaceName: "Ethernet" },
  alerts: [],
} as never;

/**
 * `history` é leitura confirmada do serviço; sem ele a página mostra o estado
 * de consulta, o que não interessa a estes casos. FIXA-SE o estado, não se
 * simula a bridge.
 */
const historyPronta = { phase: "pronto", entry: null } as never;

const renderDashboard = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(LabDashboard as never, {
        dashboard: resumo(),
        isLoading: false,
        history: historyPronta,
        // Fixture de dados confirmados ⇒ ligação confirmada (regra do TP).
        serviceConnected: true,
        realtime: { disponivel: true, enabled: true, pausedUntil: null },
        ...props,
      } as never),
    ),
  );

const renderControl = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(ProtectionControl as never, {
      pending: null,
      connected: true,
      onSet: () => {},
      onPause: () => {},
      ...props,
    } as never),
  );

describe("R3-C 1 — hierarquia original do lab: cabeçalho, resposta e DUAS medidas", () => {
  test("a rota abre com um único h1 no cabeçalho e o veredicto responde-lhe a seguir", () => {
    const html = renderDashboard({ pcState: null });
    const h1s = html.match(/<h1[^>]*>/g) ?? [];
    assert.equal(h1s.length, 1, `esperava um h1 por rota, vi ${h1s.length}`);
    const cabecalho = html.indexOf("O essencial, sob controlo.");
    assert.ok(cabecalho >= 0, "o cabeçalho do lab tem de abrir a página");
    // No lab o título do hero é `h2` (a hierarquia pedida na revisão D3-a).
    const heroi = html.indexOf('<div class="hero-copy">');
    assert.ok(heroi > cabecalho, "o hero vem depois do cabeçalho");
    assert.match(html.slice(heroi, heroi + 1200), /<h2[^>]*>Proteção com limitações<\/h2>/, "a resposta ao nível medido");
    assert.equal(html.includes("O meu computador está bem?"), false, "o título de V1 não volta");
  });

  test("a nota é identificada como Pontuação de proteção, não como número solto", () => {
    const html = renderDashboard({ pcState: pcStateDe() });
    assert.match(html, /<h3>Pontuação de proteção<\/h3>/);
    assert.match(html, /68\/100/, "o denominador acompanha o número");
    // Proveniência declarada junto ao número, para ninguém somar o que não soma.
    assert.match(html, /Indicador de risco observado\. Não confirma cobertura completa\./);
  });

  test("o estado do PC é uma secção à parte, com palavra própria e SEM número emprestado", () => {
    const html = renderDashboard({ pcState: pcStateDe() });
    const inicio = html.indexOf("<h3>Estado do PC</h3>");
    assert.ok(inicio >= 0, "o segundo eixo tem de aparecer identificado");
    const fim = html.indexOf("<section", inicio);
    const bloco = html.slice(inicio, fim < 0 ? html.length : fim);
    assert.match(bloco, /Atenção/, "o veredicto do motor de estado");
    assert.equal(bloco.includes("/100"), false, "o /100 pertence à secção da proteção");
  });

  test("motor de estado sem leitura diz 'Sem leitura', nunca 'Estável'", () => {
    const html = renderDashboard({ pcState: pcStateDe({ overall: "unknown" }) });
    assert.match(html, /<h3>Estado do PC<\/h3><p>Sem leitura<\/p>/);
    assert.equal(/<h3>Estado do PC<\/h3><p>Estável/.test(html), false);
  });
});

describe("R3-C 2 e 5 — detalhe colapsado, Dado acessível, ação só com contrato", () => {
  test("o detalhe técnico vive dentro de <details> e o Dado está lá dentro, não aberto por defeito", () => {
    const html = renderDashboard({ pcState: pcStateDe() });
    const abre = html.indexOf('<details class="dashboard-diagnostics"');
    assert.ok(abre >= 0, "o diagnóstico tem de ser colapsável");
    const summary = html.indexOf("<summary", abre);
    assert.ok(summary > abre && summary < abre + 200, "summary logo após o <details>");
    const dentro = html.slice(abre);
    assert.match(dentro, /<h4>Dado<\/h4>/, "a linha medida continua acessível");
    assert.match(dentro, /Estado do componente: Degradado, Indisponível\./, "nomes + estados PT-PT");
    for (const proibido of ["(degraded)", "(unavailable)", "Loaded 1 rule(s)", "WFP filter not started", "C:\\"]) {
      assert.equal(dentro.includes(proibido), false, `Dado não pode mostrar o token cru: ${proibido}`);
    }
    assert.equal(html.slice(0, abre).includes("<h4>Dado</h4>"), false, "e não está aberto por defeito");
  });

  test("proteção desligada com contrato real: oferece 'Ativar proteção'", () => {
    const html = renderControl({
      realtime: { disponivel: true, enabled: false },
      onSet: () => {},
      connected: true,
    });
    assert.match(html, /<button[^>]*>[^<]*Ativar proteção/);
  });

  test("sem leitura do tempo real NÃO há botão: não se oferece o que não se sabe", () => {
    assert.equal(renderControl({ realtime: undefined, onSet: () => {}, connected: true }).includes("Ativar proteção"), false, "ausência de dado não é convite à ação");
    assert.equal(renderControl({ realtime: {}, onSet: () => {}, connected: true }).includes("Ativar proteção"), false);
  });

  test("proteção ativa: nada de botão de ativação (o problema principal não é esse)", () => {
    const html = renderControl({ realtime: { disponivel: true, enabled: true }, onSet: () => {}, connected: true });
    assert.equal(html.includes("Ativar proteção"), false);
  });

  test("sem serviço ligado ou com pedido em voo, a ação não é decorativa", () => {
    // A regra é a do dono do controlo: sem ligação a oferta existe mas nasce
    // `disabled` (e diz porquê); com pedido em voo o botão mostra o pedido, não
    // uma segunda promessa. Verificar `disabled` no elemento, não as classes.
    const botaoDeAtivar = (html: string) =>
      html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Ativar proteção(?:(?!<\/button>)[\s\S])*?<\/button>/);

    for (const contexto of [{ connected: false }, { connected: null }]) {
      const html = renderControl({ realtime: { disponivel: true, enabled: false }, onSet: () => {}, ...contexto });
      const botao = botaoDeAtivar(html);
      if (botao) {
        assert.match(botao[0], /disabled/, `sem ligação confirmada a ação tem de estar desativada: ${JSON.stringify(contexto)}`);
      } else {
        assert.equal(html.includes("Ativar proteção"), false, JSON.stringify(contexto));
      }
      if (contexto.connected === false) assert.match(html, /Serviço indisponível — sem ações/);
    }

    const emVoo = renderControl({ realtime: { disponivel: true, enabled: false }, pending: "starting", onSet: () => {}, connected: true });
    assert.equal(emVoo.includes(">Ativar proteção<"), false, "com pedido em voo não há duas promessas no mesmo sítio");
    assert.match(emVoo, /A ativar/i);
  });

  test("pausa real oferece retomar, não 'ativar'", () => {
    const html = renderControl({
      realtime: { disponivel: true, enabled: true, pausedUntil: "2026-10-11T09:00:00.000Z" },
      onSet: () => {},
      connected: true,
    });
    assert.match(html, /Retomar proteção agora/);
    assert.equal(html.includes(">Ativar proteção"), false);
  });

  test("o Dashboard mantém pending e erro FORA do modal (fechar o modal não apaga o estado)", () => {
    const html = renderDashboard({ protectionPending: "starting" });
    assert.match(html, /Pedido de proteção em curso\./);
    const comErro = renderDashboard({ protectionError: "O serviço não confirmou a mudança de estado." });
    assert.match(comErro, /Não foi possível aplicar:/);
    assert.match(comErro, /role="alert"/);
    const modalAbre = comErro.indexOf('<div class="modal');
    assert.ok(modalAbre < 0 || comErro.indexOf("Não foi possível aplicar:") < modalAbre, "o aviso vive na página, não no modal");
  });

  test("a contagem da secção vem de pcState.counts, a UI não conta nada", () => {
    const html = renderDashboard({
      pcState: pcStateDe({ counts: { urgent: 1, attention: 3, recommended: 2, informative: 0 } }),
    });
    assert.match(html, /1 agora · 3 problema\(s\)/);
    assert.match(diagnosticsSource, /pcState\.counts\.urgent\} agora/, "a string é montada a partir da contagem do serviço");
    assert.equal(/findings\.filter\([\s\S]{0,80}\)\.length\s*[>½]/.test(diagnosticsSource), false, "nada de contar achados por cima");
  });
});

describe("R3-C 6 e 8 — métricas reais, legíveis, sem texto minúsculo nos fontes", () => {
  test("nenhum dos fontes do Painel usa texto abaixo de 12px", () => {
    for (const [nome, src] of [
      ["LabDashboard", dashboardSource],
      ["LabDiagnostics", diagnosticsSource],
      ["ProtectionDetails", detailsSource],
      ["ProtectionControl", controlSource],
      ["PCHealthSection", healthSource],
    ] as const) {
      assert.doesNotMatch(src, /text-\[(9|10|11)px\]/, `${nome} tem texto abaixo de 12px`);
    }
  });

  test("CPU, RAM, GPU, disco, rede e proteção continuam todos presentes", () => {
    const html = renderDashboard({ pcState: pcStateDe(), hardware: HARDWARE });
    for (const etiqueta of ["<dt>CPU</dt>", "<dt>RAM</dt>", "<dt>GPU</dt>", "<dt>Rede</dt>", "<h3>Disco</h3>", "Pontuação de proteção"]) {
      assert.ok(html.includes(etiqueta), `falta a métrica ${etiqueta}`);
    }
  });

  test("rede mostra tráfego por segundo e NÃO uma percentagem inventada", () => {
    const html = renderDashboard({ hardware: HARDWARE });
    const rede = /<dt>Rede<\/dt><dd>([^<]*)/.exec(html);
    assert.ok(rede, "a linha de rede tem de existir");
    assert.match(rede[1], /500 KB\/s/, "512000 B/s lê-se 500 KB/s");
    assert.equal(rede[1].includes("%"), false, "tráfego não é percentagem");
    assert.match(diagnosticsSource, /networkReadingDisplay/, "a leitura vem do helper canónico");
    assert.equal(diagnosticsSource.includes("formatThroughput"), false, "a barra de V1 com teto fixo em 10 MB/s não volta");
  });

  test("a proveniência da grelha de motores é o relatório do serviço, e diz quando não há relatório", () => {
    const comLeitura = renderDashboard({});
    const capa = /Relatório do serviço · (\d+) de 4 sem degradação reportada/.exec(comLeitura);
    assert.ok(capa, "a legenda do hero declara de onde vem a contagem");
    // A moeda é a mesma da grelha: o número da caption são os cartões cuyo
    // rótulo medido é «Ativo» — não uma segunda contagem feita à parte.
    const ativosNaGrelha = (comLeitura.match(/>Ativo</g) ?? []).length;
    assert.equal(Number(capa![1]), ativosNaGrelha, `caption diz ${capa![1]}, a grelha mostra ${ativosNaGrelha}`);
    const semLeitura = renderDashboard({ dashboard: resumo({ engineHealth: undefined }) });
    assert.match(semLeitura, /Motores sem leitura/);
    assert.equal(/Relatório do serviço · \d de 4/.test(semLeitura), false, "sem leitura não se conta saúde");
  });

  test("Melhorias conta a prioridade certa; a conflação com todos os achados saiu", () => {
    const html = renderDashboard({
      pcState: pcStateDe({ counts: { urgent: 0, attention: 1, recommended: 5, informative: 9 } }),
    });
    assert.match(html, /Melhorias: 5/);
    assert.equal(html.includes("Recomendações"), false, "a palavra antiga contava findings.length");
    assert.equal(dashboardSource.includes("Recomendações"), false);
    assert.match(diagnosticsSource, /counts\.recommended/);
  });
});

describe("R3-C 3, 4 e 9 — honestidade e contraste", () => {
  test("motor indisponível não afirma Windows desprotegido", () => {
    const detalhe = renderToStaticMarkup(
      createElement(ProtectionDetails as never, { engine: ENGINE, level: "degraded", open: true, onClose: () => {}, score: 68 }),
    );
    assert.match(detalhe, /Isto não significa que o Firewall do Windows esteja desligado/);
    const painel = renderDashboard({ pcState: pcStateDe(), hardware: HARDWARE });
    for (const html of [detalhe, painel]) {
      assert.equal(/todo o (Windows|PC) está desprotegido/i.test(html), false, "não se afirma o que não foi medido");
    }
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

  test("nenhuma superfície do Painel usa cor crua white", () => {
    for (const src of [dashboardSource, diagnosticsSource, detailsSource]) {
      assert.doesNotMatch(src, /bg-white\/|border-white\//, "superfície fora dos tokens");
    }
  });
});
