import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6-L5 1 — RE-MEDIR o AA dos `--state-*-ink`, a calculo e nao por monotonia.
 *
 * A ronda 6-L1 introduziu os cinco estados derivados (`--state-ok/warn/crit/
 * proc/na-ink`) e a nota no fonte dizia que «misturar para o foreground só pode
 * subir o contraste». Isso é inferência, não medição: a mistura é feita em
 * OKLCH, o fundo do chip é a TINTA do estado por cima do painel, e o painel é
 * translúcido por cima do fundo da página. Este ficheiro resolve a folha real
 * (os 5 temas × claro/escuro × os 3 materiais), compõe as camadas e calcula a
 * razão de contraste WCAG 2.1 de cada tinta sobre o fundo em que ela é davvero
 * pintada. Nada de limiares ajustados: o alvo é 4,5:1 para texto normal.
 *
 * Aproximações declaradas (o que NÃO foi medido no browser):
 *   · `color-mix(in oklch)` é interpolado em OKLab com as componentes
 *     pré-multiplicadas pelo alfa, como pede a especificação; o matiz segue a
 *     interpolação linear de a/b, que coincide com o arco mais curto quando as
 *     cromaticidades são baixas (é o caso dos neutros medidos aqui).
 *   · Cores OKLCH fora do gamut sRGB são cortadas canal a canal.
 *   · A composição das camadas é feita em luz-linear (Compositing & Blending
 *     1, `linearRGB` por omissão).
 *   · O painel por baixo do chip é `--material-*-fill` por cima de
 *     `--background`. Os gradientes decorativos do `<html>` (Núcleo claro e
 *     Belbete) ficam INVISÍveis atrás do `bg-background` opaco do wrapper do
 *     App, por isso não entram na média; é medido, não assumido, no teste 4.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, "..", "src", "index.css"), "utf8");
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");

/* ═══ 1 — modelo de cor ═══════════════════════════════════════════════════ */

type RGBA = { r: number; g: number; b: number; a: number };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function relativeLuminance(c: RGBA): number {
  return (
    0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b)
  );
}

