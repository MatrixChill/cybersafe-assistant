import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_PANEL_DEFAULT_H,
  CHAT_PANEL_DEFAULT_W,
  EDGE_INSET_PX,
  computeChatPanelPlacement,
  type ChatPanelPlacement,
  type Pos,
} from "../src/lib/matrixLauncherPosition";

/**
 * P0 — CHAT FLUTUANTE CONTIDO (22/10).
 *
 * O arrasto, o encaixe e o modo fixado estão aprovados: aqui não se toca neles.
 * O que se prova é o cálculo do painel FLUTUANTE com os limites REAIS:
 *   - viewport (largura/altura),
 *   - barra de janela (`topInset` = 42 px), que o painel não pode invadir,
 *   - Sidebar expandida/recolhida,
 *   - pegada do bloco do launcher (avatar 56 + botão de menu = 78×86),
 *   - âncora no avatar (deslocado 22 px dentro do bloco, `items-end`).
 *
 * Casos: 4 cantos + centro, três resoluções (1440×1000, 1200×800, 820×600),
 * Sidebar expandida e recolhida, e entradas absurdas (NaN/∞/negativas).
 */

const AVATAR = { w: 56, h: 56 };
const FOOTPRINT = { w: 78, h: 86 }; // avatar + botão "Opções"
const ANCHOR_OFFSET = FOOTPRINT.w - AVATAR.w; // 22 px
const TITLEBAR = 42; // --shell-titlebar-h
const SIDEBAR_EXPANDED = 256;
const SIDEBAR_COLLAPSED = 64;
const RESERVED = 126;

const CONSTRAINTS = {
  topInset: TITLEBAR,
  footprint: FOOTPRINT,
  anchorOffsetX: ANCHOR_OFFSET,
};

function place(
  pos: Pos,
  vp: { w: number; h: number },
  sidebar = SIDEBAR_EXPANDED,
  reserved = RESERVED,
): ChatPanelPlacement {
  return computeChatPanelPlacement(pos, vp, AVATAR, sidebar, reserved, CONSTRAINTS);
}

/** Topo da área útil em coordenadas de ecrã (y a partir do topo). */
const usableTopY = TITLEBAR + EDGE_INSET_PX;

function assertWithinUsableArea(
  p: ChatPanelPlacement,
  vp: { w: number; h: number },
  sidebar: number,
  label: string,
) {
  assert.ok(Number.isFinite(p.left) && Number.isFinite(p.bottom), `${label}: geometria não finita`);
  assert.ok(p.width >= 0 && p.height >= 0, `${label}: dimensão negativa`);
  assert.ok(p.width <= CHAT_PANEL_DEFAULT_W, `${label}: largura acima do default (${p.width})`);
  assert.ok(p.height <= CHAT_PANEL_DEFAULT_H, `${label}: altura acima do default (${p.height})`);
  assert.ok(p.left >= sidebar + EDGE_INSET_PX, `${label}: painel entra na Sidebar (left=${p.left})`);
  assert.ok(p.left + p.width <= vp.w - EDGE_INSET_PX, `${label}: painel sai pela direita (${p.left + p.width})`);
  assert.ok(p.bottom >= EDGE_INSET_PX, `${label}: painel abaixo do fundo (bottom=${p.bottom})`);
  assert.ok(
    p.bottom + p.height <= vp.h - usableTopY,
    `${label}: painel entra debaixo da barra de janela (topo=${vp.h - (p.bottom + p.height)}, limite=${usableTopY})`,
  );
}

/** Retângulo do bloco do launcher em coordenadas de ecrã. */
function blockRect(pos: Pos, vp: { w: number; h: number }) {
  return {
    left: pos.x,
    right: pos.x + FOOTPRINT.w,
    bottom: vp.h - pos.bottom,
    top: vp.h - pos.bottom - FOOTPRINT.h,
  };
}

/** Retângulo do painel em coordenadas de ecrã. */
function panelRect(p: ChatPanelPlacement, vp: { w: number; h: number }) {
  return {
    left: p.left,
    right: p.left + p.width,
    bottom: vp.h - p.bottom,
    top: vp.h - p.bottom - p.height,
  };
}

