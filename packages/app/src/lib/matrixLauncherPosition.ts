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
 *   Fora dela — a área principal inteira — o limite inferior é `EDGE_INSET_PX`,
 *   mesmo com conta/estado visíveis na barra: essa reserva protege o rodapé da
 *   Sidebar, não o fundo da janela. Durante o GESTO de arrasto a banda da
 *   Sidebar é atravessável (`allowDockBand`) e a reserva continua a decidir-se
 *   pelo `x` real, para que a linha não apareça a meio da área principal.
 * - O painel de chat nunca força mínimos que saem do viewport: encolhe até ao
 *   espaço disponível, e só fica abaixo de `CHAT_PANEL_MIN_*` quando a janela
 *   for mais pequena do que isso.
 * - O painel FLUTUANTE respeita a barra de janela (`topInset`, medida) e a caixa
 *   REAL do bloco do launcher (`footprint`: avatar + botão de menu). A âncora é
 *   o avatar — alinhado à direita dentro do bloco — não a borda do bloco.
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

/**
 * Limites REAIS do painel flutuante, medidos no componente:
 * - `topInset`: distância do topo do viewport ao fim da barra de janela. Sem
 *   isto o painel subia por baixo da faixa e dos controlos nativos.
 * - `footprint`: caixa do bloco do launcher (avatar + botão de menu). Abrir
 *   acima só do avatar deixava o menu por baixo do painel.
 * - `anchorOffsetX`: distância da borda esquerda do bloco à borda esquerda do
 *   avatar. No modo flutuante a coluna é `items-end`, logo o avatar está à
 *   direita; sem este desvio o painel alinhava com o menu, não com o avatar.
 */
