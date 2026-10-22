/**
 * Geometria do launcher e painel da Matrix (TP-MATRIX-DRAG).
 *
 * Ficheiro PURO: sem DOM, sem React, sem `window` — é o único sítio onde a
 * contenção se decide, para ser testável em `node:test` e para o componente se
 * limitar a medir e aplicar.
 *
 * Sistema de coordenadas: `{x, bottom}` — `x` é a distância da ESQUERDA do
 * viewport, `bottom` é a distância da BASE do viewport.
 *
 * Política responsiva (explícita):
 * - Com Sidebar medida (`sidebarWidth > 0`) e espaço para o launcher FORA dela
 *   (`vw >= sidebarWidth + EDGE + w + EDGE`), o launcher nunca fica dentro da
 *   Sidebar: `x >= sidebarWidth + EDGE_INSET_PX`.
 * - Se não cabe fora da Sidebar (janela muito estreita), o launcher volta a
 *   `x >= EDGE_INSET_PX` e a sobreposição é aceite, porque manter o FAB visível
 *   tem prioridade sobre a Sidebar.
 * - A reserva do rodapé só se aplica quando o launcher está sobre a Sidebar.
 * - O painel de chat nunca força mínimos que saem do viewport: encolhe até ao
 *   espaço disponível, e só fica abaixo de `CHAT_PANEL_MIN_*` quando a janela
 *   for mais pequena do que isso.
 */

export const MATRIX_POS_KEY = "cybersafe.matrixLauncher.v1";

/** Abaixo deste deslocamento é clique; acima é arrasto. Evita que um toque
 *  ligeiro alterne o painel enquanto se tenta mover o launcher. */
export const DRAG_THRESHOLD_PX = 6;

/** Passo das setas do teclado. 16 px é visível sem saltar meio ecrã. */
export const KEYBOARD_STEP_PX = 16;

/** Margem de segurança a todos os lados: nada encosta ao pixel do viewport. */
export const EDGE_INSET_PX = 12;

/** Dimensões ideais e limites do painel de chat (compacto e contido). */
export const CHAT_PANEL_DEFAULT_W = 380;
export const CHAT_PANEL_DEFAULT_H = 440;
export const CHAT_PANEL_MIN_W = 280;
export const CHAT_PANEL_MIN_H = 260;

export type Viewport = { w: number; h: number };
export type Size = { w: number; h: number };
export type Pos = { x: number; bottom: number };
export type Point = { x: number; y: number };