/** Razão WCAG 2.1 — definida para as duas camadas já opacas. */
function contrastRatio(fg: RGBA, bg: RGBA): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` por cima de `bg`, em luz-linear. */
function composite(fg: RGBA, bg: RGBA): RGBA {
  if (fg.a >= 1) return fg;
  if (bg.a === 0) return { ...fg };
  const outA = fg.a + bg.a * (1 - fg.a);
  const chan = (f: number, b: number) => {
    const lf = srgbToLinear(f) * fg.a;
    const lb = srgbToLinear(b) * bg.a * (1 - fg.a);
    return linearToSrgb(outA > 0 ? (lf + lb) / outA : 0);
  };
  return { r: clamp01(chan(fg.r, bg.r)), g: clamp01(chan(fg.g, bg.g)), b: clamp01(chan(fg.b, bg.b)), a: outA };
}

/**
 * Matriz linear sRGB → LMS (Ottosson). A inversa NÃO é escrita à mão: é
 * calculada a partir desta. Foi exatamente aqui que a minha primeira versão
 * estava errada — as constantes `4.0767 / -1.2684 / -0.0042` que andam pela
 * internet são a COLUNA desta matriz, e usá-las como linha transformava
 * `oklch(.65 .17 155)` (verde) em verde-oliva. O teste 1c fecha o assunto com
 * ida-e-volta.
 */
const RGB_TO_LMS = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];

/** Adjunta / determinante, linha a linha. Foi aqui que a minha primeira
    versão esteve errada: `(c*f - b*i)` no lugar de `(c*h - b*i)` trocava só o
    canal R, e um ciano ficava com 0.71 de vermelho — sem rebentar nada. */
function invert3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error("matriz singular");
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const LMS_TO_RGB = invert3(RGB_TO_LMS);

function oklabToLinearOklch(L: number, C: number, Hdeg: number): [number, number, number] {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    LMS_TO_RGB[0][0] * l + LMS_TO_RGB[0][1] * m + LMS_TO_RGB[0][2] * s,
    LMS_TO_RGB[1][0] * l + LMS_TO_RGB[1][1] * m + LMS_TO_RGB[1][2] * s,
    LMS_TO_RGB[2][0] * l + LMS_TO_RGB[2][1] * m + LMS_TO_RGB[2][2] * s,
  ];
}

function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = RGB_TO_LMS[0][0] * r + RGB_TO_LMS[0][1] * g + RGB_TO_LMS[0][2] * b;
  const m = RGB_TO_LMS[1][0] * r + RGB_TO_LMS[1][1] * g + RGB_TO_LMS[1][2] * b;
  const s = RGB_TO_LMS[2][0] * r + RGB_TO_LMS[2][1] * g + RGB_TO_LMS[2][2] * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

/** sRGB → OKLCH; só existe para o controlo de ida-e-volta do teste 1c. */
function rgbToOklch(c: RGBA): [number, number, number] {
  const [L, A, B] = linearToOklab(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function toOklab(c: RGBA): [number, number, number] {
  return linearToOklab(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

/**
 * `color-mix(in oklch, A p%, B)` — componentes pré-multiplicadas, alfa
 * interpolado. É isto que faz `transparent` (alfa 0) devolver A com alfa p%,
 * sem dessaturar a tinta: a especificação não precisa de um caso especial.
 */
function mixInOklch(a: RGBA, b: RGBA, shareA: number): RGBA {
  const p = shareA;
  const q = 1 - shareA;
  const alphaOut = a.a * p + b.a * q;
  const [La, Aa, Ba] = toOklab(a);
  const [Lb, Ab, Bb] = toOklab(b);
  const mix = (x: number, y: number) => (alphaOut > 0 ? (x * a.a * p + y * b.a * q) / alphaOut : 0);
  const L = mix(La, Lb);
  const A = mix(Aa, Ab);
  const B = mix(Ba, Bb);
  const [lr, lg, lb] = oklabToLinearOklch(L, Math.sqrt(A * A + B * B), (Math.atan2(B, A) * 180) / Math.PI);
  return { r: clamp01(linearToSrgb(clamp01(lr))), g: clamp01(linearToSrgb(clamp01(lg))), b: clamp01(linearToSrgb(clamp01(lb))), a: alphaOut };
}

function mixInSrgb(a: RGBA, b: RGBA, shareA: number): RGBA {
  const q = 1 - shareA;
  const alphaOut = a.a * shareA + b.a * q;
  const chan = (x: number, y: number, ax: number, ay: number) =>
    alphaOut > 0 ? (x * ax * shareA + y * ay * q) / alphaOut : 0;
  return {
    r: clamp01(chan(a.r, b.r, a.a, b.a)),
    g: clamp01(chan(a.g, b.g, a.a, b.a)),
    b: clamp01(chan(a.b, b.b, a.a, b.a)),
    a: alphaOut,
  };
}

/* ═══ 2 — leitura da folha: blocos, especificidade, resolução de tokens ═══ */

type Rule = { selectors: string[]; decls: [string, string][]; order: number; spec: number };

/** divide por vírgulas ao nível de profundidade 0 (não parte `:not(a, b)`). */
function splitTop(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseRules(sheet: string): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  let order = 0;
  while (i < sheet.length) {
    while (i < sheet.length && /\s/.test(sheet[i])) i++;
    if (i >= sheet.length) break;
    if (sheet[i] === "@") {
      // @import/@custom-variant terminam em `;`; @media/@layer/@theme/@keyframes
      // têm bloco — o conteúdo deles não define os tokens aqui medidos.
      const semi = sheet.indexOf(";", i);
      const brace = sheet.indexOf("{", i);
      if (semi >= 0 && (brace < 0 || semi < brace)) {
        i = semi + 1;
        continue;
      }
      let depth = 1;
      let j = brace + 1;
      while (j < sheet.length && depth > 0) {
        if (sheet[j] === "{") depth++;
        else if (sheet[j] === "}") depth--;
        j++;
      }
      i = j;
      continue;
    }
    const brace = sheet.indexOf("{", i);
    if (brace < 0) break;
    const selectorText = sheet.slice(i, brace).trim();
    let depth = 1;
    let end = brace + 1;
    while (end < sheet.length && depth > 0) {
      if (sheet[end] === "{") depth++;
      else if (sheet[end] === "}") depth--;
      end++;
    }
    const body = sheet.slice(brace + 1, end - 1);
    const declarations: [string, string][] = [];
    for (const decl of splitTop(body, ";")) {
      const colon = decl.indexOf(":");
      if (colon > 0) declarations.push([decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()]);
    }
    if (selectorText && declarations.length) {
      const selectors = splitTop(selectorText, ",");
      rules.push({ selectors, decls: declarations, order: order++, spec: specificity(selectors[0]) });
    }
    i = end;
  }
  return rules;
}

/** Especificidade de um seletor COMPOSTO de elemento único (`:root.dark[x]`). */
function specificity(sel: string): number {
  let n = 0;
  const cleaned = sel.replace(/:not\(([^)]*)\)/g, (_m, inner: string) => {
    n += specificity(inner);
    return "";
  });
  n += (cleaned.match(/\[[^\]]*\]/g) ?? []).length;
  n += (cleaned.match(/\.[A-Za-z0-9_-]+/g) ?? []).length;
  n += (cleaned.match(/:[a-z-]+[a-z0-9-]*/g) ?? []).length - (cleaned.match(/::/g) ?? []).length;
  n += (cleaned.match(/^[a-z]+/gi) ?? []).length;
  return n;
}

type Ctx = { identity: string; mode: "dark" | "light"; surface: string };

/** o composto casa o <html> neste contexto? */
function matchesHtml(sel: string, ctx: Ctx): boolean {
  if (/[\s>+~]/.test(sel)) return false; // seletor de descendente: nunca é o <html>
  const parts = sel.match(/(:not\([^)]*\)|\[[^\]]*\]|\.[A-Za-z0-9_-]+|:[A-Za-z-]+[A-Za-z0-9-]*|[A-Za-z][\w-]*)/g) ?? [];
  for (const part of parts) {
    if (part.startsWith(":not(")) {
      const inner = part.slice(5, -1).trim();
      if (matchesHtml(inner, ctx)) return false;
      continue;
    }
    if (part === ":root" || part.startsWith("*")) continue;
    if (part.startsWith(".")) {
      const cls = part.slice(1);
      if (cls === "dark") { if (ctx.mode !== "dark") return false; continue; }
      if (cls === "light") { if (ctx.mode !== "light") return false; continue; }
      return false; // classe num elemento que não é o <html>
    }
    if (part.startsWith("[")) {
      const m = /^\[([a-zA-Z-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(part);
      if (!m) return false;
      const [, name, value] = m;
      const actual = name === "data-theme" ? ctx.identity : name === "data-surface" ? ctx.surface : undefined;
      if (actual === undefined) return false;
      if (value !== undefined && value !== "" && actual !== value) return false;
      continue;
    }
    return false; // pseudo-elemento ou etiqueta que não é o <html>
  }
  return true;
}

const PARSED = parseRules(decls);
/** O que `rawToken` lê. Trocado apenas pelo controlo do teste 1b, que
    reinterpreta uma folha mutada em memória para provar que os números acima
    vêm mesmo do `index.css` e não de uma fórmula deste ficheiro. */
let ACTIVE_RULES = PARSED;


/** Token → valor literal, com a cascata do <html> naquele contexto. */
function rawToken(name: string, ctx: Ctx): string | null {
  let found: string | null = null;
  let best = -1;
  for (const rule of ACTIVE_RULES) {
    if (rule.spec * 1000 + rule.order <= best) continue;
    if (!rule.selectors.some((s) => matchesHtml(s, ctx))) continue;
    for (const [prop, value] of rule.decls) {
      if (prop === name) {
        found = value;
        best = rule.spec * 1000 + rule.order;
      }
    }
  }
  return found;
}

/** substitui `var(--x)` / `var(--x, reserva)` recursivamente. */
function expandVars(value: string, ctx: Ctx, guard = 0): string {
  if (guard > 24) throw new Error(`var() aninhado demais: ${value}`);
  const idx = value.indexOf("var(");
  if (idx < 0) return value;
  let depth = 1;
  let end = idx + 4;
  while (end < value.length && depth > 0) {
    if (value[end] === "(") depth++;
    else if (value[end] === ")") depth--;
    end++;
  }
  const inner = value.slice(idx + 4, end - 1);
  const comma = splitTop(inner, ",");
  const name = comma[0].trim();
  const fallback = comma.length > 1 ? comma.slice(1).join(",").trim() : null;
  const resolved = rawToken(name, ctx);
  if (resolved === null) {
    if (fallback === null) throw new Error(`token ${name} não existe no contexto ${ctx.identity}/${ctx.mode}`);
    return expandVars(value.slice(0, idx) + fallback + value.slice(end), ctx, guard + 1);
  }
  return expandVars(value.slice(0, idx) + resolved + value.slice(end), ctx, guard + 1);
}

function parseColor(text: string): RGBA | null {
  const value = text.trim().replace(/\s+/g, " ");
  if (!value) return null;
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (value === "none" || value.startsWith("current")) return null;
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (m) return { r: parseInt(m[1], 16) / 15, g: parseInt(m[2], 16) / 15, b: parseInt(m[3], 16) / 15, a: 1 };
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(value);
  if (m) {
    return {
      r: parseInt(m[1], 16) / 255,
      g: parseInt(m[2], 16) / 255,
      b: parseInt(m[3], 16) / 255,
      a: m[4] === undefined ? 1 : parseInt(m[4], 16) / 255,
    };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (m) {
    const bits = m[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
    const [r, g, b] = bits.slice(0, 3).map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v) / 255));
    const a = bits.length > 3 ? parseFloat(bits[3]) : 1;
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a) };
  }
  m = /^oklch\(([^)]+)\)$/i.exec(value);
  if (m) {
    const bits = m[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
    const L = parseFloat(bits[0]);
    const C = bits[1] === "none" ? 0 : parseFloat(bits[1]);
    const H = bits[2] === "none" ? 0 : parseFloat(bits[2]);
    const a = bits.length > 3 ? parseFloat(bits[3]) : 1;
    const [lr, lg, lb] = oklabToLinearOklch(L, C, H);
    return { r: clamp01(linearToSrgb(lr)), g: clamp01(linearToSrgb(lg)), b: clamp01(linearToSrgb(lb)), a: clamp01(a) };
  }
  return null;
}

/** expressão de cor → RGBA, com `color-mix` aninhado e tudo. */
function computeColor(expr: string, ctx: Ctx): RGBA {
  const value = expandVars(expr, ctx);
  const start = value.indexOf("color-mix(");
  if (start < 0) {
    const color = parseColor(value);
    if (!color) throw new Error(`não é cor: "${expr}" → "${value}"`);
    return color;
  }
  let depth = 1;
  let end = start + 10;
  while (end < value.length && depth > 0) {
    if (value[end] === "(") depth++;
    else if (value[end] === ")") depth--;
    end++;
  }
  const inner = value.slice(start + 10, end - 1);
  const args = splitTop(inner, ",");
  const space = /^in\s+([a-z0-9-]+)$/i.exec(args[0]?.trim() ?? "")?.[1] ?? "oklch";
  if (args.length !== 3) throw new Error(`color-mix com ${args.length - 1} cores (só aceita duas): "${expr}"`);
  const parseSide = (side: string): { color: string; pct: number | null } => {
    const pctMatch = /(\d+(?:\.\d+)?)%\s*$/.exec(side);
    if (pctMatch) return { color: side.replace(pctMatch[0], "").trim(), pct: parseFloat(pctMatch[0]) / 100 };
    return { color: side.trim(), pct: null };
  };
  const a = parseSide(args[1]);
  const b = parseSide(args[2]);
  const shareA = a.pct !== null ? a.pct : b.pct !== null ? 1 - b.pct : 0.5;
  const ca = computeColor(a.color, ctx);
  const cb = computeColor(b.color, ctx);
  return space === "srgb" ? mixInSrgb(ca, cb, shareA) : mixInOklch(ca, cb, shareA);
}

/* ═══ 3 — a matriz ════════════════════════════════════════════════════════ */

const IDENTITIES = ["cybersafe-core", "cybersafe-neon", "matrix-terminal", "cybersafe-liquid", "cybersafe-red-belbete"];
const MODES = ["dark", "light"] as const;
const MATERIALS = ["glass", "reduced", "solid"] as const;
const STATES = ["ok", "warn", "crit", "proc", "na"] as const;

const ALVO_AA = 4.5;
const ALVO_AA_LARGE = 3;

/**
 * A declaração que GANHA para `prop` num gancho de elemento (`.stat-card`),
 * naquele contexto de <html>. É assim que o painel do chip é lido: da folha,
 * com a cascata — não de uma cópia deste teste.
 */
function winningDeclaration(hook: string, prop: string, ctx: Ctx): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const rule of ACTIVE_RULES) {
    for (const sel of rule.selectors) {
      const compounds = sel.split(/\s+/).filter(Boolean);
      if (compounds[compounds.length - 1] !== hook) continue;
      if (!compounds.slice(0, -1).every((c) => matchesHtml(c, ctx))) continue;
      const decl = rule.decls.find(([p]) => p === prop);
      if (!decl) continue;
      const score = specificity(sel) * 1000 + rule.order;
      if (score > bestScore) {
        bestScore = score;
        best = decl[1];
      }
    }
  }
  return best;
}

/** O painel onde o chip vive: o enchimento do material por cima do fundo. */
function plateFor(ctx: Ctx): RGBA {
  const fill = winningDeclaration(".stat-card", "background-color", ctx) ?? "var(--card)";
  return composite(computeColor(fill, ctx), computeColor(rawToken("--background", ctx)!, ctx));
}

/** O enchimento do material, sem o fundo por baixo — para medir transparência. */
function fillOf(ctx: Ctx): RGBA {
  return computeColor(winningDeclaration(".stat-card", "background-color", ctx) ?? "var(--card)", ctx);
}

type Row = {
  identity: string;
  mode: string;
  material: string;
  state: string;
  ratio: number;
  ratioSemTinta: number;
  ink: string;
  bgLum: number;
};

function measure(): Row[] {
  const rows: Row[] = [];
  for (const identity of IDENTITIES) {
    for (const mode of MODES) {
      const base: Ctx = { identity, mode, surface: "glass" };
      const plateByMaterial = new Map<string, RGBA>(
        MATERIALS.map((material) => [material, plateFor({ ...base, surface: material })] as const),
      );
      for (const state of STATES) {
        const inkExpr = rawToken(`--state-${state}-ink`, base)!;
        const tintExpr = rawToken(`--state-${state}-tint`, base)!;
        const ink = computeColor(inkExpr, base);
        if (ink.a < 1) throw new Error(`--state-${state}-ink tem alfa ${ink.a} em ${identity}/${mode}: tinta de texto translúcida`);
        const tint = computeColor(tintExpr, base);
        for (const material of MATERIALS) {
          const plate = plateByMaterial.get(material)!;
          const chipBg = composite(tint, plate);
          rows.push({
            identity,
            mode,
            material,
            state,
            ratio: contrastRatio(ink, chipBg),
            bgLum: relativeLuminance(chipBg),
            ratioSemTinta: contrastRatio(ink, plate),
            ink: `#${[ink.r, ink.g, ink.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`,
          });
        }
      }
    }
  }
  return rows;
}

