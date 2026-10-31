import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P2 — BELBETE / RED VELVET.
 *
 * O tema nasce do bolo: veludo vermelho (#922C42), bordô profundo (#431822),
 * rosé (#C55D72), creme (#F5E9DD) e rosa suave (#D8A5A5). Não é «preto com
 * risca vermelha»: as superfícies escuras são bordô/cacau e a tinta é creme.
 *
 * O que NÃO pode mudar: as cores semânticas (sucesso/aviso/perigo) e as outras
 * quatro identidades. Sem imagens de bolos, sem texturas de comida.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, "..", "src", "index.css"), "utf8");
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const start = decls.indexOf(`${selector} {`);
  assert.ok(start >= 0, `bloco ${selector} ausente`);
  const end = decls.indexOf("\n}", start);
  assert.ok(end > start, `bloco ${selector} sem fim`);
  return decls.slice(start, end);
}

function token(text: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(text);
  assert.ok(m, `token --${name} ausente`);
  return m[1].trim();
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `cor não é hex de 6 dígitos: ${hex}`);
  const int = Number.parseInt(m[1], 16);
  return 0.2126 * channel((int >> 16) & 255) + 0.7152 * channel((int >> 8) & 255) + 0.0722 * channel(int & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const dark = block('[data-theme="cybersafe-red-belbete"].dark');
const light = block('[data-theme="cybersafe-red-belbete"]:not(.dark)');

test("escuro: superfícies bordô/cacau e tinta creme (não é preto com risca)", () => {
  assert.equal(token(dark, "background"), "#170d10");
  assert.equal(token(dark, "foreground"), "#f5e9dd");
  assert.match(token(dark, "card"), /rgba\(67, 24, 34, 0\.74\)/, "o cartão não é bordô translúcido");
  assert.equal(token(dark, "primary"), "#c55d72");
  assert.equal(token(dark, "primary-foreground"), "#210b11");
  assert.equal(token(dark, "muted-foreground"), "#d8a5a5");
  assert.equal(token(dark, "burgundy"), "#431822");
  assert.equal(token(dark, "ruby"), "#c55d72");
});

test("claro: fundo creme/marfim e detalhes Red Velvet", () => {
  assert.equal(token(light, "background"), "#f5e9dd");
  assert.equal(token(light, "foreground"), "#3a141b");
  assert.equal(token(light, "primary"), "#922c42");
  assert.equal(token(light, "primary-foreground"), "#f5e9dd");
  assert.match(token(light, "accent"), /rgba\(197, 93, 114, 0\.18\)/);
  assert.equal(token(light, "muted-foreground"), "#6f4149");
});

test("a paleta de referência está toda presente (#431822, #922C42, #C55D72, #F5E9DD, #D8A5A5)", () => {
  const section = dark + light;
  for (const cor of ["#431822", "#922c42", "#c55d72", "#f5e9dd", "#d8a5a5"]) {
    assert.ok(section.toLowerCase().includes(cor), `falta a referência ${cor}`);
  }
});

test("contraste AA nos pares de texto principais (claro e escuro)", () => {
  for (const [modo, b] of [["escuro", dark], ["claro", light]] as const) {
    const pares: Array<[string, string, string]> = [
      ["texto/fundo", token(b, "foreground"), token(b, "background")],
      ["primário/primário-foreground", token(b, "primary-foreground"), token(b, "primary")],
    ];
    for (const [nome, frente, fundo] of pares) {
      const r = contrast(frente, fundo);
      assert.ok(r >= 4.5, `${modo} · ${nome} = ${r.toFixed(2)}:1 (abaixo de AA)`);
    }
  }
});

test("as semânticas de estado ficam iguais às dos outros temas", () => {
  assert.equal(token(dark, "cyber-green"), "#4ecb83");
  assert.equal(token(dark, "cyber-yellow"), "#ffbf3e");
  assert.equal(token(dark, "cyber-red"), "#ff5454");
  assert.equal(token(dark, "cyber-cyan"), "#4dc9d8");
  assert.equal(token(light, "cyber-green"), "#16a34a");
  assert.equal(token(light, "cyber-yellow"), "#d97706");
  assert.equal(token(light, "cyber-red"), "#d43a3a");
});

test("as outras identidades não foram tocadas", () => {
  assert.equal(token(block('[data-theme="cybersafe-core"].dark'), "primary"), "#16d6c1");
  assert.equal(token(block('[data-theme="cybersafe-core"].dark'), "background"), "#07151a");
  for (const outra of [
    '[data-theme="cybersafe-neon"].dark',
    '[data-theme="matrix-terminal"]',
    '[data-theme="cybersafe-liquid"].dark',
  ]) {
    const b = block(outra).toLowerCase();
    for (const cor of ["#c55d72", "#922c42", "#170d10", "#f5e9dd"]) {
      assert.equal(b.includes(cor), false, `${outra} apanhou a paleta Belbete (${cor})`);
    }
  }
});

test("vidro seletivo: os cartões são translúcidos, sem imagens nem texturas de comida", () => {
  for (const [modo, b] of [["escuro", dark], ["claro", light]] as const) {
    assert.match(token(b, "card"), /rgba\([^)]*0\.\d+\)/, `${modo}: cartão opaco, sem translucidez`);
  }
  const secao = css.slice(css.indexOf("BELBETE"), css.indexOf("/* Accent themes"));
  assert.equal(/url\(/.test(secao), false, "o tema passou a carregar imagens");
  assert.equal(/\.(png|jpe?g|webp|gif)\b/i.test(secao), false, "o tema referencia ficheiros de imagem");
});
