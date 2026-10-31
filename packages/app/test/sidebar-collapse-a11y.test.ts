import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

/** Q4 (18/10) — barra lateral: estado recolhido persistente, sem ícones
    inertes quando recolhida, texto PT-PT. SSR sem DOM. */

const store: Record<string, string> = {};
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
};

const { default: Sidebar } = await import("../src/components/Sidebar");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const S = await import("../src/lib/sidebarState");

const props = {
  activePage: "dashboard" as const,
  onNavigate: () => {},
  theme: "dark" as const,
  onThemeChange: () => {},
  accent: "cyan" as const,
  onAccentChange: () => {},
  identity: "cybersafe-core" as const,
  onIdentityChange: () => {},
  user: null,
};
const render = () => renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(Sidebar, props)));

describe("barra lateral", () => {
  test("expandida: tagline em PT-PT e página ativa marcada", () => {
    delete store[S.SIDEBAR_COLLAPSED_KEY];
    const html = render();
    assert.match(html, /Assistente de segurança/);
    assert.doesNotMatch(html, /Security Assistant/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, /aria-expanded="true"/);
  });

  test("recolhida: Configurações nomeadas, sem personalização duplicada", () => {
    S.saveSidebarCollapsed(true);
    assert.equal(store[S.SIDEBAR_COLLAPSED_KEY], "1");
    const html = render();
    assert.match(html, /aria-expanded="false"/, "o estado recolhido sobrevive ao reinício");
    assert.match(html, /aria-label="Configurações"/);
    assert.doesNotMatch(html, /Abrir Aparência/);
    assert.doesNotMatch(html, /aria-label="Tema base"/, "amostras escondidas não deixam um grupo vazio");
    // Todos os itens de navegação têm nome acessível mesmo sem texto visível.
    const navButtons = [...html.matchAll(/<button[^>]*class="nav-item[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.ok(navButtons.length > 3);
    for (const b of navButtons) assert.match(b, /aria-label="[^"]+"/, b);
  });

  test("armazenamento que lança não derruba a barra", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("QuotaExceededError"); },
    };
    assert.equal(S.loadSidebarCollapsed(), false);
    assert.doesNotThrow(() => S.saveSidebarCollapsed(true));
  });
});

describe("barra lateral em janela estreita", () => {
  test("recolhe sozinha abaixo de 1024 px sem perder a escolha das janelas largas", () => {
    assert.equal(S.SIDEBAR_AUTO_COLLAPSE_QUERY, "(max-width: 1023px)");
    assert.equal(S.effectiveCollapsed(false, true, null), true, "estreita: recolhida");
    assert.equal(S.effectiveCollapsed(false, true, false), false, "o utilizador abriu-a agora");
    assert.equal(S.effectiveCollapsed(false, false, true), false, "larga: vale a escolha guardada");
    assert.equal(S.effectiveCollapsed(true, false, null), true);
  });
});

describe("barra lateral — personalização centralizada", () => {
  test("não repete seletores de aparência em nenhum destaque", () => {
    delete store[S.SIDEBAR_COLLAPSED_KEY];
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
    for (const accent of ["cyan", "matrix-green", "blue", "purple", "pink", "amber", "red-wine"] as const) {
      const html = renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(Sidebar, { ...props, accent })));
      assert.doesNotMatch(html, /aria-label="Cor de destaque|aria-label="Tema base/);
      assert.match(html, /Configurações/);
    }
  });
});
