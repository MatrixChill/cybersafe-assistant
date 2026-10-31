import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, EngineHealth, HardwareSnapshot } from "@cybersafe/shared-types";

/**
 * TP-V2-VISUAL (qoder) — contrato da COMPOSIÇÃO do Dashboard V2.
 *
 * Fixa o que um redesign do hero não pode partir, sem amarrar markup cosmético:
 *  - `section.hero-banner` existe e o seu `data-material` segue a preferência de
 *    superfície guardada (o eixo de material é independente do estado do sistema);
 *  - a pontuação é EXPLICADA (rótulo "Pontuação de proteção", motores ativos, teto,
 *    penalização por ameaças) — não é um número solto;
 *  - a faixa de evidência (`evidence-strip`) mostra de onde vem cada facto;
 *  - honestidade do tempo real: sem leitura de `enabled`, NUNCA se afirma
 *    "Monitorização ligada" — diz "não verificada";
 *  - telemetria hierárquica: CPU e RAM lideram a secção "A usar agora".
 *
 * Capturas reais (BEFORE/AFTER) ficam em output/design-evolution-v2-20261017.
 */

const ENGINE = {
  serviceRunning: true,
  anyEngineDegraded: false,
  degradedReasons: [],
  yara: { status: "active", detail: "ok" },
  hashDb: { status: "active", detail: "ok" },
  clamav: { status: "active", detail: "ok" },
  nativeEngine: { status: "active" },
  wfp: { status: "active" },
  definitionsUpdatedAt: "2026-10-17T00:00:00.000Z",
  monitoredPaths: ["C:/Users/x/Documents", "C:/Users/x/Downloads"],
  realtimeQueueDepth: 0,
} as unknown as EngineHealth;

const resumo = (extra: Partial<DashboardSummary> = {}) =>
  ({
    riskScore: 86,
    totalEvents: 18,
    highSeverityEvents: 1,
    downloadRisk: "low",
    recentThreats: [{ domain: "exemplo.invalid", severity: "high", createdAt: "2026-10-17T00:00:00.000Z" }],
    alerts: [],
    systemStatus: "attention",
    engineHealth: ENGINE,
    ...extra,
  }) as unknown as DashboardSummary;

const HARDWARE = {
  cpu: { usage: 23, model: "CPU genérica", temperature: 52 },
  ram: { usagePercent: 41, usedGb: 6.6, totalGb: 16 },
  gpu: { usage: 12, model: "GPU genérica", temperature: 47, vramUsedMb: 1000, vramTotalMb: 8000 },
  disk: {
    primary: { mount: "C:", kind: "system-reserved" },
    volumes: [
      { mount: "C:", kind: "working", usagePercent: 41, usedGb: 210, totalGb: 512, freeGb: 302 },
    ],
  },
  network: { rxSec: 14200, txSec: 3000, interfaceName: "Adaptador" },
  alerts: [],
} as unknown as HardwareSnapshot;

/** localStorage falso com um valor de superfície controlável por teste. */
function withSurface(surface: string | null) {
  const store: Record<string, string> = { theme: "dark", cybersafe_surface: surface ?? "glass" };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  (globalThis as Record<string, unknown>).React = React;
}

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: DashboardPage } = await import("../src/pages/DashboardPage");

function render(props: Record<string, unknown>, surface: string | null = "glass") {
  withSurface(surface);
  return renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(DashboardPage, { dashboard: resumo(), isLoading: false, hardware: HARDWARE, ...props } as never),
    ),
  );
}

// Migração V2-FIRST: o componente que se vê é a composição do lab; o
// `DashboardPage` ficou a ser só o contentor de dados.
const dashboardSource = readFileSync(new URL("../src/v2/dashboard/LabDashboard.tsx", import.meta.url), "utf8");

describe("Dashboard V2 — o herói é o do lab, e o estado não se confunde com a matéria", () => {
  it("o hero mostra a luz de apresentação do tema sem escrever o eixo de V1", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } }, "solid");
    assert.match(html, /class="aurora-backdrop"|class="static-aurora"/, "a luz de apresentação do lab tem de existir");
    assert.match(html, /class="[^"]*protection-hero/, "o herói de proteção está onde o lab o põe");
    assert.doesNotMatch(html, /data-material=/, "o eixo de V1 não se escreve no Painel");
    // O acabamento vem das tokens do tema (`--v2-hero`), nunca de um literal por
    // material dentro do componente.
    assert.doesNotMatch(dashboardSource, /background:\s*#|linear-gradient\(#/, "cor literal no componente");
  });

  it("a superfície lida pelo componente vem do contexto, não de estado próprio", () => {
    assert.match(dashboardSource, /useAppearance\(\)/, "o Painel lê o contexto de aparência");
    assert.doesNotMatch(dashboardSource, /useState<[^>]*material/, "o Painel não tem um segundo estado de matéria");
    assert.match(dashboardSource, /data-reduced=/, "o que o componente escreve é o estado de movimento, uma vez");
  });
});

describe("Dashboard V2 — pontuação explicada, não número solto", () => {
  it("rotula o que é medido e mostra motores ativos + teto", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    assert.match(html, /Pontuação de proteção/);
    assert.match(html, /de 4 motores ativos · máximo possível/);
    assert.ok(html.includes("/100"), "o denominador acompanha o número");
  });

  it("a penalização por ameaças aparece quando há ameaças graves", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    assert.match(html, /−\d+ por ameaças/, "a explicação da nota deve mostrar a penalização real");
  });
});

