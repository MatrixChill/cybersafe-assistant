import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P1-B — os dois eixos do tema têm de estar separados:
 *   COLOR MODE (light | dark) → só muda tokens de cor.
 *   TYPOGRAPHY (identidade do tema) → muda apenas com o tema, nunca com o modo.
 *
 * O mini-cascade abaixo resolve --font-inter / --font-jetbrains por tema×modo a
 * partir do CSS real e falha se Light e Dark voltarem a ter famílias diferentes.
 */

const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.css");
const css = fs.readFileSync(cssPath, "utf8");

type Rule = { selector: string; body: string };

/** Parses every `selector { ... }` rule at any nesting depth, comments removed. */
function parseRules(source: string): Rule[] {
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let i = 0;
  let preludeStart = 0;
  const stack: { selector: string; bodyStart: number }[] = [];
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === "{") {
      stack.push({ selector: cleaned.slice(preludeStart, i).trim(), bodyStart: i + 1 });
      preludeStart = i + 1;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (frame) {
        const body = cleaned.slice(frame.bodyStart, i);
        // Prelúdio pode trazer at-rules terminadas em ";" antes do selector.
        const sel = frame.selector.slice(frame.selector.lastIndexOf(";") + 1).trim();
        rules.push({ selector: sel, body });
        // nested rules are captured by their own frame; the outer body here may
        // still contain them — declaration lookups below only read font tokens
        // from bodies that do NOT contain "{" (i.e. real declaration blocks).
      }
      preludeStart = i + 1;
    }
    i++;
  }
  return rules.filter((r) => !r.body.includes("{"));
}

const FONT_TOKENS = ["--font-inter", "--font-jetbrains"] as const;

type Decl = { selector: string; token: string; value: string };

function fontDeclarations(rules: Rule[]): Decl[] {
  const decls: Decl[] = [];
  for (const rule of rules) {
    for (const token of FONT_TOKENS) {
      const m = rule.body.match(new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([^;]+);`));
      if (m) decls.push({ selector: rule.selector, token, value: m[1].trim() });
    }
  }
  return decls;
}

const THEMES = [
  "cybersafe-core",
  "cybersafe-neon",
  "cybersafe-liquid",
  "cybersafe-red-belbete",
  "matrix-terminal",
];

/** Resolves a token for theme×mode mimicking the cascade: later match wins. */
function resolveToken(decls: Decl[], token: string, theme: string, mode: "light" | "dark"): string | undefined {
  let value: string | undefined;
  for (const d of decls) {
    if (d.token !== token) continue;
    const sel = d.selector;
    const targetsTheme = new RegExp(`\\[data-theme="${theme}"\\]`).test(sel);
    // O preâmbulo do primeiro bloco traz os @import/@custom-variant à frente
    // de ":root", por isso o teste é de sufixo, não de igualdade.
    const isGlobal = /:root\s*$/.test(sel) || /^html\s*$/.test(sel);
    if (!targetsTheme && !isGlobal) continue;
    const isDarkOnly = /\.dark\b|:is\(\.dark\b/.test(sel) && !/:not\(\.dark\)/.test(sel);
    const isLightOnly = /:not\(\.dark\)/.test(sel);
    if (mode === "dark" && isLightOnly) continue;
    if (mode === "light" && isDarkOnly) continue;
    value = d.value;
  }
  return value;
}

describe("P1-B — tipografia estável entre light e dark", () => {
  const rules = parseRules(css);
  const decls = fontDeclarations(rules);

  test("o CSS tem blocos de tema suficientes para o parser não estar cego", () => {
    assert.ok(rules.length > 50, `esperava muitas regras, obtive ${rules.length}`);
    assert.ok(decls.length > 0, "nenhuma declaração --font-inter/--font-jetbrains encontrada");
  });

  test("nenhum selector de cor (.dark / :not(.dark)) declara tokens de fonte", () => {
    for (const d of decls) {
      assert.doesNotMatch(
        d.selector,
        /\.dark\b|:not\(\.dark\)/,
        `fonte declarada num selector acoplado ao color mode: "${d.selector}" define ${d.token}`,
      );
    }
  });

  test("para cada tema, light e dark resolvem a MESMA família", () => {
    for (const theme of THEMES) {
      for (const token of FONT_TOKENS) {
        const light = resolveToken(decls, token, theme, "light");
        const dark = resolveToken(decls, token, theme, "dark");
        assert.ok(light !== undefined, `${theme}: ${token} não resolve em light`);
        assert.equal(light, dark, `${theme}: ${token} difere entre light (${light}) e dark (${dark})`);
      }
    }
  });

  test("CyberSafe (não-matrix) usa Inter/JetBrains padrão nos dois modos", () => {
    for (const theme of THEMES.filter((t) => t !== "matrix-terminal")) {
      const inter = resolveToken(decls, "--font-inter", theme, "dark");
      assert.match(inter ?? "", /^'Inter'/, `${theme}: família base deveria ser Inter`);
    }
  });

  test("Matrix Terminal preserva a sua tipografia monospace em light e dark", () => {
    for (const mode of ["light", "dark"] as const) {
      const inter = resolveToken(decls, "--font-inter", "matrix-terminal", mode);
      assert.match(inter ?? "", /'JetBrains Mono'/, `matrix ${mode}: deveria ser JetBrains Mono`);
    }
  });
});
