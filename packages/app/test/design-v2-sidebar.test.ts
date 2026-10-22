import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";
import SettingsPage from "../src/pages/SettingsPage";

/** Configurações real dentro do AppearanceProvider (localStorage só se não existir). */
function renderSettings(): string {
  const g = globalThis as Record<string, unknown>;
  if (!g.localStorage) g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  return renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(SettingsPage)));
}

/**
 * TP-V2-SIDEBAR (17/10) — contrato da Sidebar redesenhada.
 *
 * O que este teste guarda (e o que um redesign não pode partir):
 *  - rotas/ids/rótulos/ordem dos grupos e o gating por conta (inalterados);
 *  - exatamente UM `aria-current="page"` (quarantine → Ameaças);
 *  - composição NOVA: secções com nome, estado ativo partilhado por
 *    `layoutId` com spring interruptível, colapso honesto (sem texto cortado —
 *    colapsada mostra botões de ícone com `aria-label` + `title`, sem rótulos
 *    renderizados), foco visível em todos os controlos;
 *  - preferências: modo/destaque/tema base continuam lá, com `aria-pressed`;
 *  - movimento reduzido: fonte do componente desliga os springs (`duration: 0`)
 *    e o CSS real mantém o bloco global de prefers-reduced-motion.
 *
 * Fica para reteste humano: foco real de teclado, interrupção visual do spring
 * a meio, colapso animado e recorte de texto em runtime.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDEBAR_SRC = fs.readFileSync(path.join(HERE, "..", "src", "components", "Sidebar.tsx"), "utf8");

const { default: Sidebar } = await import("../src/components/Sidebar");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");

const noop = () => {};
type User = NonNullable<Parameters<typeof Sidebar>[0]["user"]>;

const freeUser = {
  id: "u1",
  name: "Ensai",
  email: "a@b.test",
  type: "personal",
  plan: "free",
  role: "user",
  createdAt: "2026-01-01T00:00:00Z",
} as User;

const businessUser = { ...freeUser, id: "u2", type: "business", plan: "premium" } as User;

function render(activePage: string, user: User, collapsed = false): string {
  return renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(Sidebar, {
        activePage: activePage as never,
        onNavigate: noop,
        theme: "dark",
        accent: "cyan",
        onThemeChange: noop,
        onAccentChange: noop,
        identity: "cybersafe-core",
        onIdentityChange: noop,
        user,
        onLogout: noop,
        level: "critical",
        defaultCollapsed: collapsed,
      }),
    ),
  );
}

/** Botões de rota (classe exata que os distingue dos controlos). */
const routeButtonTags = (html: string) =>
  html.match(/<button[^>]*class="[^"]*nav-item w-full[^"]*"[^>]*>/g) ?? [];

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

describe("Sidebar v2 — contrato de navegação inalterado", () => {
  it("mantém a landmark única 'Navegação principal' e a ordem dos grupos", () => {
    const html = render("dashboard", freeUser);
    assert.equal((html.match(/<aside/g) ?? []).length, 1, "mais do que uma landmark");
    assert.match(html, /aria-label="Navegação principal"/);
    const groups = (html.match(/<section aria-label="([^"]+)"/g) ?? []).map((s) => s.replace(/.*aria-label="|"$/g, ""));
    assert.deepEqual(groups, ["Painel", "Segurança", "Computador", "Ferramentas", "Definições"], "ordem de grupos mudou");
  });

  it("rotas com os mesmos ids/rótulos (gating free: 9 itens, sem Business/Relatórios)", () => {
    const html = render("dashboard", freeUser);
    const visible = [...html.matchAll(/<span class="font-medium text-sm truncate">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.equal(routeButtonTags(html).length, 9);
    assert.deepEqual(visible, [
      "Painel",
      "Análise de Segurança",
      "Ameaças",
      "Monitor em Tempo Real",
      "PC Center",
      "Gestor de Tarefas",
      "Otimizar",
      "Simulador",
      "Configurações",
    ], "rótulos/ordem mudaram");
    assert.equal(html.includes("Business Center"), false);
    assert.equal(html.includes("Relatórios"), false);
  });

  it("business premium vê as duas rotas extra e a insígnia BUSINESS", () => {
    const html = render("dashboard", businessUser);
    assert.equal(routeButtonTags(html).length, 11);
    assert.match(html, /nav-pro-badge/);
    assert.match(html, />BUSINESS</);
  });

  it("exatamente um aria-current='page' (quarantine continua alias de Ameaças)", () => {
    for (const page of ["dashboard", "scanner", "settings", "otimizar", "quarantine"]) {
      const html = render(page, freeUser);
      assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1, `aria-current não único em ${page}`);
    }
    const html = render("quarantine", freeUser);
    assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Ameaças/);
    assert.equal(/>Quarentena</.test(html), false);
  });
});

