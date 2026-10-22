/**
 * Barra de janela premium no Windows (P1 — titlebar, 2026-10-14).
 *
 * Problema concreto: no artefacto instalado a barra superior nativa do Windows
 * (frame + título "CyberSafe Assistant") fica visualmente desintegrada do
 * design — altura, cor e tipografia não pertencem a nenhum tema do produto, e
 * mudam conforme o tema claro/escuro do Windows, não do CyberSafe.
 *
 * Solução escolhida: a nativa suportada pelo Electron —
 * `titleBarStyle: "hidden"` + `titleBarOverlay` (Window Controls Overlay). O
 * frame nativo desaparece, os botões minimizar/maximizar/fechar continuam a ser
 * do sistema (acessibilidade, Snap, duplo-clique, Snap Layouts e atalhos do
 * Windows preservados), e o renderer desenha uma faixa de 42 px por baixo,
 * sincronizando a cor dos botões com o tema ativo.
 *
 * Regras que este módulo garante (puras, testáveis sem Electron):
 *  - Fora do Windows NÃO se toca em nada: `{}` e a janela mantém o frame nativo
 *    (macOS e Linux não são o alvo desta correcção e não devem regredir).
 *  - O payload vindo do renderer é NÃO CONFÁVEL: só aceita cores hexadecimais
 *    (#RRGGBB / #RRGGBBAA) e alturas dentro de limites, porque um valor
 *    inválido faz o Electron lançar dentro do handler de IPC.
 *  - Falha sempre em silêncio controlado (`{ ok: false }`), nunca lança: a
 *    janela não pode deixar de funcionar por causa da cor da barra.
 */

import type { BrowserWindowConstructorOptions } from "electron";

/** Altura da faixa de título do produto (px lógicos), igual nos cinco temas. */
export const TITLEBAR_HEIGHT = 42;
export const TITLEBAR_HEIGHT_MIN = 24;
export const TITLEBAR_HEIGHT_MAX = 64;

/** Valores usados antes de o renderer resolver o tema (fundo escuro do produto). */
export const DEFAULT_TITLEBAR_OVERLAY = {
  color: "#090b12",
  symbolColor: "#dbeef0",
} as const;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export interface TitleBarOverlayOptions {
  color: string;
  symbolColor: string;
  height: number;
}

/**
 * Normaliza o payload do renderer. Devolve `null` quando é inutilizável — o
 * chamador decide (nunca inventamos uma cor a partir de lixo).
 */
export function normalizeTitleBarOverlayPayload(payload: unknown): TitleBarOverlayOptions | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { color?: unknown; symbolColor?: unknown; height?: unknown };
  const color = typeof record.color === "string" ? record.color.trim() : "";
  const symbolColor = typeof record.symbolColor === "string" ? record.symbolColor.trim() : "";
  if (!HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) return null;

  const rawHeight =
    typeof record.height === "number" && Number.isFinite(record.height) ? Math.round(record.height) : TITLEBAR_HEIGHT;
  const height = Math.min(TITLEBAR_HEIGHT_MAX, Math.max(TITLEBAR_HEIGHT_MIN, rawHeight));
  return { color, symbolColor, height };
}

/**
 * Opções de `BrowserWindow` para a barra de janela. No Windows: frame escondido
 * + overlay nativo. Noutras plataformas: objeto vazio (frame intacto).
 */
export function titleBarOverlayWindowOptions(platform: string): BrowserWindowConstructorOptions {
  if (platform !== "win32") return {};
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: DEFAULT_TITLEBAR_OVERLAY.color,
      symbolColor: DEFAULT_TITLEBAR_OVERLAY.symbolColor,
      height: TITLEBAR_HEIGHT,
    },
  };
}

interface OverlayTarget {
  isDestroyed?: () => boolean;
  setTitleBarOverlay?: (options: TitleBarOverlayOptions) => void;
}

/**
 * Aplica o overlay na janela. `mainWindow` pode ser `null` (janela ainda não
 * criada) e a janela pode estar destruída — em ambos os casos não é erro.
 */
export function applyTitleBarOverlay(
  win: OverlayTarget | null | undefined,
  payload: unknown,
  platform: string = process.platform,
): { ok: boolean } {
  if (platform !== "win32") return { ok: false };
  if (!win) return { ok: false };
  if (typeof win.isDestroyed === "function" && win.isDestroyed()) return { ok: false };
  if (typeof win.setTitleBarOverlay !== "function") return { ok: false };

  const options = normalizeTitleBarOverlayPayload(payload);
  if (!options) return { ok: false };

  try {
    win.setTitleBarOverlay(options);
    return { ok: true };
  } catch {
    // Um overlay rejeitado pelo Electron não pode propagar-se para o IPC.
    return { ok: false };
  }
}