const rows = measure();
const fmt = (v: number) => v.toFixed(2) + ":1";

describe("R6-L5 1 — AA medido dos cinco estados (150 combinações)", () => {
  test("a matriz resolveu: 5 temas × 2 modos × 3 materiais × 5 estados", () => {
    assert.equal(rows.length, 150, "cada combinação tem de estar medida");
    assert.ok(rows.every((r) => Number.isFinite(r.ratio)), "nenhuma razão pode ser NaN");
  });

  test("texto normal: nenhuma tinta de estado fica abaixo de 4,5:1", () => {
    const falhas = rows.filter((r) => r.ratio < ALVO_AA);
    const tabela = rows
      .map((r) => `  ${r.identity.padEnd(21)} ${r.mode.padEnd(5)} ${r.material.padEnd(7)} ${r.state.padEnd(4)} chip ${fmt(r.ratio).padEnd(8)} painel ${fmt(r.ratioSemTinta).padEnd(8)} ${r.ink}`)
      .join("\n");
    console.log(`\n── R6-L5 contraste medido (--state-*-ink sobre o chip) ──\n${tabela}\n`);
    if (falhas.length > 0) {
      const detalhe = falhas
        .map((r) => `${r.identity}/${r.mode}/${r.material}/${r.state} = ${fmt(r.ratio)} ink ${r.ink} L_bg=${r.bgLum.toFixed(4)} precisa L_ink>=${(4.6 * (r.bgLum + 0.05) - 0.05).toFixed(4)}`)
        .join("\n  ");
      assert.fail(`${falhas.length} combinações abaixo de AA (4,5:1):\n  ${detalhe}`);
    }
  });

  test("mesmo sem a tinta do estado (chip sobre painel limpo) passa AA", () => {
    const falhas = rows.filter((r) => r.ratioSemTinta < ALVO_AA);
    assert.equal(falhas.length, 0, `abaixo de AA sem tinta: ${falhas.map((r) => `${r.identity}/${r.mode}/${r.state}=${fmt(r.ratioSemTinta)}`).join(", ")}`);
  });

  test("AA-large (3:1) é o mínimo absoluto — 12px e etiquetas dependem dele", () => {
    const pior = Math.min(...rows.map((r) => r.ratio));
    assert.ok(pior >= ALVO_AA_LARGE, `pior caso ${fmt(pior)} nem a AA-large passa`);
  });
});