describe("Sidebar v2 — composição premium (spring interruptível, foco, colapso)", () => {
  it("o estado ativo é um só elemento partilhado por layoutId, com spring (interruptível)", () => {
    const html = render("scanner", freeUser);
    assert.equal((html.match(/data-active-bg="true"/g) ?? []).length, 1, "fundo ativo não é um só elemento");
    assert.equal((html.match(/data-active-bar="true"/g) ?? []).length, 1, "barra ativa não é um só elemento");
    assert.match(SIDEBAR_SRC, /layoutId="sidebar-active-bg"/);
    assert.match(SIDEBAR_SRC, /layoutId="sidebar-nav-indicator"/);
    assert.match(SIDEBAR_SRC, /type: "spring"/);
  });

  it("movimento reduzido desliga os springs (transição 0, sem loops)", () => {
    assert.match(SIDEBAR_SRC, /reduceMotion \? \{ duration: 0 \}/);
    assert.match(SIDEBAR_SRC, /repeat: collapsed \|\| reduceMotion \? 0 : Infinity/);
  });

  it("todos os botões de rota têm foco visível declarado", () => {
    const html = render("dashboard", freeUser);
    const tags = routeButtonTags(html);
    assert.ok(tags.length > 0);
    for (const tag of tags) {
      assert.match(attr(tag, "class") ?? "", /focus-visible:ring-2/, "rota sem anel de foco");
    }
  });

  it("expandida: rótulos e secções visíveis, toggle aria-expanded=true", () => {
    const html = render("dashboard", freeUser);
    assert.match(html, /data-collapsed="false"/);
    assert.match(html, /aria-expanded="true"/);
    for (const label of ["Painel", "Ferramentas", "Configurações"]) {
      assert.ok(html.includes(label), `faltou "${label}" expandida`);
    }
  });

  it("colapsada: sem nomes cortados — ícones com aria-label+title e nenhum rótulo renderizado", () => {
    const html = render("dashboard", freeUser, true);
    assert.match(html, /data-collapsed="true"/);
    assert.match(html, /aria-expanded="false"/);
    const tags = routeButtonTags(html);
    assert.equal(tags.length, 9);
    for (const tag of tags) {
      assert.ok(attr(tag, "aria-label"), "rota colapsada sem aria-label");
      assert.ok(attr(tag, "title"), "rota colapsada sem title");
      assert.match(tag, /justify-center/, "rota colapsada não centrada");
    }
    // Nenhum texto de rota é renderizado (nada de rótulos truncados a meio).
    for (const label of ["Análise de Segurança", "Gestor de Tarefas", "Configurações", "Ferramentas"]) {
      assert.equal(html.includes(`>${label}<`), false, `rótulo "${label}" visível colapsada`);
    }
    // Os controlos colapsados mantêm-se anunciáveis.
    // Personalização saiu da Sidebar (decisão TP-UI-FINISH); vive em Configurações › Aparência.
    assert.equal(html.includes("Ativar modo claro"), false, "modo não está na Sidebar colapsada");
    assert.match(html, /Estado do sistema:/);
  });
});

describe("Sidebar v2 — preferências preservadas", () => {
  it("modo, destaque e tema base saíram da Sidebar e continuam em Configurações › Aparência", () => {
    const html = render("dashboard", freeUser);
    assert.equal(html.includes("Ativar modo claro"), false, "modo na Sidebar");
    assert.equal(html.includes('aria-label="Cor de destaque"'), false, "destaque na Sidebar");
    assert.equal(html.includes('aria-label="Tema base"'), false, "tema base na Sidebar");

    // Configurações (página real) mantém os três eixos anunciados e marcados.
    const settings = renderSettings();
    assert.match(settings, /<h2[^>]*>Aparência<\/h2>/);
    assert.match(settings, /Tema base/);
    assert.match(settings, /Cor de destaque/);
    assert.ok((settings.match(/aria-pressed="true"/g) ?? []).length >= 2, "destaque e tema base devem estar marcados");
  });

  it("o estado do sistema continua honesto (rótulo real do ProtectionHealth)", () => {
    const html = render("dashboard", freeUser);
    assert.match(html, /CRÍTICO|Crítico|crítico/i);
  });
});
