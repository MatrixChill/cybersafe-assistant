import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** O JSX pode partir expressões em várias linhas; o que se trava é a forma. */
const compact = (texto: string) => texto.replace(/\s+/g, " ");
const SIDEBAR = read("../src/components/Sidebar.tsx");
const TITLEBAR = read("../src/components/AppTitleBar.tsx");
// Migração V2-FIRST: o `DashboardPage` de V1 passou a contentor de dados; o
// Painel que se vê é `LabDashboard` + a folha de primitivas V2.
const PAINEL = compact(read("../src/v2/dashboard/LabDashboard.tsx"));
const FOLHA = read("../src/v2/primitives.css").replace(/\/\*[\s\S]*?\*\//g, "");
const CSS = read("../src/index.css");

// Andaime de render do Painel (o mesmo de `dashboard-engine-gate`).
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: LabDashboardRender } = await import("../src/v2/dashboard/LabDashboard");

const renderPainel = (engineHealth: EngineHealth) =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(LabDashboardRender as never, {
        dashboard: {
          riskScore: 70, totalEvents: 0, highSeverityEvents: 0, downloadRisk: "low",
          recentThreats: [], alerts: [], systemStatus: "attention", engineHealth,
        } as unknown as DashboardSummary,
        isLoading: false,
        serviceConnected: true,
        history: { phase: "pronto", entry: null },
      } as never),
    ),
  );

