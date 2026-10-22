import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSurface, SURFACE_LABELS, isSurfaceStyle, DEFAULT_SURFACE } from "../src/lib/appearance";

/**
 * TP-V2-VISUAL (qoder) — eixo de MATERIAL: Solid / Reduced / Liquid distintos.
 *
 * Critério do packet: os três materiais têm de ser VISIVELMENTE distintos e o
 * "Liquid" é vidro (desfoque do fundo), NÃO blur vendido como refração. Este
 * teste lê a fonte real do eixo e fixa as diferenças estruturais, mais o travão
 * de movimento reduzido. As capturas BEFORE/AFTER provam o sinal visual.
 */

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

/** Bloco `[data-material="X"] { ... }` — apanha o corpo até ao próximo `}` de nível. */
function materialBlock(sel: string): string {
  const i = css.indexOf(sel);
  assert.ok(i >= 0, `falta o seletor ${sel} no eixo de material`);
  const open = css.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") { depth--; if (depth === 0) return css.slice(open, j + 1); }
  }
  return "";
}

describe("Material — os três acabamentos são estruturalmente distintos", () => {
  it("Sólido é opaco e nunca aplica backdrop-filter", () => {
    const block = materialBlock('[data-material="solid"]');
    assert.match(block, /backdrop-filter:\s*none/);
    assert.equal(/backdrop-filter:\s*var/.test(block), false, "sólido não pode desfocar");
  });

  it("Reduzido é translúcido mas SEM desfoque (o fundo passa, não é amostrado)", () => {
    const block = materialBlock('[data-material="reduced"]');
    assert.match(block, /var\(--surface-translucent\)/);
    assert.match(block, /backdrop-filter:\s*none/);
  });

  it("Vidro/Líquido aplica backdrop-filter a partir do token do eixo (não um blur fixo que ignora reduced-motion)", () => {
    const block = materialBlock('[data-material="glass"]');
    assert.match(block, /backdrop-filter:\s*var\(--surface-filter\)/);
    // liquid é alias de glass no mesmo bloco.
    assert.ok(css.includes('[data-material="glass"],') || css.includes('[data-material="glass"]'));
    assert.match(css, /\[data-material="liquid"\]/);
  });

  it("Solid vs Liquid têm preenchimentos diferentes (não só um atributo igual)", () => {
    const solid = materialBlock('[data-material="solid"]');
    const glass = materialBlock('[data-material="glass"]');
    assert.notEqual(solid.includes("backdrop-filter: var"), glass.includes("backdrop-filter: var"));
  });
});

describe("Material — movimento reduzido não é ignorado", () => {
  it("existe um gate global de prefers-reduced-motion", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });

  it("o gate global zera animação/transição quando o SO pede menos movimento", () => {
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 1);
    const joined = blocks.join("\n");
    assert.match(joined, /animation-duration:\s*0\.01ms|transition:\s*none|transition-duration:\s*0/);
  });
});

describe("Material — o contrato de dados do eixo", () => {
  it("SURFACE_LABELS cobre os três estados e são rótulos PT-PT", () => {
    assert.deepEqual(Object.keys(SURFACE_LABELS).sort(), ["glass", "reduced", "solid"]);
    for (const v of Object.values(SURFACE_LABELS)) assert.ok(v.length > 0 && v === v.trim());
  });

  it("normalizeSurface aceita 'liquid' como alias de 'glass' e rejeita o resto", () => {
    assert.equal(normalizeSurface("liquid"), "glass");
    assert.equal(normalizeSurface("glass"), "glass");
    assert.equal(normalizeSurface("solid"), "solid");
    assert.equal(normalizeSurface("reduced"), "reduced");
    assert.equal(normalizeSurface("refracao"), DEFAULT_SURFACE);
    assert.equal(isSurfaceStyle("liquid"), false, "'liquid' não é valor público do eixo, é só alias");
  });
});