describe("R6-L5 1c — o conversor está certo (sem isto, os números acima são fé)", () => {
  test("ida e volta: hex → OKLCH → hex, nas cores do produto", () => {
    for (const hex of ["#16d6c1", "#56d48a", "#ff5c5c", "#ffbf3e", "#0e6f68", "#9a4a06", "#b91c1c", "#dfecef", "#07151a"]) {
      const original = parseColor(hex)!;
      const [L, C, H] = rgbToOklch(original);
      const volta = parseColor(`oklch(${L} ${C} ${H})`)!;
      const desvio = Math.max(
        Math.abs(volta.r - original.r),
        Math.abs(volta.g - original.g),
        Math.abs(volta.b - original.b),
      );
      assert.ok(desvio < 1 / 255, `${hex} voltou a ${Math.round(desvio * 255)}/255 de distância`);
    }
  });

  test("verde é verde: oklch(0.65 0.17 155) tem o verde à frente do vermelho", () => {
    // O erro que este teste apanhou: com a matriz trocada, o `--cyber-green`
    // do Líquido escuro era lido como oliva e todas as razões da matriz
    // estavam erradas sem que nada falhasse.
    const verde = parseColor("oklch(0.65 0.17 155)")!;
    assert.ok(verde.g > verde.r + 0.3, `esperava verde dominante, obtive r=${verde.r.toFixed(3)} g=${verde.g.toFixed(3)}`);
    assert.ok(verde.g > verde.b + 0.2, `azul de mais para verde: b=${verde.b.toFixed(3)}`);
  });

  test("os três neutros de referência do OKLCH batem certo", () => {
    assert.deepEqual(
      Object.values(parseColor("oklch(1 0 0)")!).slice(0, 3).map((v) => Math.round(v * 255)),
      [255, 255, 255],
      "oklch(1 0 0) é branco",
    );
    assert.deepEqual(
      Object.values(parseColor("oklch(0 0 0)")!).slice(0, 3).map((v) => Math.round(v * 255)),
      [0, 0, 0],
      "oklch(0 0 0) é preto",
    );
    const meio = parseColor("oklch(0.5 0 0)")!;
    assert.ok(Math.abs(meio.r - 0.388) < 0.01, `cinza intermédio: ${meio.r}`);
  });

  test("preto e branco são os extremos, e a luminância relativa bate certo", () => {
    assert.ok(Math.abs(relativeLuminance(parseColor("#ffffff")!) - 1) < 1e-6);
    assert.equal(relativeLuminance(parseColor("#000000")!), 0);
    assert.ok(Math.abs(contrastRatio(parseColor("#000000")!, parseColor("#ffffff")!) - 21) < 0.01);
    // #767676 é o cinza de referência do AA: 4,54:1 sobre branco.
    assert.ok(Math.abs(contrastRatio(parseColor("#767676")!, parseColor("#ffffff")!) - 4.54) < 0.02);
  });

  test("color-mix com transparent devolve a cor com o alfa pedido", () => {
    const ctx: Ctx = { identity: "cybersafe-core", mode: "dark", surface: "glass" };
    const mistura = computeColor("color-mix(in oklch, #56d48a 15%, transparent)", ctx);
    assert.ok(Math.abs(mistura.a - 0.15) < 1e-6, `alfa ${mistura.a}`);
    const cheia = parseColor("#56d48a")!;
    assert.ok(Math.abs(mistura.g - cheia.g) < 1e-3, "a componente não pode dessaturar contra transparent");
  });
});

