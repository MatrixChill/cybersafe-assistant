import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SURFACE_LABELS, IDENTITY_LABELS } from "../src/lib/appearance";

/**
 * TP-V2-VISUAL (qoder) — contrato da página de Configurações V2.
 *
 * Fixa a grelha de materiais e a pré-visualização honesta, sem amarrar classes:
 *  - os três botões de material têm `aria-pressed` e exatamente UM está true
 *    (coerente com a preferência persistida);
 *  - o aside de comparação usa `data-surface-preview` (o escape que impede o
 *    travão universal do eixo de apagar a diferença entre materiais na amostra);
 *  - o contexto lido é escrito: "Material em uso: <rótulo>" e "Identidade: <rótulo>";
 *  - a amostra do hero do Dashboard (SurfaceHeroPreview) está presente;
 *  - o painel de atualizações honesto (no-bridge) continua na página — um
 *    redesign não o pode eliminar.
 *
 * Estas são as MESMAS âncoras semânticas do teste de integração do OpenCode;
 * se este redesign mudar algum seletor, o contrato (não o markup) é que vale.
 */

function withSurface(surface: string) {
  const store: Record<string, string> = { theme: "dark", cybersafe_surface: surface, cybersafe_theme: "cybersafe-core" };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  (globalThis as Record<string, unknown>).React = React;
}

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: SettingsPage } = await import("../src/pages/SettingsPage");

function render(surface: string) {
  withSurface(surface);
  return renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(SettingsPage)));
}

const settingsSource = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");

describe("Configurações V2 — seletor de material coerente com a persistência", () => {
  it("exatamente um dos três materiais está aria-pressed=true, e é o guardado", () => {
    for (const surface of ["solid", "glass", "reduced"] as const) {
      const html = render(surface);
      const pressed = [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/g)]
        .map((m) => m[1])
        .filter((inner) => Object.values(SURFACE_LABELS).some((lbl) => inner.includes(`>${lbl}<`)));
      assert.equal(pressed.length, 1, `esperado 1 material ativo em ${surface}, vieram ${pressed.length}`);
      assert.ok(pressed[0].includes(SURFACE_LABELS[surface]), `o ativo deveria ser ${SURFACE_LABELS[surface]}`);
    }
  });

  it("trocar de material chama setSurface, não toca em identidade/destaque", () => {
    assert.match(settingsSource, /onClick=\{\(\) => setSurface\(option\.id\)\}/);
    // O seletor de material é um mapa próprio (SURFACE_OPTIONS), separado do de identidade.
    assert.match(settingsSource, /SURFACE_OPTIONS\.map/);
  });
});

describe("Configurações V2 — pré-visualização honesta dos três materiais", () => {
  it("o aside de comparação usa data-surface-preview e escreve o contexto lido", () => {
    const html = render("glass");
    assert.match(html, /data-surface-preview/);
    assert.ok(html.includes("Material em uso:"), "falta a linha 'Material em uso'");
    assert.ok(html.includes(SURFACE_LABELS.glass), "o material em uso deve nomear o rótulo real");
    assert.ok(html.includes("Identidade:"), "falta a linha 'Identidade'");
    assert.ok(html.includes(IDENTITY_LABELS["cybersafe-core"]), "a identidade deve nomear o rótulo real");
  });

  it("a amostra do hero do Dashboard está presente e rotulada como amostra", () => {
    const html = render("glass");
    assert.match(html, /data-testid="surface-hero-preview"/);
    assert.match(html, /não é o estado real|não são o\s+estado do teu computador/, "a amostra tem de se declarar amostra");
  });
});

describe("Configurações V2 — painel de atualizações honesto preservado", () => {
  it("inclui <UpdatesSection/> (o painel no-bridge é renderizado por ele)", () => {
    assert.match(settingsSource, /<UpdatesSection\s*\/>/);
    assert.match(settingsSource, /import \{ UpdatesSection \} from "\.\.\/components\/updates\/UpdatesSection"/);
  });
});
