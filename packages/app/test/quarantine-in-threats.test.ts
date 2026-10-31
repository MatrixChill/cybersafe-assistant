import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuarantineEntry } from "@cybersafe/shared-types";

// `tsx` compila JSX com runtime classico — mesmo padrao de design-semantic-tokens.test.ts.
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: ThreatsPage } = await import("../src/pages/ThreatsPage");
const { default: Sidebar } = await import("../src/components/Sidebar");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");

/** Sidebar renderiza BrandLogo, que le AppearanceContext — o teste poe o provider. */
const renderSidebar = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(Sidebar, props as never)));

const entry: QuarantineEntry = {
  id: "q-1",
  originalPath: "C:\\temp\\suspeito.exe",
  quarantinePath: "C:\\quarantine\\q-1\\suspeito.exe",
  fileName: "suspeito.exe",
  sha256: "abc123",
  verdict: "malicious",
  riskScore: 90,
  quarantinedAt: "2026-10-08T10:00:00.000Z",
};

const noop = () => {};

describe("Fase A — Quarentena dentro de Ameacas", () => {
  test("com quarantine fornecida: abas Deteccoes e Quarentena, com contagens reais", () => {
    const html = renderToStaticMarkup(
      createElement(ThreatsPage, {
        events: [],
        onClear: noop,
        isClearing: false,
        quarantine: [entry],
        onQuarantineChanged: noop,
      }),
    );
    assert.match(html, /role="tablist"/);
    assert.match(html, /Deteções/);
    assert.match(html, /Quarentena/);
    // Contagem real da quarentena na aba — nao inventada.
    assert.match(html, /Quarentena[\s\S]{0,160}>1</);
  });

  test("por omissão mostra Deteccoes; o ficheiro em quarentena NAO aparece na primeira aba", () => {
    const html = renderToStaticMarkup(
      createElement(ThreatsPage, {
        events: [],
        onClear: noop,
        isClearing: false,
        quarantine: [entry],
        onQuarantineChanged: noop,
      }),
    );
    assert.doesNotMatch(html, /suspeito\.exe/, "a lista de quarentena nao e deteccao nem historico de ameaas");
    assert.doesNotMatch(html, /A quarentena está vazia/);
  });

  test("initialTab=quarantine (rota antiga do tray): conteudo real, acoes e confirmacao preservadas", () => {
    const html = renderToStaticMarkup(
      createElement(ThreatsPage, {
        events: [],
        onClear: noop,
        isClearing: false,
        quarantine: [entry],
        onQuarantineChanged: noop,
        initialTab: "quarantine",
      }),
    );
    assert.match(html, /suspeito\.exe/);
    assert.match(html, /C:\\temp\\suspeito\.exe/, "caminho original real visivel");
    assert.match(html, /Restaurar/);
    assert.match(html, /Eliminar/);
    // A aba Quarentena e que esta selecionada, nao a de Deteccoes.
    assert.match(html, /aria-selected="true"/);
    const quarantineTab = html.match(/<button[^>]*aria-selected="true"[^>]*>[\s\S]{0,900}?Quarentena/);
    assert.ok(quarantineTab, "aria-selected=true tem de estar no botao Quarentena");
    // O logico de Deteccoes (filtros/limpar log) nao e oferecida na aba errada.
    assert.doesNotMatch(html, /LIMPAR LOGS/);
    assert.doesNotMatch(html, /Pesquisar ameaças/);
  });

  test("sem prop quarantine (SSR antigo e App com motor sem dados): pagina comporta-se como antes", () => {
    const html = renderToStaticMarkup(
      createElement(ThreatsPage, { events: [], onClear: noop, isClearing: false }),
    );
    assert.doesNotMatch(html, /role="tablist"/, "sem dados de quarentena nao ha abas decorativas");
    assert.match(html, /Pesquisar ameaças/);
  });

  test("sidebar: Quarentena deixou de ser entrada isolada; Ameacas cobre a rota antiga", () => {
    const base = {
      onNavigate: noop,
      theme: "dark" as const,
      onThemeChange: noop,
      accent: "cyan" as const,
      onAccentChange: noop,
    };
    const htmlQuarantine = renderSidebar({ ...base, activePage: "quarantine" as never });
    const labels = [...htmlQuarantine.matchAll(/<span class="font-medium text-sm truncate">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.ok(!labels.includes("Quarentena"), "a entrada isolada saiu do menu");
    assert.ok(labels.includes("Ameaças"), "Ameacas continua no menu");
    // Deep link antigo: o item Ameacas e que fica marcado como pagina atual.
    const threatsButton = htmlQuarantine.match(/<button[^>]*aria-current="page"[^>]*>[\s\S]{0,900}?Ameaças/);
    assert.ok(threatsButton, "com activePage=quarantine, a seleccao activa e o item Ameacas");
  });

  test("sidebar: grupos da arquitetura (Painel/Seguranca/Computador/Ferramentas/Definicoes/Experimental)", () => {
    // Business e Relatorios sao gateados por feature — Business Center exige
    // conta business (ou admin), independentemente do plano. Sem user o gate
    // esconde-os (isto esta correto). O teste usa uma conta business real.
    const businessUser = { name: "Teste", email: "t@t", type: "business", plan: "free" } as never;
    const html = renderSidebar({
      onNavigate: noop,
      theme: "dark" as const,
      onThemeChange: noop,
      accent: "cyan" as const,
      onAccentChange: noop,
      activePage: "dashboard" as never,
      user: businessUser,
    });
    for (const group of ["Painel", "Segurança", "Computador", "Ferramentas", "Definições", "Experimental"]) {
      assert.match(html, new RegExp(`>${group}<`), `rotulo de grupo "${group}" presente`);
    }
  });
});