describe("R6-L5 1b — a origem dos números é a folha, não este teste", () => {
  test("controlo: a tinta crua da marca, no lugar da variante -text, rebenta o guarda", () => {
    // O que este teste prova: as razões acima são lidas da FOLHA. Em claro, o
    // âmbar de cheio (#d97706) no lugar do âmbar de texto (#9a4a06) tem de
    // fazer baixar a razão medida — se o teste continuasse verde, estaria a
    // calcular qualquer coisa que não o CSS.
    const antes = rows.find((r) => r.identity === "cybersafe-core" && r.mode === "light" && r.state === "warn")!;
    const mutado = decls.replace("--cyber-yellow-text: #9a4a06;", "--cyber-yellow-text: #d97706;");
    assert.notEqual(mutado, decls, "a mutação tem de acontecer no texto da folha");
    ACTIVE_RULES = parseRules(mutado);
    try {
      const depois = measure().find((r) => r.identity === "cybersafe-core" && r.mode === "light" && r.state === "warn")!;
      assert.ok(depois.ratio < antes.ratio - 0.5, `a medição não reagiu à folha: ${fmt(antes.ratio)} → ${fmt(depois.ratio)}`);
    } finally {
      ACTIVE_RULES = PARSED;
    }
    const restaurado = rows.find((r) => r.identity === "cybersafe-core" && r.mode === "light" && r.state === "warn")!;
    assert.equal(fmt(restaurado.ratio), fmt(antes.ratio), "o estado global volta ao da folha");
  });

  test("os cinco `--state-*-ink` resolvem em todos os contextos", () => {
    for (const identity of IDENTITIES) {
      for (const mode of MODES) {
        const ctx: Ctx = { identity, mode, surface: "glass" };
        for (const state of STATES) {
          const expr = rawToken(`--state-${state}-ink`, ctx);
          assert.ok(expr, `falta --state-${state}-ink em ${identity}/${mode}`);
          const color = computeColor(expr, ctx);
          assert.ok(color.a === 1, `tinta de texto com alfa em ${identity}/${mode}/${state}`);
        }
      }
    }
  });

  test("o fundo do <html> fica tapado: o painel assenta em --background opaco", () => {
    // Justifica a aproximação declarada no topo: o wrapper do App é
    // `bg-background` opaco, por isso os radiais pintados no <html> (Núcleo
    // claro, Belbete) não chegam a aparecer por trás dos cartões.
    const app = fs.readFileSync(path.join(HERE, "..", "src", "App.tsx"), "utf8");
    assert.match(app, /flex h-screen bg-background/, "o wrapper opaco é o que está por trás dos painéis");
    for (const identity of IDENTITIES) {
      for (const mode of MODES) {
        const bg = computeColor(rawToken("--background", { identity, mode, surface: "glass" })!, { identity, mode, surface: "glass" });
        assert.equal(bg.a, 1, `--background tem de ser opaco em ${identity}/${mode}`);
      }
    }
  });

  test("o texto secundário (.row-note) também tem de se ler nos painéis", () => {
    const falhas: string[] = [];
    for (const identity of IDENTITIES) {
      for (const mode of MODES) {
        for (const material of MATERIALS) {
          const ctx: Ctx = { identity, mode, surface: material };
          const plate = plateFor(ctx);
          const secondary = computeColor(rawToken("--muted-foreground", ctx)!, ctx);
          const ratio = contrastRatio(secondary, plate);
          if (ratio < ALVO_AA) falhas.push(`${identity}/${mode}/${material} = ${fmt(ratio)}`);
        }
      }
    }
    assert.equal(falhas.length, 0, `--muted-foreground abaixo de AA: ${falhas.join(", ")}`);
  });
});

