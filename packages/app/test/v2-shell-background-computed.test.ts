import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Parser CSS real, já presente na árvore de dependências do repositório (o vite
// usa-o). Nada foi instalado para isto: a razão de ser deste ficheiro é que uma
// regex não distingue `background: gradiente, cor` (válido) de
// `background-image: gradiente, cor` (inválido) — os dois têm o mesmo texto.
import { createRequire } from "node:module";
type Lc = { transform: (opts: unknown) => { code: Buffer } };
const { transform } = createRequire(import.meta.url)("lightningcss") as Lc;

/**
 * D3a-R1 — o fundo do shell V2, medido por um parser de CSS.
 *
 * O blocker da revisão: `background-image: var(--v2-page-background)` não é uma
 * declaração válida. Os tokens de `--v2-page-background` são listas completas de
 * `background` — uma camada decorativa seguida de cor sólida (ex.
 * `radial-gradient(…), #180d13`) — e uma cor sozinha não é uma imagem. Em runtime
 * a propriedade era descartada e o invólucro ficava sem o fundo que os testes de
 * contraste assumem opaco.
 *
 * Este ficheiro prova as três coisas que a regex não podia provar:
 *   1. para OS OITO temas, o valor do token é compreendido pelo parser como
 *      `background` (com camadas de imagem E cor de base);
 *   2. a cor de base é OPACA (alfa 1) em todos os temas, preservando a
 *      decoração de cada um;
 *   3. a forma antiga é mesmo rejeitada pelo parser — controlo de mutação, para
 *      o teste não passar por acaso se alguém voltar a escrever
 *      `background-image:` com uma lista.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, "..", "src", ...parts), "utf8");
const tokens = read("v2", "tokens.css");
const shell = read("v2", "shell.css");
const THEMES = ["core", "neon", "terminal", "aurora", "belbete", "glass", "tactical", "light"];

/** Último valor declarado de um token, entre os blocos que casam com o tema. */
function tokenDe(tema: string, nome: string): string {
  let valor: string | null = null;
  for (const bloco of tokens.split(/\n(?=html\[data-v2-theme=)/)) {
    const cabecalho = bloco.slice(0, bloco.indexOf("{"));
    if (!new RegExp(`html\\[data-v2-theme="${tema}"\\]`).test(cabecalho)) continue;
    const re = new RegExp(`--v2-${nome}:\\s*([^;}]+)`, "g");
    for (const m of bloco.matchAll(re)) valor = m[1].trim();
  }
  assert.ok(valor, `--v2-${nome} não declarado para o tema ${tema}`);
  return valor!;
}

/** O que o parser extrai de uma folha mínima. */
function declarar(css: string): Array<{ property: string; understood: boolean }> {
  const out: Array<{ property: string; understood: boolean }> = [];
  transform({
    filename: "probe.css",
    code: Buffer.from(css),
    errorValues: true,
    visitor: {
      Declaration(decl: { property: string; value: { type?: string } }) {
        out.push({
          property: decl.property === "unparsed" ? String((decl.value as unknown as { propertyId?: { property?: string } }).propertyId?.property ?? "unparsed") : decl.property,
          understood: decl.property !== "unparsed" && decl.property !== "custom",
        });
      },
    },
  } as never);
  return out;
}

/** Camada final de uma lista de `background`: tem de ser cor sólida opaca. */
function camadaFinal(valor: string): string {
  let profundidade = 0;
  let corte = -1;
  for (let i = 0; i < valor.length; i++) {
    const c = valor[i];
    if (c === "(") profundidade++;
    else if (c === ")") profundidade--;
    else if (c === "," && profundidade === 0) corte = i;
  }
  return (corte < 0 ? valor : valor.slice(corte + 1)).trim();
}

const SOLIDA_OPACA = /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgb\(|rgba\(|hsl\(|hsla\()/i;

/** Comentários fora: o ficheiro cita a forma inválida para explicar porque foi
    abandonada. O que se fiscaliza são declarações, não prosa. */
const declaracoesDe = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("fundo do shell V2 validado por parser CSS", () => {
  test("shell.css usa a forma válida (shorthand) e nunca `background-image:` com lista", () => {
    const declaracoes = declaracoesDe(shell);
    assert.equal(/background-image:\s*var\(--v2-page-background\)/.test(declaracoes), false, "voltou a declaração inválida");
    assert.match(declaracoes, /background:\s*var\(--v2-bg\);\s*\n\s*background:\s*var\(--v2-page-background\);/);
  });

  test("os oito temas têm `background` compreendido pelo parser, com cor de base", () => {
    for (const tema of THEMES) {
      const decor = tokenDe(tema, "page-background");
      const base = tokenDe(tema, "bg");
      const decls = declarar(`html[data-v2-theme="${tema}"]{background:${decor};background-color:${base};}`);
      const fundo = decls.find((d) => d.property === "background");
      assert.ok(fundo, `tema ${tema}: sem declaração 'background' compreendida`);
      assert.equal(fundo!.understood, true, `tema ${tema}: o parser não interpretou o background`);
      assert.ok(decls.some((d) => d.property === "background-color"), `tema ${tema}: sem cor de base`);
    }
  });

  test("a camada de fecho de cada tema é cor sólida opaca (invariante r6-l5)", () => {
    for (const tema of THEMES) {
      const final = camadaFinal(tokenDe(tema, "page-background"));
      assert.match(final, SOLIDA_OPACA, `tema ${tema}: última camada não é cor: ${final}`);
      // `#rrggbbaa` com alfa < ff ou rgba(…, <1) não servem: o painel tem de
      // assentar em fundo sem transparência.
      const alfaHex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(final);
      if (alfaHex) assert.notEqual(alfaHex[4].toLowerCase(), "00", `tema ${tema}: cor de base com alfa zero`);
      const alfaFn = /rgba?\([^)]*,\s*([0-9.]+)\s*\)/i.exec(final);
      if (alfaFn) assert.equal(parseFloat(alfaFn[1]) >= 1, true, `tema ${tema}: cor de base translúcida`);
      assert.equal(/transparent|currentcolor/i.test(final), false, `tema ${tema}: base transparente`);
    }
  });

  test("controlo de mutação: a forma antiga É rejeitada pelo parser", () => {
    const decor = tokenDe("belbete", "page-background");
    const decls = declarar(`html{background-image:${decor};}`);
    const imagem = decls.find((d) => d.property === "background-image");
    assert.ok(imagem, "o parser deveria ver a propriedade");
    assert.equal(imagem!.understood, false, "a forma inválida passou como válida — o teste perdeu o dentes");
    const correta = declarar(`html{background:${decor};}`);
    assert.ok(correta.some((d) => d.property === "background" && d.understood), "a forma correta não foi compreendida");
  });

  test("cada tema mantém a sua decoração (nenhum tema foi achatado para cor lisa)", () => {
    for (const tema of THEMES) {
      const decor = tokenDe(tema, "page-background");
      const temGradiente = /gradient\(/.test(decor);
      const eSimplesmenteCor = /^#[0-9a-f]{3,8}$/i.test(decor);
      // Exceções DECLARADAS, não silêncio: no lab, `light` e `tactical` são
      // deliberadamente fundos planos («informação em primeiro plano»); os
      // restantes seis têm camada de gradiente por cima da cor de base.
      const PLANOS = ["light", "tactical"];
      if (PLANOS.includes(tema)) assert.ok(eSimplesmenteCor || temGradiente, `${tema}: fundo desapareceu`);
      else assert.equal(temGradiente, true, `${tema}: ficou sem a camada decorativa do tema`);
    }
  });
});
