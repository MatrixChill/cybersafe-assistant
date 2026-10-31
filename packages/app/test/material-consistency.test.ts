import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};

const appearance = await import("../src/lib/appearance");

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
const glassSurface = readFileSync(
  new URL("../src/components/visual/GlassSurface.tsx", import.meta.url),
  "utf8",
);

describe("Material — cascata do eixo", () => {
  test("elemento com eixo e classe legada fica com o preenchimento do eixo", () => {
    assert.match(
      css,
      /\[data-material="solid"\]\.surface-solid \{\s*background: var\(--surface-card\);/,
    );
    assert.match(
      css,
      /\[data-material="glass"\]\.surface-liquid,\s*\[data-material="liquid"\]\.surface-liquid \{\s*background: var\(--surface-translucent\);/,
    );
  });

  test("o desfoque do eixo vem do token, nunca de um literal", () => {
    const blocos = [
      ...css.matchAll(/\[data-material="(glass|liquid)"\][^{]*\{([^}]*)\}/g),
    ].map((m) => m[2]);
    assert.ok(blocos.length > 0, "há blocos de vidro");
    for (const bloco of blocos) {
      assert.doesNotMatch(bloco, /blur\(\d+px\)/, "blur literal no eixo de material");
    }
  });

  test("reduced e showcase continuam sem desfoque", () => {
    assert.match(css, /\[data-material="reduced"\] \{[^}]*backdrop-filter: none;/);
    assert.match(css, /\[data-material="showcase"\] \{[^}]*backdrop-filter: none;/);
  });

  test("redes de segurança do movimento reduzido continuam a existir", () => {
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /\[data-surface="glass"\] \{ --surface-filter: blur\(\d+px\)/);
  });
});

describe("Material — GlassSurface", () => {
  test("consome o eixo por data-material e não injeta desfoque próprio", () => {
    assert.match(glassSurface, /data-material=\{material\}/);
    assert.doesNotMatch(glassSurface, /backdropFilter/);
    assert.doesNotMatch(glassSurface, /blur\(/);
  });
});

describe("Material — pré-visualização da Settings", () => {
  test("o cartão Sólido usa o token da superfície, não o fundo da página", () => {
    assert.match(settings, /option\.id === "solid"\s*\? "var\(--surface-card\)"/);
    assert.doesNotMatch(settings, /option\.id === "solid"\s*\? "var\(--background\)"/);
  });

  test("o desfoque do cartão de Vidro lê o token do eixo", () => {
    assert.match(settings, /backdropFilter: option\.id === "glass" \? "var\(--surface-filter\)" : "none"/);
    assert.doesNotMatch(settings, /blur\(16px\) saturate\(150%\)/);
  });

  test("cada cartão resolve o token do seu próprio material, não do modo ativo", () => {
    // Sem data-surface por cartão, em Sólido/Reduzido o `--surface-filter`
    // herdado é `none` e o cartão de Vidro perde o desfoque.
    assert.match(settings, /data-surface-preview=""[\s\S]{0,240}data-surface=\{option\.id\}/);
    assert.equal((settings.match(/data-surface=\{option\.id\}/g) ?? []).length, 1);
  });

  test("a amostra segue o movimento reduzido pela media que já existe", () => {
    // O token do cartão é `[data-surface]` (não `html [data-surface]`), por isso
    // o bloco de movimento reduzido que já existe também o alcança: a amostra
    // de Vidro aligeira o raio como qualquer superfície, sem token novo.
    assert.match(
      css,
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,900}\[data-surface="glass"\] \{ --surface-filter: blur\(8px\) saturate\(120%\); \}/,
    );
  });

  test("o travão universal do eixo continua a excluir a amostra", () => {
    assert.match(
      css,
      /\[data-surface="reduced"\] \*:not\(\[data-surface-preview\]\)/,
    );
    assert.match(
      css,
      /\[data-surface="solid"\] \*:not\(\[data-surface-preview\]\)/,
    );
  });

  test("a comparação é anunciada como grupo e o material em uso é marcado", () => {
    assert.match(settings, /role="group"/);
    assert.match(settings, /aria-label="Pré-visualização dos três materiais/);
    assert.match(settings, /aria-current=\{ativo \? "true" : undefined\}/);
  });
});

describe("Material — rehidratação sintética (sem store real)", () => {
  test("os três valores guardados voltam iguais numa leitura nova", () => {
    for (const surface of ["solid", "reduced", "glass"] as const) {
      store.set(appearance.APPARANCE_SURFACE_KEY, surface);
      assert.equal(appearance.loadSurface(), surface);
    }
  });

  test("valor desconhecido não inventa material novo: cai no padrão declarado", () => {
    store.set(appearance.APPARANCE_SURFACE_KEY, "refractive");
    assert.equal(appearance.loadSurface(), appearance.DEFAULT_SURFACE);
    assert.equal(appearance.normalizeSurface("refractive"), appearance.DEFAULT_SURFACE);
  });

  test("a chave guardada é a do contrato e não uma chave nova", () => {
    assert.equal(appearance.APPARANCE_SURFACE_KEY, "cybersafe_surface");
    assert.equal("writeAppearance" in appearance, true);
    assert.equal(appearance.isSurfaceStyle("reduced"), true);
    assert.equal(appearance.isSurfaceStyle("refractive"), false);
  });
});
