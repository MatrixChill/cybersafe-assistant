/**
 * Cores da barra de janela derivadas do TEMA ATIVO (P1 — titlebar, 2026-10-14).
 *
 * Porque não basta copiar a cor de fundo: os botões nativos da janela
 * (minimizar/maximizar/fechar) são desenhados pelo Windows com uma cor de
 * símbolo que TEM de contrastar com a cor da barra. Num produto com identidades
 * claras e escuras, escolher essa cor de símbolo a olho daria botões ilegíveis
 * em pelo menos um tema — aqui é calculada pelo contraste real.
 *
 * Só funções puras: sem DOM, sem Electron. Quem lê o DOM é o AppTitleBar.
 */

/** Cor de reserva quando os tokens do tema não estão disponíveis (fundo escuro do produto). */
export const TITLEBAR_FALLBACK_COLOR = "#090b12";
/** Candidatos a símbolo: um claro e um escuro, quase neutros. */
const SYMBOL_ON_DARK = "#eef4f6";
const SYMBOL_ON_LIGHT = "#1b232c";

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Aceita o que `getComputedStyle` devolve (`rgb(...)` / `rgba(...)`) e devolve
 * `#rrggbb`. Qualquer outra forma (vazio, `oklch(...)`, `color-mix(...)` não
 * resolvido) devolve `null` — preferimos a reserva a inventar uma cor.
 *
 * Transparência total (`rgba(0, 0, 0, 0)`, o que um `<body>` sem fundo devolve)
 * NÃO é o preto: é ausência de superfície, logo devolve `null`. Sem isto, uma
 * superfície por pintar pintava a barra de preto.
 */
export function rgbStringToHex(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)%?)?/i.exec(value.trim());
  if (!match) return null;
  const alphaToken = match[4];
  const alpha = alphaToken === undefined ? 1 : Number(alphaToken) / (alphaToken.includes("%") ? 100 : 1);
  if (alpha === 0) return null;
  return toHex(clampChannel(Number(match[1])), clampChannel(Number(match[2])), clampChannel(Number(match[3])));
}

/** Converte a cor CSS já calculada pelo browser para o sRGB aceite pelo Electron.
 * Um pixel local por mudança de tema; sem imagens externas ou render loop.
 */
export function paintedCssColorToHex(value: string | null | undefined): string | null {
  const simple = rgbStringToHex(value);
  if (simple) return simple;
  if (!value || typeof document === "undefined" || typeof CSS === "undefined" || !CSS.supports("color", value)) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
    return alpha === 255 ? toHex(r, g, b) : null;
  } catch { return null; }
}

function channelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Luminância relativa WCAG de `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const value = hex.trim();
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  if ([r, g, b].some((channel) => Number.isNaN(channel))) return 0;
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** Razão de contraste WCAG entre duas cores `#rrggbb`. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Cor de símbolo legível sobre `background` (a que tiver maior contraste). */
export function readableSymbolColor(background: string): string {
  return contrastRatio(background, SYMBOL_ON_LIGHT) > contrastRatio(background, SYMBOL_ON_DARK)
    ? SYMBOL_ON_LIGHT
    : SYMBOL_ON_DARK;
}

/** Lê um valor em px vindo de um custom property (`"42px"`), com reserva numérica. */
export function readCssNumber(value: string | null | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value);
  if (!match) return fallback;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface TitleBarColors {
  color: string;
  symbolColor: string;
}

/**
 * Resolve as cores finais da barra: cor de fundo do tema + símbolo contrastante.
 * Aceita valores do DOM possivelmente inválidos e cai sempre na reserva.
 */
export function resolveTitleBarColors(
  backgroundFromToken: string | null | undefined,
  surfaceBackground: string | null | undefined,
  fallbackColor: string = TITLEBAR_FALLBACK_COLOR,
  resolveCssColor: typeof rgbStringToHex = rgbStringToHex,
): TitleBarColors {
  const color = resolveCssColor(backgroundFromToken) ?? resolveCssColor(surfaceBackground) ?? fallbackColor;
  return { color, symbolColor: readableSymbolColor(color) };
}