function overlaps(a: ReturnType<typeof blockRect>, b: ReturnType<typeof panelRect>) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const VIEWPORTS = [
  { w: 1440, h: 1000 },
  { w: 1200, h: 800 },
  { w: 820, h: 600 }, // mínimo real do Electron
];

for (const vp of VIEWPORTS) {
  for (const sidebar of [SIDEBAR_EXPANDED, SIDEBAR_COLLAPSED]) {
    const left = sidebar + EDGE_INSET_PX;
    const right = vp.w - EDGE_INSET_PX - FOOTPRINT.w;
    const bottom = EDGE_INSET_PX;
    const top = vp.h - usableTopY - FOOTPRINT.h; // bloco inteiro abaixo da barra

    const cases: Array<[string, Pos]> = [
      ["inferior-esquerdo", { x: left, bottom }],
      ["inferior-direito", { x: right, bottom }],
      ["superior-esquerdo", { x: left, bottom: top }],
      ["superior-direito", { x: right, bottom: top }],
      ["centro", { x: Math.round((vp.w - FOOTPRINT.w) / 2), bottom: Math.round((vp.h - FOOTPRINT.h) / 2) }],
    ];

    for (const [nome, pos] of cases) {
      test(`${nome} @${vp.w}×${vp.h} (Sidebar ${sidebar}): painel contido, fora da barra e do bloco`, () => {
        const p = place(pos, vp, sidebar);
        assertWithinUsableArea(p, vp, sidebar, nome);
        assert.equal(
          overlaps(blockRect(pos, vp), panelRect(p, vp)),
          false,
          `${nome}: painel sobrepõe o avatar/menu`,
        );
        if (nome.startsWith("superior")) {
          assert.equal(p.openDirection, "down", `${nome}: devia abrir para baixo (não há espaço acima)`);
        }
        if (nome.startsWith("inferior")) {
          assert.equal(p.openDirection, "up", `${nome}: devia abrir para cima`);
        }
      });
    }
  }
}

test("o painel alinha ao AVATAR, não à borda do bloco (footprint com menu)", () => {
  const vp = { w: 1440, h: 1000 };
  const pos = { x: SIDEBAR_EXPANDED + EDGE_INSET_PX, bottom: 200 };
  const p = place(pos, vp);
  assert.equal(p.alignHorizontal, "left");
  assert.equal(p.left, pos.x + ANCHOR_OFFSET, "o painel não alinhou com a borda esquerda do avatar");
  assert.ok(p.left >= SIDEBAR_EXPANDED, "o painel não pode entrar na Sidebar");
});

test("abre por cima do bloco INTEIRO: o botão de menu não fica por baixo do painel", () => {
  const vp = { w: 1440, h: 1000 };
  const pos = { x: 500, bottom: 200 };
  const p = place(pos, vp);
  assert.equal(p.openDirection, "up");
  assert.equal(p.bottom, pos.bottom + FOOTPRINT.h + 10, "a âncora vertical ignorou a pegada do menu");
  assert.ok(
    panelRect(p, vp).top <= blockRect(pos, vp).top - 10,
    "o painel nasce dentro do bloco do launcher",
  );
});

test("sem espaço acima (launcher no topo) abre para baixo em todas as resoluções", () => {
  for (const vp of VIEWPORTS) {
    for (const sidebar of [SIDEBAR_EXPANDED, SIDEBAR_COLLAPSED]) {
      const pos = { x: sidebar + EDGE_INSET_PX, bottom: vp.h - usableTopY - FOOTPRINT.h };
      const p = place(pos, vp, sidebar);
      assert.equal(p.openDirection, "down", `não abriu para baixo @${vp.w}×${vp.h} sidebar ${sidebar}`);
      assert.ok(
        vp.h - (p.bottom + p.height) >= usableTopY,
        `painel invadiu a barra de janela @${vp.w}×${vp.h}`,
      );
    }
  }
});

test("barra de janela: a altura encolhe ao espaço REAL (não ao viewport inteiro)", () => {
  const vp = { w: 1000, h: 600 };
  const pos = { x: 400, bottom: 120 };
  const semBarra = computeChatPanelPlacement(pos, vp, AVATAR, SIDEBAR_EXPANDED, RESERVED);
  const comBarra = place(pos, vp);
  assert.ok(
    comBarra.height <= semBarra.height - TITLEBAR,
    `a barra de ${TITLEBAR} px não reduziu a altura (${comBarra.height} vs ${semBarra.height})`,
  );
  assert.equal(comBarra.bottom + comBarra.height <= vp.h - usableTopY, true);
});