/* ═══ 4 — R6-L5 3: o material é efetivo nos cinco temas ═══════════════════ */

describe("R6-L5 3 — Vidro, Reduzido e Sólido são três acabamentos em TODOS os temas", () => {
  const hooks = [".stat-card", ".surface-elevated", ".hero-banner", ".auth-card", ".sidebar-surface"] as const;

  test("Sólido é opaco em todo o lado; Reduzido é translúcido em todo o lado", () => {
    // O defeito que isto apanha: não havia regra nenhuma para `reduced`, por
    // isso em Neon e Matrix — onde o `--card` do tema é opaco — Reduzido era
    // igual a Sólido, que é exatamente a queixa da ronda 3-E.
    const falhas: string[] = [];
    for (const identity of IDENTITIES) {
      for (const mode of MODES) {
        const solido = fillOf({ identity, mode, surface: "solid" });
        if (solido.a !== 1) falhas.push(`${identity}/${mode}: sólido com alfa ${solido.a}`);
        for (const material of ["glass", "reduced"]) {
          const enchimento = fillOf({ identity, mode, surface: material });
          if (enchimento.a >= 1) falhas.push(`${identity}/${mode}/${material}: painel opaco, não há nada para ver através dele`);
        }
      }
    }
    assert.equal(falhas.length, 0, falhas.join("\n  "));
  });

  test("os cinco ganchos de superfície lêem o material, nos três acabamentos", () => {
    const falhas: string[] = [];
    for (const hook of hooks) {
      for (const material of MATERIALS) {
        // Exceção ESCOLHIDA e escrita no fonte: em Reduzido a barra lateral
        // fica no `--sidebar` do tema. O material não tem pano próprio para a
        // barra nesse acabamento, e pintá-la com o pano do `--card` apagava a
        // distinção entre a barra e o conteúdo.
        if (hook === ".sidebar-surface" && material === "reduced") continue;
        for (const identity of IDENTITIES) {
          for (const mode of MODES) {
            const ctx: Ctx = { identity, mode, surface: material };
            if (winningDeclaration(hook, "background-color", ctx) === null) {
              falhas.push(`${hook}/${material}/${identity}/${mode}: fica no cheio do tema`);
            }
          }
        }
      }
    }
    assert.equal(falhas.length, 0, `sem enchimento de material:\n  ${falhas.join("\n  ")}`);
  });

  test("o aro iluminado é do vidro e só do vidro", () => {
    for (const identity of IDENTITIES) {
      for (const mode of MODES) {
        const deVidro = winningDeclaration(".stat-card", "border-color", { identity, mode, surface: "glass" }) ?? "";
        assert.match(deVidro, /color-mix\([^,]+, ?var\(--primary\)/, `${identity}/${mode}: o aro do vidro não vem do --primary`);
        for (const material of ["reduced", "solid"]) {
          const deOutro = winningDeclaration(".stat-card", "border-color", { identity, mode, surface: material });
          assert.ok(
            deOutro === null || !/var\(--primary\)/.test(deOutro),
            `${identity}/${mode}/${material}: o aro de ${material} vestiu-se do vidro`,
          );
        }
      }
    }
  });

  test("só o vidro borra, e o desfoque tem fundo com malha para amostrar", () => {
    for (const material of MATERIALS) {
      const borra = IDENTITIES.some((identity) =>
        MODES.some((mode) => {
          const ctx: Ctx = { identity, mode, surface: material };
          const cru = winningDeclaration(".stat-card", "backdrop-filter", ctx);
          return cru !== null && /blur\(\d+px\)/.test(expandVars(cru, ctx));
        }),
      );
      assert.equal(borra, material === "glass", `${material}: desfoque ${borra ? "presente" : "ausente"} onde não devia`);
    }
    // Fora do Líquido não havia nada para desfocar: o `.liquid-bg` só existe
    // quando a identidade é Líquido (src/App.tsx:789). O eixo passa a dar a
    // malha ao contentor que faz scroll.
    assert.match(decls, /\[data-surface="glass"\]:not\(\[data-theme="cybersafe-liquid"\]\) main \{[^}]*repeating-linear-gradient\(0deg/);
    assert.match(decls, /\[data-surface="glass"\]:not\(\[data-theme="cybersafe-liquid"\]\) main \{[^}]*repeating-linear-gradient\(90deg/);
    assert.match(decls, /^\.liquid-bg \{/m, "o Líquido continua a pintar o seu próprio fundo");
  });

  test("o pano translúcido não foge do AA medido em cima", () => {
    // As razões calculadas na secção 1 usam este painel. Se o enchimento do
    // material passar a outro valor, é aqui que se vê que a medição acima
    // deixou de ser sobre o que a app pinta.
    for (const identity of IDENTITIES) {
      for (const mode of MODES) {
        const translucido = fillOf({ identity, mode, surface: "glass" });
        const esperado = computeColor(rawToken("--surface-translucent", { identity, mode, surface: "glass" })!, { identity, mode, surface: "glass" });
        assert.ok(Math.abs(translucido.a - esperado.a) < 1e-6, `${identity}/${mode}: o vidro fugiu de --surface-translucent`);
      }
    }
  });

  test("controlo: as duas regras ancoradas no contrato da ronda 4-L2 dão o mesmo valor que os tokens", () => {
    // A folha repete em literal o que os tokens dizem porque o teste
    // r4-l2-dashboard-aparencia.test.ts procura essas declarações escritas.
    // Duplicação tolerada só enquanto for o mesmo número — é o que aqui se
    // verifica, para que os dois caminhos não possam divergir em silêncio.
    for (const mode of MODES) {
      for (const identity of IDENTITIES) {
        const ctx: Ctx = { identity, mode, surface: "glass" };
        const token = fillOf(ctx);
        const literal = computeColor(
          mode === "dark"
            ? "color-mix(in oklch, var(--card) 74%, transparent)"
            : "color-mix(in oklch, var(--card) 80%, transparent)",
          ctx,
        );
        assert.ok(Math.abs(token.a - literal.a) < 1e-6 && Math.abs(token.r - literal.r) < 1e-6,
          `${identity}/${mode}: o literal ancorado parou de ser o token`);
        const nav = computeColor(rawToken("--material-glass-nav", ctx)!, ctx);
        const navLiteral = computeColor(
          mode === "dark"
            ? "color-mix(in oklch, var(--sidebar) 70%, transparent)"
            : "color-mix(in oklch, var(--sidebar) 80%, transparent)",
          ctx,
        );
        assert.ok(Math.abs(nav.a - navLiteral.a) < 1e-6 && Math.abs(nav.r - navLiteral.r) < 1e-6,
          `${identity}/${mode}: o pano da barra parou de ser o literal ancorado`);
        // O aro do vidro: o eixo escreve o literal (contrato 4-L2) e a amostra
        // das Configurações lê `--material-glass-edge`. Mesmo risco de deriva.
        const edge = computeColor(rawToken("--material-glass-edge", ctx)!, ctx);
        const edgeLiteral = computeColor("color-mix(in oklch, var(--primary) 42%, transparent)", ctx);
        assert.ok(Math.abs(edge.a - edgeLiteral.a) < 1e-6 && Math.abs(edge.r - edgeLiteral.r) < 1e-6,
          `${identity}/${mode}: o aro da amostra divergiu do aro do eixo`);
      }
    }
  });
});