test("a marca aparece uma vez: titlebar grande, sidebar só com o monograma", () => {
  assert.match(TITLEBAR, /className="app-titlebar-name">CyberSafe/, "a titlebar continua a ser a marca principal");
  assert.doesNotMatch(
    SIDEBAR,
    /CYBER<span[^>]*>SAFE/,
    "o wordmark visual repetido na sidebar não pode voltar",
  );
  assert.match(SIDEBAR, /sr-only">CyberSafe — Assistente de segurança/, "o nome acessível perdeu-se");
  assert.doesNotMatch(SIDEBAR, /Assistente de segurança<\/span>\s*<\/div>/, "o subtítulo truncado voltou");

  // Alvo REAL (migração V2-FIRST): a barra que o App monta agora é
  // `v2/LabSidebar`. O contrato de marca é o mesmo — monograma + nome dito uma
  // só vez, em voz acessível — e verifica-se onde vive.
  const VIVA = compact(read("../src/v2/LabSidebar.tsx"));
  assert.match(VIVA, /aria-label=\{?"CyberSafe/, "a barra viva tem de nomear a marca para leitor de ecrã");
  assert.doesNotMatch(VIVA, /CyberSafe<[^>]*>\s*CyberSafe/, "o wordmark visual repetido voltou à barra");
  assert.doesNotMatch(VIVA, /<h1/, "a barra não é título de página");
});

test("a titlebar mantém o contrato nativo e ganha a ponte com o conteúdo", () => {
  assert.doesNotMatch(TITLEBAR, /<button/, "botões de janela próprios não podem voltar");
  assert.match(TITLEBAR, /-webkit-app-region/, "o arrasto nativo é do CSS; o componente não o remove");
  assert.match(TITLEBAR, /data-titlebar-fade/, "falta a transição visual para o conteúdo");
  assert.match(TITLEBAR, /pointer-events-none/, "a ponte não pode roubar cliques à faixa");
});

test("o estado usa cor de estado, nunca a cor da identidade", () => {
  // O aro de V1 (`hero-risk-gradient` + `scoreTone`) saiu por decisão explícita
  // do proprietário. A obrigação de ONDE a cor vem mantém-se e passa a ser
  // verificada no sítio onde o estado é hoje pintado: os cartões de motor e a
  // folha de primitivas V2.
  assert.match(
    PAINEL,
    /e\.state === "ACTIVE" \? "ok" : e\.state === "DEGRADED" \? "warn" : e\.state === "ERROR" \? "crit" : "na"/,
    "o tom do cartão vem do estado medido",
  );
  assert.doesNotMatch(PAINEL, /hero-risk-gradient|scoreTone/, "o aro de V1 não volta");
  const blocoDeTom = (tom: string) => {
    const i = FOLHA.indexOf(`.badge.tone-${tom}`);
    assert.ok(i >= 0, `faltou o bloco de tom ${tom} na folha V2`);
    return FOLHA.slice(i, FOLHA.indexOf("}", i));
  };
  assert.match(blocoDeTom("ok"), /--status-ink: var\(--v2-ok\)/, "verde de estado, não verde de tema");
  assert.match(blocoDeTom("warn"), /--status-ink: var\(--v2-warn\)/);
  assert.match(blocoDeTom("crit"), /--status-ink: var\(--v2-danger\)/);
  for (const tom of ["ok", "warn", "crit"]) {
    assert.doesNotMatch(blocoDeTom(tom), /--v2-accent|--primary/, `o tom ${tom} não pode herdar a cor da identidade`);
  }
});

/**
 * EXPECTATIVA ALTERADA a 2026-10-26 (patch PC Center) — documentada, não
 * silencioso: o teste original congelava a EXISTÊNCIA de `metricColor` (limiares
 * escritos à mão dentro do Dashboard), que é exatamente o defeito que a
 * unificação de saúde fecha. Com a migração V2-FIRST o Painel deixou de pintar
 * barras: o que se preserva é a intenção — (1) uma só origem para a cor de
 * utilização, (2) nenhuma barra pintada com a cor da identidade, (3) o estado do
 * motor nunca se confunde com o tema. Mapa: `out/MAPA-TESTES-V2-FIRST.md`.
 */
test("o Painel não escreve limiares de cor nem pinta estado com a identidade", () => {
  assert.doesNotMatch(PAINEL, /function metricColor|bg-cyber|text-cyber|bg-primary|border-cyber/, "limiar ou cor de identidade escrito à mão no Painel");
  assert.doesNotMatch(PAINEL, /<\s*\d+\s*\)\s*return\s*"|>=\s*\d+\s*\?\s*"/, "cor escolhida por limiar literal no Painel");

  // Render real, com estados mistos: cada cartão leva o tom do SEU estado, e o
  // tom de identidade (`proc`) não aparece em motor nenhum.
  const engine = {
    serviceRunning: true, osLayerHealthy: true, degradedReasons: [], monitoredPaths: [],
    yara: { status: "active", coverage: "normal" },
    hashDb: { status: "degraded" },
    clamav: { status: "error" },
    nativeEngine: { status: "unavailable" },
  } as unknown as EngineHealth;
  const html = renderPainel(engine);
  assert.match(html, /badge tone-ok/, "motor ativo em verde de estado");
  assert.match(html, /badge tone-warn/, "motor degradado em âmbar de estado");
  assert.match(html, /badge tone-crit/, "motor em erro em vermelho de estado");
  assert.doesNotMatch(html, /badge tone-proc/, "a cor da identidade não pinta estado de motor");
});

test("o Belbete mantém identidade vinho e estados semânticos separados", () => {
  const bloco = CSS.slice(
    CSS.indexOf('[data-theme="cybersafe-red-belbete"].dark'),
    CSS.indexOf("}", CSS.indexOf("--cyber-glow", CSS.indexOf('[data-theme="cybersafe-red-belbete"].dark'))),
  );
  assert.match(bloco, /--primary: #c55d72/i, "a identidade Red Velvet perdeu o vinho");
  assert.match(bloco, /--cyber-green: #4ecb83/i, "o positivo deixou de ser verde");
  assert.match(bloco, /--cyber-yellow: #ffbf3e/i, "a atenção deixou de ser âmbar");
  assert.match(bloco, /--cyber-red: #ff5454/i, "o erro deixou de ser vermelho");
});