test("âncora horizontal: à direita abre para a esquerda, à esquerda abre para a direita", () => {
  const vp = { w: 1440, h: 1000 };
  const esquerda = place({ x: SIDEBAR_EXPANDED + EDGE_INSET_PX, bottom: 300 }, vp);
  const direita = place({ x: vp.w - EDGE_INSET_PX - FOOTPRINT.w, bottom: 300 }, vp);
  assert.equal(esquerda.alignHorizontal, "left");
  assert.equal(direita.alignHorizontal, "right");
  assert.equal(direita.left + direita.width, vp.w - EDGE_INSET_PX, "a borda direita não encostou à margem");
  assert.equal(esquerda.left, SIDEBAR_EXPANDED + EDGE_INSET_PX + ANCHOR_OFFSET);
});

test("Sidebar expandida vs recolhida: a área muda e o painel continua fora dela", () => {
  const vp = { w: 820, h: 600 };
  const expandida = place({ x: SIDEBAR_EXPANDED + EDGE_INSET_PX, bottom: 12 }, vp, SIDEBAR_EXPANDED);
  const recolhida = place({ x: SIDEBAR_COLLAPSED + EDGE_INSET_PX, bottom: 12 }, vp, SIDEBAR_COLLAPSED);
  assert.ok(expandida.left >= SIDEBAR_EXPANDED + EDGE_INSET_PX);
  assert.ok(recolhida.left >= SIDEBAR_COLLAPSED + EDGE_INSET_PX);
  assert.ok(recolhida.left < expandida.left, "com a barra recolhida o painel devia poder aproximar-se da esquerda");
  assert.ok(recolhida.left + recolhida.width <= vp.w - EDGE_INSET_PX);
  assert.ok(recolhida.bottom + recolhida.height <= vp.h - usableTopY);
});

test("janela mínima real (820×600): largura e altura cabem sem tocar na barra nem no fundo", () => {
  const vp = { w: 820, h: 600 };
  const p = place({ x: SIDEBAR_EXPANDED + EDGE_INSET_PX, bottom: 12 }, vp);
  assert.ok(p.width >= 320, `painel demasiado estreito numa janela mínima (${p.width})`);
  assert.ok(p.height >= 260, `painel demasiado baixo numa janela mínima (${p.height})`);
  assertWithinUsableArea(p, vp, SIDEBAR_EXPANDED, "820×600");
});

test("sem espaço fora da Sidebar o painel usa a margem normal, mas continua dentro do ecrã", () => {
  const vp = { w: 520, h: 700 };
  const p = place({ x: EDGE_INSET_PX, bottom: 200 }, vp, SIDEBAR_EXPANDED);
  assert.equal(p.left, EDGE_INSET_PX + ANCHOR_OFFSET, "não caiu para a margem quando a barra não cabe");
  assert.ok(p.left + p.width <= vp.w - EDGE_INSET_PX);
  assert.ok(p.bottom + p.height <= vp.h - usableTopY);
});

test("entradas absurdas nunca produzem geometria inválida (negativos/NaN/∞)", () => {
  const vp = { w: 1200, h: 800 };
  const absurdos: Array<[string, Pos, { topInset: number; footprint: { w: number; h: number } | null; anchorOffsetX: number }, number, number]> = [
    ["x negativo e bottom negativo", { x: -9000, bottom: -9000 }, CONSTRAINTS, SIDEBAR_EXPANDED, RESERVED],
    ["x e bottom infinitos", { x: Number.POSITIVE_INFINITY, bottom: Number.NaN }, CONSTRAINTS, SIDEBAR_EXPANDED, RESERVED],
    ["footprint NaN", { x: 300, bottom: 200 }, { ...CONSTRAINTS, footprint: { w: Number.NaN, h: -10 } }, SIDEBAR_EXPANDED, RESERVED],
    ["âncora maior que o bloco", { x: 300, bottom: 200 }, { ...CONSTRAINTS, anchorOffsetX: 9999 }, SIDEBAR_EXPANDED, RESERVED],
    ["topInset maior que a janela", { x: 300, bottom: 200 }, { ...CONSTRAINTS, topInset: 5000 }, SIDEBAR_EXPANDED, RESERVED],
    ["Sidebar maior que a janela", { x: 300, bottom: 200 }, CONSTRAINTS, 5000, 5000],
  ];
  for (const [label, pos, c, sidebar, reserved] of absurdos) {
    const p = computeChatPanelPlacement(pos, vp, AVATAR, sidebar, reserved, c);
    assert.ok(Number.isFinite(p.left) && Number.isFinite(p.bottom), `${label}: não finito`);
    assert.ok(p.width >= 0 && p.height >= 0, `${label}: dimensão negativa`);
    assert.ok(p.left >= EDGE_INSET_PX, `${label}: left=${p.left}`);
    assert.ok(p.left + p.width <= vp.w - EDGE_INSET_PX, `${label}: sai pela direita`);
    assert.ok(p.bottom >= EDGE_INSET_PX, `${label}: abaixo do fundo`);
    assert.ok(p.bottom + p.height <= vp.h - EDGE_INSET_PX, `${label}: acima do topo`);
  }
});

