import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * TP-QA-02 (17/09) — Sidebar real: rotas, `aria-current`, acessibilidade de
 * teclado (são `<button>`, focáveis), gating por plano e contrato de movimento.
 *
 * Não espelha strings arbitrárias: lê o `Sidebar` REAL, renderiza-o em SSR e
 * usa os ganchos que o próprio componente emite (`nav-item w-full`,
 * `aria-current="page"`, etiqueta "Business Center"/"Relatórios"). O que só se
 * vê a olhos (foco real, ordem de tab, animação) fica para reteste humano.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: Sidebar } = await import("../src/components/Sidebar");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const decls = fs
  .readFileSync(path.join(HERE, "..", "src", "index.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const noop = () => {};

type User = Parameters<typeof Sidebar>[0]["user"];
const freeUser = {
  id: "u1",
  name: "Ensai",
  email: "a@b.test",
  type: "personal",
  plan: "free",
  role: "user",
  createdAt: "2026-01-01T00:00:00Z",
} as User;
const businessUser = {
  ...freeUser,
  id: "u2",
  type: "business",
  plan: "premium",
} as User;

function render(activePage: string, user: User): string {
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
      }),
    ),
  );
}

/** Os botões de rota (não os de aparência): têm `nav-item w-full`. */
const routeButtons = (html: string) => (html.match(/nav-item w-full/g) ?? []).length;

describe("Sidebar — uma só rota ativa, acessível por teclado", () => {
  it("a navegação é um landmark com nome e as rotas são <button> focáveis", () => {
    const html = render("dashboard", freeUser);
    assert.match(html, /aria-label="Navegação principal"/);
    assert.ok(routeButtons(html) > 0, "nenhuma rota renderizada como botão");
  });

  it("exatamente uma rota marca aria-current='page' e recebe a classe active", () => {
    for (const page of ["dashboard", "scanner", "settings", "otimizar"]) {
      const html = render(page, freeUser);
      const current = (html.match(/aria-current="page"/g) ?? []).length;
      assert.equal(current, 1, `aria-current não único em ${page}: ${current}`);
      assert.match(html, /nav-item w-full[^"]*[^>]*\bactive\b/, `faltou a classe active em ${page}`);
    }
  });

  it("quarantine é alias de threats: continua UMA só rota ativa (threats)", () => {
    const html = render("quarantine", freeUser);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    // A rota "quarantine" não existe como botão próprio; quem fica ativa é Ameaças.
    assert.equal(/>Quarentena</.test(html), false, "quarantine não deve ser um item de rota isolado");
    assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Ameaças/);
  });
});

describe("Sidebar — gating por plano é real, não decorativo", () => {
  it("conta de rotas visíveis: business premium > free (a diferença é o entitlement)", () => {
    assert.ok(
      routeButtons(render("dashboard", businessUser)) > routeButtons(render("dashboard", freeUser)),
      "business premium não mostrou mais rotas que free",
    );
  });

  it("free não vê Business Center nem Relatórios; business premium vê-os", () => {
    const free = render("dashboard", freeUser);
    assert.equal(free.includes("Business Center"), false, "free viu Business Center");
    assert.equal(free.includes("Relatórios"), false, "free viu Relatórios");
    const biz = render("dashboard", businessUser);
    assert.ok(biz.includes("Business Center"), "business premium não viu Business Center");
    assert.ok(biz.includes("Relatórios"), "business premium não viu Relatórios");
  });

  it("a rota business carrega a insígnia BUSINESS (não só texto)", () => {
    const biz = render("dashboard", businessUser);
    assert.match(biz, /nav-pro-badge/);
    assert.match(biz, />BUSINESS</);
  });
});

describe("movimento — contrato de prefers-reduced-motion no CSS real", () => {
  it("index.css tem blocos @media (prefers-reduced-motion: reduce)", () => {
    const blocks = (decls.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)/g) ?? []).length;
    assert.ok(blocks >= 1, "nenhum contrato de movimento reduzido no CSS");
  });
});