export interface ChatPanelConstraints {
  topInset?: number;
  footprint?: Size | null;
  anchorOffsetX?: number;
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

function insetOf(value: unknown): number {
  return finite(value) ? Math.max(0, value) : 0;
}

/** Caixa do bloco: só substitui a medida quando é plausível. */
function footprintOf(footprint: Size | null | undefined, fallback: Size): Size {
  if (!footprint || !finite(footprint.w) || !finite(footprint.h) || footprint.w <= 0 || footprint.h <= 0) {
    return fallback;
  }
  return { w: footprint.w, h: footprint.h };
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
 * Clamp do GESTO de arrasto: o `x` pode entrar na banda da Sidebar (é assim
 * que a zona de encaixe fica alcançável), mas a reserva do rodapé continua a
 * decidir-se pelo `x` REAL — fora da Sidebar não há reserva nenhuma.
 *
 * `clampPos` não serve aqui: ele contém o `x` para fora da Sidebar, e com o
 * `sidebarWidth` a 0 a reserva era aplicada à janela inteira (a «linha
 * invisível» a ~180 px do fundo).
 */
function clampPosAllowingDockBand(
  pos: Pos,
  vp: Viewport,
  size: Size,
  reservedBottom: number,
  sidebarWidth: number,
): Pos {
  const v = safeVp(vp);
  const s = safeSize(size);
  const minX = EDGE_INSET_PX;
  const maxX = Math.max(minX, v.w - s.w - EDGE_INSET_PX);
  const x = finite(pos?.x) ? Math.min(Math.max(pos.x, minX), maxX) : minX;
  const [minBottom, maxBottom] = bottomRange(v, s, reservedBottom, x, sidebarWidth);
  const bottom = finite(pos?.bottom)
    ? Math.min(Math.max(pos.bottom, minBottom), maxBottom)
    : minBottom;
  return { x, bottom };
}

/**
 * Projeta a posição durante um arrasto de ponteiro a partir da posição inicial
 * do launcher (`from`) e do deslocamento do cursor (`currentClient - startClient`).
 * - `x = from.x + (clientX - startClient.x)`
 * - `bottom = from.bottom - (clientY - startClient.y)` (subir o rato aumenta bottom).
 *
 * `allowDockBand` é o modo do GESTO (não do repouso): permite atravessar a
 * banda da Sidebar para lá largar o avatar, sem transformar a reserva do
 * rodapé numa parede no fundo da área principal.
 */
export function projectPointerDrag(
  from: Pos,
  startClient: Point,
  currentClient: Point,
  vp: Viewport,
  size: Size,
  reservedBottom: number,
  sidebarWidth: number = 0,
  options: { allowDockBand?: boolean } = {},
): Pos {
  const clampar = options.allowDockBand ? clampPosAllowingDockBand : clampPos;
  if (!finite(startClient?.x) || !finite(startClient?.y) || !finite(currentClient?.x) || !finite(currentClient?.y)) {
    return clampar(from, vp, size, reservedBottom, sidebarWidth);
  }
  const dx = currentClient.x - startClient.x;
  const dy = currentClient.y - startClient.y;
  return clampar(
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
 * Colocação do painel de chat FLUTUANTE ancorada ao avatar do launcher:
 * - horizontal: abre para o lado que TEM espaço para a largura; se nenhum lado
 *   chega, abre para o maior. Nunca entra na Sidebar (quando cabe fora dela) e
 *   nunca sai do viewport. A âncora é o avatar (`anchorOffsetX`), não a borda do
 *   bloco — o botão de menu alarga o bloco e desalinhava o painel.
 * - vertical: abre acima do bloco INTEIRO (avatar + menu) quando há espaço para
 *   o mínimo; senão abre abaixo. A altura encolhe ao espaço real, já descontada
 *   a barra de janela (`topInset`).
 * Sem forçar mínimos que saem da área útil.
 */
export function computeChatPanelPlacement(
  launcherPos: Pos,
  vp: Viewport,
  launcherSize: Size,
  sidebarWidth: number = 0,
  reservedBottom: number = 0,
  constraints: ChatPanelConstraints = {},
): ChatPanelPlacement {
  const v = safeVp(vp);
  const l = safeSize(launcherSize);
  const sw = sidebarOf(sidebarWidth);
  const footprint = footprintOf(constraints.footprint, l);
  const topInset = Math.min(insetOf(constraints.topInset), v.h);
  const anchorOffsetX = finite(constraints.anchorOffsetX)
    ? Math.min(Math.max(constraints.anchorOffsetX, 0), Math.max(0, footprint.w - l.w))
    : Math.max(0, footprint.w - l.w);

  const regionLeft = sw > 0 && v.w - (sw + EDGE_INSET_PX) >= CHAT_PANEL_MIN_W + EDGE_INSET_PX
    ? sw + EDGE_INSET_PX
    : EDGE_INSET_PX;
  const regionRight = v.w - EDGE_INSET_PX;
  const regionW = Math.max(0, regionRight - regionLeft);
  const width = Math.min(CHAT_PANEL_DEFAULT_W, regionW);

  // Bordas do AVATAR dentro do viewport.
  const lx = finite(launcherPos?.x) ? launcherPos.x : regionLeft;
  const anchorLeft = lx + anchorOffsetX;
  const anchorRight = anchorLeft + l.w;
  const roomRight = regionRight - anchorLeft;
  const roomLeft = anchorRight - regionLeft;

  let alignHorizontal: "left" | "right";
  if (roomRight >= width) alignHorizontal = "left";
  else if (roomLeft >= width) alignHorizontal = "right";
  else alignHorizontal = roomLeft > roomRight ? "right" : "left";

  const rawLeft = alignHorizontal === "right" ? anchorRight - width : anchorLeft;
  const maxLeft = Math.max(regionLeft, regionRight - width);
  const left = Math.min(Math.max(rawLeft, regionLeft), maxLeft);

  // Topo ÚTIL em coordenadas `bottom`: descontada a barra de janela e a margem.
  const usableTopBottom = Math.max(0, v.h - topInset - EDGE_INSET_PX);
  const naturalMinBottom = overlapsSidebar(left, sw) && finite(reservedBottom) && reservedBottom > 0
    ? reservedBottom + EDGE_INSET_PX
    : EDGE_INSET_PX;
  // A reserva do rodapé protege conta/estado, mas não pode comer a janela toda:
  // numa janela baixa, o painel (e não a reserva) é que manda.
  const minChatBottom = Math.min(
    naturalMinBottom,
    Math.max(EDGE_INSET_PX, usableTopBottom - CHAT_PANEL_MIN_H),
  );
  // Um `bottom` guardado fora do ecrã (lixo/estado antigo) não arrasta o painel
  // com ele: só o intervalo [0, altura do viewport] é aceite.
  const lb = Math.min(Math.max(finite(launcherPos?.bottom) ? launcherPos.bottom : minChatBottom, 0), v.h);
  const blockTop = lb + footprint.h;

  const gap = 10;
  const spaceAbove = Math.max(0, usableTopBottom - (blockTop + gap));
  const spaceBelow = Math.max(0, lb - gap - minChatBottom);

  const openDirection: "up" | "down" = spaceAbove >= CHAT_PANEL_MIN_H || spaceAbove >= spaceBelow ? "up" : "down";
  let height = Math.min(CHAT_PANEL_DEFAULT_H, openDirection === "up" ? spaceAbove : spaceBelow);
  let bottom = openDirection === "up"
    ? Math.max(minChatBottom, blockTop + gap)
    : Math.max(minChatBottom, lb - gap - height);

  // Fecho de segurança: aconteça o que acontecer à entrada, o painel fica
  // dentro da área útil (nunca por cima da barra de janela nem abaixo do fundo).
  const maxBottom = Math.max(minChatBottom, usableTopBottom - height);
  bottom = Math.min(Math.max(bottom, minChatBottom), maxBottom);
  height = Math.max(0, Math.min(height, usableTopBottom - bottom));

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

/* ═══ MODOS DO LAUNCHER (TP-MATRIX-DOCK) ═══════════════════════════════════
   Três modos, um só eixo de estado:
     floating  → arrastável pela área útil da janela (o que já existia);
     docked    → encaixado na barra lateral, numa zona dedicada acima do bloco
                 de conta/estado, sem tapar navegação, conta ou estado;
     minimized → botão pequeno, discreto e focável, no canto da área útil.
   A preferência ANTIGA (`cybersafe.matrixLauncher.v1`) guardava só a posição;
   continua a ser lida tal e qual, e a ausência de modo resolve para floating.
   ═══════════════════════════════════════════════════════════════════════════ */

export const MATRIX_MODE_KEY = "cybersafe.matrixLauncher.v2.mode";

/** Altura reservada na barra lateral para o encaixe (avatar 56 px + folga). */
export const DOCK_SLOT_PX = 64;

export type MatrixMode = "floating" | "docked" | "minimized" | "panel";

export function parseStoredMode(raw: string | null | undefined): MatrixMode {
  if (raw === "docked" || raw === "minimized" || raw === "floating" || raw === "panel") return raw;
  return "floating";
}

/**
 * O gesto de encaixe é decidido pelo CENTRO do launcher, não pela sua borda:
 * encostar o avatar à barra sem o centro lá dentro não é intenção de fixar.
 * Sem largura de barra medida não há zona de encaixe nenhuma.
 */
export function isDockGesture(pos: Pos, size: Size, sidebarWidth: number): boolean {
  const sw = sidebarOf(sidebarWidth);
  if (sw <= 0) return false;
  const s = safeSize(size);
  const center = (finite(pos?.x) ? pos.x : 0) + s.w / 2;
  return center > 0 && center <= sw;
}

/** Canto inferior esquerdo da ÁREA ÚTIL: imediatamente à direita da barra. */
export function computeMinimizedPos(vp: Viewport, size: Size, sidebarWidth: number = 0): Pos {
  const v = safeVp(vp);
  const s = safeSize(size);
  const sw = sidebarOf(sidebarWidth);
  const minX = sw > 0 ? sw + EDGE_INSET_PX : EDGE_INSET_PX;
  const x = Math.min(Math.max(minX, EDGE_INSET_PX), Math.max(EDGE_INSET_PX, v.w - s.w - EDGE_INSET_PX));
  return { x: Math.round(x), bottom: EDGE_INSET_PX };
}

/**
 * Painel de chat quando a Matrix está FIXADA: abre na área principal, colado à
 * barra lateral (nunca por cima dela) e dentro do viewport. Devolve `null`
 * quando não há barra medida ou não cabe a largura mínima — nesse caso o
 * chamador cai no painel ancorado ao launcher, que já sabe encolher.
 */
export function computeDockedChatPlacement(
  vp: Viewport,
  sidebarWidth: number,
  _reservedBottom: number = 0,
): ChatPanelPlacement | null {
  const v = safeVp(vp);
  const sw = sidebarOf(sidebarWidth);
  if (sw <= 0) return null;

  const left = sw + EDGE_INSET_PX;
  const availableW = v.w - left - EDGE_INSET_PX;
  if (availableW < CHAT_PANEL_MIN_W) return null;

  const width = Math.min(CHAT_PANEL_DEFAULT_W + 60, availableW);
  const bottom = EDGE_INSET_PX + 8;
  const availableH = Math.max(0, v.h - bottom - EDGE_INSET_PX);
  const height = Math.min(CHAT_PANEL_DEFAULT_H + 60, availableH);

  return {
    left: Math.round(left),
    bottom: Math.round(bottom),
    width: Math.round(width),
    height: Math.round(height),
    alignHorizontal: "left",
    openDirection: "up",
  };
}

/**
 * PAINEL LATERAL (P1) — a conversa encaixa à direita da ÁREA PRINCIPAL, nunca
 * por cima da barra lateral, e o conteúdo cede a largura real (o componente
 * publica `--matrix-panel-w` a partir de `width + 2 × EDGE_INSET_PX`).
 *
 * `reservedBottom` não entra: a reserva protege o rodapé da barra lateral, e o
 * painel vive fora dela. Devolve sempre geometria dentro do viewport.
 */
export const CHAT_SIDE_PANEL_MIN_W = 320;
export const CHAT_SIDE_PANEL_MAX_W = 420;

export function computeSidePanelPlacement(
  vp: Viewport,
  sidebarWidth: number = 0,
  topInset: number = 0,
): ChatPanelPlacement {
  const v = safeVp(vp);
  const sw = sidebarOf(sidebarWidth);
  const top = Math.min(insetOf(topInset), v.h);
  const regionLeft = Math.min(sw > 0 ? sw + EDGE_INSET_PX : EDGE_INSET_PX, Math.max(0, v.w - EDGE_INSET_PX));
  const availableW = Math.max(0, v.w - regionLeft - EDGE_INSET_PX);
  const preferred = Math.round(
    Math.min(CHAT_SIDE_PANEL_MAX_W, Math.max(CHAT_SIDE_PANEL_MIN_W, v.w * 0.32)),
  );
  const width = Math.max(0, Math.min(preferred, availableW));
  const left = Math.max(regionLeft, v.w - EDGE_INSET_PX - width);
  const bottom = EDGE_INSET_PX;
  const height = Math.max(0, v.h - top - EDGE_INSET_PX - bottom);

  return {
    left: Math.round(left),
    bottom: Math.round(bottom),
    width: Math.round(width),
    height: Math.round(height),
    alignHorizontal: "right",
    openDirection: "up",
  };
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

/** Extra scroll space lets the final content move above a floating launcher. */
export function floatingLauncherClearance(mode: MatrixMode, footprint: Size): number {
  return mode === "floating" ? Math.ceil(safeSize(footprint).h) + 2 * EDGE_INSET_PX : 0;
}