// ── Ligação na interface: o componente USA as medidas, não constantes ──

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "src", "components", "AIAssistant.tsx"), "utf8");

test("o componente mede a barra de janela e passa-a ao cálculo", () => {
  assert.match(SRC, /data-testid="app-titlebar"/, "a barra de janela não é medida");
  assert.match(SRC, /setTopInset\(/, "a medida da barra não chega ao estado");
  assert.match(SRC, /topInset,\s*\n\s*footprint: launcherFootprint/, "o cálculo não recebe topInset/footprint");
  assert.match(SRC, /data-matrix-top-inset=\{topInset\}/, "a medida não é observável no DOM");
});

test("o componente mede a pegada do bloco (avatar + menu) e ancora no avatar", () => {
  assert.match(SRC, /ref=\{launcherRowRef\}/, "a linha do launcher não tem ref para medir");
  assert.match(SRC, /setLauncherFootprint\(/, "a pegada do bloco não é medida");
  assert.match(SRC, /anchorOffsetX: Math\.max\(0, launcherFootprint\.w - launcherSize\.w\)/, "a âncora não desconta o menu");
  assert.match(SRC, /data-matrix-footprint-w=\{launcherFootprint\.w\}/, "a pegada não é observável no DOM");
});

test("o painel expõe a geometria calculada e as mensagens continuam a fazer scroll", () => {
  assert.match(SRC, /data-matrix-chat-left=\{chatPlacement\.left\}/);
  assert.match(SRC, /data-matrix-chat-bottom=\{chatPlacement\.bottom\}/);
  assert.match(SRC, /data-matrix-chat-width=\{chatPlacement\.width\}/);
  assert.match(SRC, /data-matrix-chat-height=\{chatPlacement\.height\}/);
  assert.match(SRC, /flex-1 min-h-0 overflow-y-auto[^"]*overscroll-contain/, "a lista de mensagens deixou de ser a zona flexível com scroll");
  assert.match(SRC, /scrollRef\.current\.scrollTop = scrollRef\.current\.scrollHeight/, "o autoscroll das mensagens desapareceu");
  const chrome = SRC.slice(SRC.indexOf("data-matrix-privacy"), SRC.indexOf("{/* Messages */}"));
  assert.match(chrome, /shrink-0/, "o cabeçalho pode encolher e empurrar as mensagens para zero");
});

test("mecanismos aprovados intactos: arrasto, encaixe e modo fixado", () => {
  assert.match(SRC, /projectPointerDrag\(\s*\n\s*drag\.from,\s*\n\s*drag\.startClient,/, "o arrasto mudou de forma");
  assert.match(SRC, /\{ allowDockBand: true \}/, "a banda de encaixe deixou de ser atravessável no gesto");
  assert.match(SRC, /persistLauncherMode\("docked"\)/, "largar sobre a barra deixou de fixar");
  assert.match(SRC, /computeDockedChatPlacement\(viewport\(\), sidebarWidth, reservedBottom\)/, "a colocação do modo fixado foi alterada");
  assert.match(SRC, /isDockGesture\(next, launcherSize, sidebarWidth\)/, "o gesto de encaixe deixou de usar o centro do avatar");
});