describe("Dashboard V2 — estrutura ORIGINAL do lab, eixo de matéria num só sítio", () => {
  /**
   * Migração V2-FIRST (mapa: `out/MAPA-TESTES-V2-FIRST.md`). O `section.hero-
   * banner` com `data-material` era geometria de V1 e saiu por decisão
   * explícita. O que se cobra agora é (a) a composição do laboratório, na ordem
   * em que o lab a escreve, e (b) que o eixo de matéria não voltou a ser
   * escrito nó-a-nó dentro do Painel — foi assim que `[data-material="solid"]`
   * global de `index.css` passou a pintar o contentor do Dashboard.
   */
  it("a página abre com PageHead, depois dashboard-top (hero + última análise), motores, dashboard-bottom", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    const ordem = [
      /<h1[^>]*>O essencial, sob controlo\./,
      /class="dashboard-top"/,
      /class="[^"]*\bprotection-hero\b/,
      /class="hero-copy"/,
      /class="[^"]*\blast-scan\b/,
      /data-testid="engine-grid"/,
      /class="dashboard-bottom"/,
    ];
    let cursor = -1;
    for (const re of ordem) {
      const m = re.exec(html.slice(cursor + 1));
      assert.ok(m, `faltou ou saiu de ordem: ${re}`);
      cursor += m.index + 1;
    }
    // O título do hero é `h2` (hierarquia do lab); o `h1` é um só por rota.
    assert.equal((html.match(/<h1[^>]*>/g) ?? []).length, 1, "dois h1 na mesma rota");
    assert.match(html, /class="hero-copy"[\s\S]{0,400}<h2>/);
  });

  it("a matéria vem do eixo do documento, não de um atributo escrito no Painel", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } }, "solid");
    assert.doesNotMatch(html, /data-material=/, "o atributo de eixo de V1 voltou ao markup");
    assert.doesNotMatch(html, /data-surface=/, "o atributo de superfície de V1 voltou ao markup");
    assert.doesNotMatch(dashboardSource, /backdrop-blur-|surface-translucent/, "desfoque ou superfície hardcoded no componente");
    assert.match(dashboardSource, /useAppearance\(\)/, "o componente continua a ler o contexto de aparência");
    assert.doesNotMatch(dashboardSource, /data-material=\{/, "nenhum nó do Painel se anuncia como dono do eixo");
  });
});

describe("Dashboard V2 — proveniência dos factos lidos", () => {
  /**
   * A `evidence-strip` de cinco caixas saiu com V1. Os factos que ela mostrava
   * não desaparecem: `Motores` e `Tempo real` continuam à vista no hero e no
   * diagnóstico; `Definições`, `Caminhos` e `Fila` pertencem ao detalhe técnico
   * (`ProtectionDetails`), que tem testes próprios. Cobrar aqui os cinco rótulos
   * seria cobrar a geometria, não a verdade — por isso a asserção mudou de
   * alvo, não de sentido.
   */
  it("o hero diz de onde vem a contagem e o diagnóstico diz o tempo real", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    // Sem `serviceConnected` confirmado a legenda diz isso mesmo; com ligação,
    // diz de onde vem o número. As duas formas são as únicas permitidas.
    assert.match(
      html,
      /<span class="caption">\s*(Relatório do serviço · \d+ de 4 sem degradação reportada|Motores sem leitura)\s*<\/span>/,
    );
    assert.match(html, /Proteção em tempo real: /);
    assert.doesNotMatch(html, /data-testid="evidence-strip"|class="surface-lift/, "a faixa de cinco caixas não volta");
  });

  it("o detalhe técnico continua a ser o mesmo componente, não uma cópia", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    assert.match(html, /Explorar motores/, "a porta para o detalhe técnico está na página");
    assert.doesNotMatch(html, /Cobertura integral|todo o sistema/, "nenhum resumo local ao detalhe afirma o que o detalhe não mede");
  });
});

describe("Dashboard V2 — honestidade do tempo real", () => {
  it("sem leitura de enabled não afirma 'Monitorização ligada'; diz 'não verificada'", () => {
    const html = render({ realtime: { disponivel: true } });
    assert.equal(html.includes("Monitorização ligada"), false, "nunca afirmar ligado sem leitura");
    assert.match(html, /Monitorização não verificada/);
  });

  it("com enabled lido a true, o chip usa o veredicto do nível (não o rótulo de pausa)", () => {
    const html = render({ realtime: { disponivel: true, enabled: true } });
    assert.equal(html.includes("Monitorização não verificada"), false);
  });
});

describe("Dashboard V2 — telemetria hierárquica", () => {
  it("as leituras do computador lideram com CPU e RAM, por essa ordem", () => {
    const html = render({ realtime: { disponivel: true, enabled: true }, pcState: null });
    const inicio = html.indexOf("Leituras do computador");
    assert.ok(inicio >= 0, "falta o título das leituras medidas");
    const bloco = html.slice(inicio, inicio + 900);
    const cpu = bloco.indexOf("<dt>CPU</dt>");
    const ram = bloco.indexOf("<dt>RAM</dt>");
    assert.ok(cpu >= 0 && ram > cpu, "CPU abre a lista e RAM vem a seguir");
    assert.ok(bloco.includes("<dt>GPU</dt>") && bloco.includes("<dt>Rede</dt>"), "GPU e rede continuam na mesma lista");
    assert.equal(html.includes("A usar agora"), false, "o título de V1 não coexiste com o do lab");
  });
});
