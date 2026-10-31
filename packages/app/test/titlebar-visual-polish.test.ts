import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P3 — ACABAMENTO DA BARRA SUPERIOR (React/CSS apenas).
 *
 * A integração Electron (AppTitleBar, Window Controls Overlay, cor dos botões
 * nativos) está fechada e NÃO se toca. O que aqui se fixa é a apresentação:
 * vidro seletivo, risco de acento da marca, aresta em gradiente, hierarquia da
 * tipografia e transições discretas — todas com tokens do tema ativo.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, "..", ...parts), "utf8");
const css = read("src", "index.css");
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");
const component = read("src", "components", "AppTitleBar.tsx");

function rule(selector: string): string {
  const start = decls.indexOf(`${selector} {`);
  assert.ok(start >= 0, `regra ${selector} ausente`);
  const end = decls.indexOf("\n}", start);
  return decls.slice(start, end);
}

const bar = rule(".app-titlebar");

test("geometria e contrato nativo intactos: 42 px, arrasto, 150 px, sem borda", () => {
  assert.match(bar, /height:\s*var\(--shell-titlebar-h\)/);
  assert.match(bar, /-webkit-app-region:\s*drag/);
  assert.match(bar, /padding-right:\s*150px/);
  assert.equal(/border-bottom\s*:/.test(bar), false, "a aresta voltou a roubar altura");
  assert.match(bar, /box-shadow:\s*inset 0 -1px 0/);
  const z = Number(/z-index:\s*(\d+)/.exec(bar)?.[1] ?? "0");
  assert.ok(z >= 30 && z <= 60, `z-index inesperado: ${z}`);
});

test("vidro seletivo: a faixa desfoca pelo token do eixo, não por blur literal", () => {
  assert.equal(/backdrop-filter/.test(bar), false, "a faixa voltou a declarar desfoque literal");
  const glass = rule('[data-surface="glass"] .app-titlebar');
  assert.match(glass, /-webkit-backdrop-filter:\s*var\(--surface-filter\)/, "falta a variante WebKit (Chromium do Electron)");
  assert.match(glass, /backdrop-filter:\s*var\(--surface-filter\)/, "o desfoque não segue o eixo de superfície");
  assert.equal(/blur\(/.test(glass), false, "blur literal fora do sistema");
});

test("marca: risco de acento e separador, sem novos botões ou controlos", () => {
  assert.match(rule(".app-titlebar-brand::before"), /background:\s*linear-gradient\(180deg, var\(--primary\)/, "o risco da marca não usa o acento do tema");
  assert.match(rule(".app-titlebar-product::before"), /content:\s*"[^"]+"/, "falta o separador da marca");
  assert.equal(/<button/.test(component), false, "a faixa ganhou botões próprios");
  assert.match(component, /className="app-titlebar"/);
});

test("aresta inferior em gradiente do acento, fora da zona dos controlos nativos", () => {
  const after = rule(".app-titlebar::after");
  assert.match(after, /position:\s*absolute/);
  assert.match(after, /height:\s*1px/);
  assert.match(after, /right:\s*150px/, "o traço entra na zona dos controlos nativos");
  assert.match(after, /pointer-events:\s*none/);
  assert.match(after, /color-mix\([^)]*var\(--primary\)/);
});

test("cores só de tokens: nenhum literal dentro da faixa", () => {
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(bar), false, "há cor fixa na faixa");
  assert.match(bar, /background:\s*color-mix\([^)]*var\(--background\)[^)]*var\(--card\)/);
  assert.match(bar, /background-image:\s*radial-gradient\([^)]*var\(--primary\)/);
});

test("transições discretas e desligadas com movimento reduzido", () => {
  assert.match(bar, /transition:\s*background 200ms ease, box-shadow 200ms ease/);
  assert.match(
    decls,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.app-titlebar\s*\{\s*transition:\s*none/,
    "movimento reduzido não desliga a transição",
  );
});

test("a barra continua uma só e sem lógica de janela no renderer", () => {
  assert.equal((component.match(/<header/g) ?? []).length, 1);
  assert.equal(/minimize|maximize|close/i.test(component), false, "lógica de janela no renderer");
  assert.match(component, /PRODUCT_NAME = "Assistant"/);
});