export interface ChatPanelPlacement {
  left: number;
  bottom: number;
  width: number;
  height: number;
  alignHorizontal: "left" | "right";
  openDirection: "up" | "down";
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function safeVp(vp: Viewport): Viewport {
  return { w: finite(vp?.w) ? vp.w : 1024, h: finite(vp?.h) ? vp.h : 768 };
}

function safeSize(size: Size): Size {
  return { w: finite(size?.w) ? size.w : 56, h: finite(size?.h) ? size.h : 56 };
}

function sidebarOf(sidebarWidth: number): number {
  return finite(sidebarWidth) ? Math.max(0, sidebarWidth) : 0;
}

/** Menor `x` permitido: fora da Sidebar quando cabe; senão a margem normal. */
export function minLauncherX(vp: Viewport, size: Size, sidebarWidth: number = 0): number {
  const v = safeVp(vp);
  const s = safeSize(size);
  const sw = sidebarOf(sidebarWidth);
  if (sw <= 0) return EDGE_INSET_PX;
  const outside = sw + EDGE_INSET_PX;
  return v.w - s.w - EDGE_INSET_PX >= outside ? outside : EDGE_INSET_PX;
}

/** Verifica se a coordenada `x` do launcher sobrepõe a Sidebar (reserva do rodapé). */
function overlapsSidebar(x: number, sidebarWidth: number): boolean {
  const sw = sidebarOf(sidebarWidth);
  if (sw <= 0) return true; // Sem largura de sidebar explícita, reserva conservadora
  return x < sw + EDGE_INSET_PX;
}

/** Intervalo [min,max] de `bottom`, garantindo min <= max mesmo com reserva
 *  maior que o espaço disponível (janela muito baixa): nesse caso a janela manda. */
function bottomRange(
  vp: Viewport,
  size: Size,
  reservedBottom: number,
  x: number = EDGE_INSET_PX,
  sidebarWidth: number = 0,
): [number, number] {
  const res = finite(reservedBottom) ? Math.max(0, reservedBottom) : 0;
  const effectiveReserve = overlapsSidebar(x, sidebarWidth) ? res : 0;
  const hi = Math.max(EDGE_INSET_PX, vp.h - size.h - EDGE_INSET_PX);
  const lo = Math.min(effectiveReserve + EDGE_INSET_PX, hi);
  return [lo, hi];
}

/** Inferior-esquerdo por omissão: fora da Sidebar quando cabe, acima do rodapé
 *  da barra (conta + status + toggle) quando sobrepõe a Sidebar. */
export function defaultPos(vp: Viewport, size: Size, reservedBottom: number, sidebarWidth: number = 0): Pos {
  const v = safeVp(vp);
  const s = safeSize(size);
  const x = minLauncherX(v, s, sidebarWidth);
  const [lo] = bottomRange(v, s, reservedBottom, x, sidebarWidth);
  return { x, bottom: lo };
}

/** Nunca devolve NaN, nunca devolve fora do viewport, nunca rebenta com lixo. */
export function clampPos(
  pos: Pos,
  vp: Viewport,
  size: Size,
  reservedBottom: number,
  sidebarWidth: number = 0,
): Pos {
  const v = safeVp(vp);
  const s = safeSize(size);
  const minX = minLauncherX(v, s, sidebarWidth);
  const maxX = Math.max(minX, v.w - s.w - EDGE_INSET_PX);
  const def = defaultPos(v, s, reservedBottom, sidebarWidth);
  const x = finite(pos?.x) ? Math.min(Math.max(pos.x, minX), maxX) : def.x;
  const [minBottom, maxBottom] = bottomRange(v, s, reservedBottom, x, sidebarWidth);
  const bottom = finite(pos?.bottom)
    ? Math.min(Math.max(pos.bottom, minBottom), maxBottom)
    : def.bottom;
  return { x, bottom };
}

/**
 * Projeta a posição durante um arrasto de ponteiro a partir da posição inicial
 * do launcher (`from`) e do deslocamento do cursor (`currentClient - startClient`).
 * - `x = from.x + (clientX - startClient.x)`
 * - `bottom = from.bottom - (clientY - startClient.y)` (subir o rato aumenta bottom).
 */
export function projectPointerDrag(
  from: Pos,
  startClient: Point,
  currentClient: Point,
  vp: Viewport,
  size: Size,
  reservedBottom: number,
  sidebarWidth: number = 0,
): Pos {
  if (!finite(startClient?.x) || !finite(startClient?.y) || !finite(currentClient?.x) || !finite(currentClient?.y)) {
    return clampPos(from, vp, size, reservedBottom, sidebarWidth);
  }
  const dx = currentClient.x - startClient.x;
  const dy = currentClient.y - startClient.y;
  return clampPos(
    {
      x: Math.round(from.x + dx),
      bottom: Math.round(from.bottom - dy),
    },
    vp,
    size,
    reservedBottom,
    sidebarWidth,
  );
}

/**
 * Colocação do painel de chat ANCORADA ao launcher `launcherPos`:
 * - horizontal: alinha à esquerda ou à direita do launcher conforme a metade do
 *   ecrã em que está, nunca entra na Sidebar (quando cabe) nem sai do viewport;
 * - vertical: abre para cima se houver espaço (ou se for o maior lado), senão
 *   para baixo; a altura encolhe ao espaço disponível.
 * Sem forçar mínimos que saem do viewport.
 */
export function computeChatPanelPlacement(
  launcherPos: Pos,
  vp: Viewport,
  launcherSize: Size,
  sidebarWidth: number = 0,
  reservedBottom: number = 0,
): ChatPanelPlacement {
  const v = safeVp(vp);
  const l = safeSize(launcherSize);
  const sw = sidebarOf(sidebarWidth);
  const regionLeft = sw > 0 && v.w - (sw + EDGE_INSET_PX) >= CHAT_PANEL_MIN_W + EDGE_INSET_PX
    ? sw + EDGE_INSET_PX
    : EDGE_INSET_PX;
  const regionRight = v.w - EDGE_INSET_PX;
  const regionW = Math.max(0, regionRight - regionLeft);
  const width = Math.min(CHAT_PANEL_DEFAULT_W, regionW);

  const launcherCenterX = (finite(launcherPos?.x) ? launcherPos.x : 0) + l.w / 2;
  const alignHorizontal: "left" | "right" = launcherCenterX > v.w * 0.55 ? "right" : "left";
  const lx = finite(launcherPos?.x) ? launcherPos.x : regionLeft;
  const rawLeft = alignHorizontal === "right" ? lx + l.w - width : lx;
  const left = Math.min(Math.max(rawLeft, regionLeft), Math.max(regionLeft, regionRight - width));

  const minChatBottom = overlapsSidebar(left, sw) && finite(reservedBottom) && reservedBottom > 0
    ? reservedBottom + EDGE_INSET_PX
    : EDGE_INSET_PX;
  const lb = finite(launcherPos?.bottom) ? launcherPos.bottom : minChatBottom;

  const gap = 10;
  const spaceAbove = Math.max(0, v.h - (lb + l.h + gap) - EDGE_INSET_PX);
  const spaceBelow = Math.max(0, lb - gap - minChatBottom);

  let openDirection: "up" | "down";
  let height: number;
  let bottom: number;
  if (spaceAbove >= CHAT_PANEL_MIN_H || spaceAbove >= spaceBelow) {
    openDirection = "up";
    height = Math.min(CHAT_PANEL_DEFAULT_H, spaceAbove);
    bottom = lb + l.h + gap;
  } else {
    openDirection = "down";
    height = Math.min(CHAT_PANEL_DEFAULT_H, spaceBelow);
    bottom = Math.max(minChatBottom, lb - gap - height);
  }

  return {
    left: Math.round(left),
    bottom: Math.round(bottom),
    width: Math.round(width),
    height: Math.round(Math.max(0, height)),
    alignHorizontal,
    openDirection,
  };
}

export function serialize(pos: Pos): string {
  return JSON.stringify({ x: Math.round(pos.x), bottom: Math.round(pos.bottom) });
}

/**
 * Aceita APENAS o que é válido para o viewport actual: forma correcta, números
 * finitos e dentro de limites (incluindo fora da Sidebar quando ela cabe). Um
 * valor fora de limites é rejeitado (`null`) e não silentemente corrigido.
 */
export function parseStored(
  raw: string | null | undefined,
  vp: Viewport,
  size: Size,
  reservedBottom: number,
  sidebarWidth: number = 0,
): Pos | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (!finite(candidate.x) || !finite(candidate.bottom)) return null;
  if (Object.keys(candidate).length !== 2) return null;
  const v = safeVp(vp);
  const s = safeSize(size);
  const minX = minLauncherX(v, s, sidebarWidth);
  const maxX = Math.max(minX, v.w - s.w - EDGE_INSET_PX);
  if (candidate.x < minX || candidate.x > maxX) return null;
  const [minBottom, maxBottom] = bottomRange(v, s, reservedBottom, candidate.x, sidebarWidth);
  if (candidate.bottom < minBottom || candidate.bottom > maxBottom) return null;
  return { x: candidate.x, bottom: candidate.bottom };
}

/** Distância euclidiana: mover 5 px só em X não é arrasto; 6,1 px já é. */
export function movedEnoughToDrag(from: Pos, to: Pos, threshold: number = DRAG_THRESHOLD_PX): boolean {
  if (!finite(from?.x) || !finite(from?.bottom) || !finite(to?.x) || !finite(to?.bottom)) return false;
  const dx = to.x - from.x;
  const db = to.bottom - from.bottom;
  return Math.hypot(dx, db) > threshold;
}

/**
 * Reserva REAL do rodapé da barra: a distância entre o topo do bloco de
 * conta/status e a base da janela. Sem elemento medido devolve 0.
 */
export function reservedBottomFromFooter(
  footer: { top: number; height: number } | null | undefined,
  vp: Viewport,
): number {
  if (!footer || !finite(footer.top) || !finite(footer.height)) return 0;
  if (footer.top <= 0 || footer.top >= vp.h) return 0;
  return Math.min(Math.max(vp.h - footer.top, 0), vp.h);
}
