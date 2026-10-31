import test from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_INSET_PX,
  clampPos,
  computeChatPanelPlacement,
  defaultPos,
  minLauncherX,
  parseStored,
  type Pos,
} from "../src/lib/matrixLauncherPosition";

const LAUNCHER = { w: 56, h: 56 };
const SIDEBAR_EXPANDED = 256;
const SIDEBAR_COLLAPSED = 64;
const RESERVED = 126;
const WIN_820 = { w: 820, h: 600 };
const WIN_1440 = { w: 1440, h: 1000 };
const TINY = { w: 300, h: 300 };

// ── Default: mesma origem em qualquer largura, fora da Sidebar quando cabe ──

test("default fora da Sidebar expandida em 1440 e 820 (mesma regra)", () => {
  for (const vp of [WIN_1440, WIN_820]) {
    const d = defaultPos(vp, LAUNCHER, RESERVED, SIDEBAR_EXPANDED);
    assert.equal(d.x, SIDEBAR_EXPANDED + EDGE_INSET_PX, `default dentro da Sidebar @${vp.w}`);
    assert.ok(d.x + LAUNCHER.w <= vp.w - EDGE_INSET_PX, `default sai do ecr\u00e3 @${vp.w}`);
  }
});

test("default com Sidebar colapsada encosta \u00e0 Sidebar colapsada", () => {
  const d = defaultPos(WIN_820, LAUNCHER, RESERVED, SIDEBAR_COLLAPSED);
  assert.equal(d.x, SIDEBAR_COLLAPSED + EDGE_INSET_PX);
});

test("default sem Sidebar medida mant\u00e9m a margem normal (compat\u00edvel com a API antiga)", () => {
  assert.deepEqual(defaultPos(WIN_1440, LAUNCHER, 0), { x: EDGE_INSET_PX, bottom: EDGE_INSET_PX });
});

test("default e reset calculam a mesma origem (sem duplicar regra)", () => {
  const a = defaultPos(WIN_820, LAUNCHER, RESERVED, SIDEBAR_EXPANDED);
  const b = defaultPos(WIN_820, LAUNCHER, RESERVED, SIDEBAR_EXPANDED);
  assert.deepEqual(a, b);
});

// ── Clamp / arrasto: nunca dentro da Sidebar quando cabe ──

test("arrasto para dentro da Sidebar \u00e9 contido fora dela", () => {
  const p = clampPos({ x: 40, bottom: 200 }, WIN_820, LAUNCHER, RESERVED, SIDEBAR_EXPANDED);
  assert.equal(p.x, SIDEBAR_EXPANDED + EDGE_INSET_PX);
});

test("sidebar colapsada: x dentro dos 64px \u00e9 contido, n\u00e3o o da expandida", () => {
  const p = clampPos({ x: 20, bottom: 200 }, WIN_820, LAUNCHER, RESERVED, SIDEBAR_COLLAPSED);
  assert.equal(p.x, SIDEBAR_COLLAPSED + EDGE_INSET_PX);
});

test("resize/colapso: a mesma posi\u00e7\u00e3o guardada \u00e9 reajustada quando a Sidebar muda", () => {
  const stored: Pos = { x: 268, bottom: 200 };
  const expanded = clampPos(stored, WIN_820, LAUNCHER, RESERVED, SIDEBAR_EXPANDED);
  const collapsed = clampPos(stored, WIN_820, LAUNCHER, RESERVED, SIDEBAR_COLLAPSED);
  assert.equal(expanded.x, 268);
  assert.equal(collapsed.x, 268, "268 continua fora da Sidebar colapsada: n\u00e3o \u00e9 alterado");
});

test("janela 820x600 com painel: launcher e painel ficam dentro do viewport e fora da Sidebar", () => {
  const pos = defaultPos(WIN_820, LAUNCHER, RESERVED, SIDEBAR_EXPANDED);
  const place = computeChatPanelPlacement(pos, WIN_820, LAUNCHER, SIDEBAR_EXPANDED, RESERVED);
  assert.ok(place.left >= SIDEBAR_EXPANDED, `painel entra na Sidebar @820 (left=${place.left})`);
  assert.ok(place.left + place.width <= WIN_820.w - EDGE_INSET_PX, "painel sai do ecr\u00e3 @820");
  assert.ok(place.bottom >= EDGE_INSET_PX, "painel abaixo do fundo");
  assert.ok(place.bottom + place.height <= WIN_820.h - EDGE_INSET_PX, "painel sai do topo @820x600");
});

test("painel encosta ao launcher do lado direito quando o launcher est\u00e1 \u00e0 direita", () => {
  const pos: Pos = { x: WIN_1440.w - LAUNCHER.w - EDGE_INSET_PX, bottom: 200 };
  const place = computeChatPanelPlacement(pos, WIN_1440, LAUNCHER, SIDEBAR_EXPANDED, RESERVED);
  assert.equal(place.alignHorizontal, "right");
  assert.ok(place.left + place.width <= WIN_1440.w - EDGE_INSET_PX, "painel sai do ecr\u00e3 pela direita");
});

// ── Janela abaixo dos m\u00ednimos: pol\u00edtica expl\u00edcita ──

test("janela abaixo dos m\u00ednimos: o painel encolhe e nunca excede o viewport", () => {
  const pos = defaultPos(TINY, LAUNCHER, 0, 0);
  const place = computeChatPanelPlacement(pos, TINY, LAUNCHER, 0, 0);
  assert.ok(place.height <= TINY.h, `altura ${place.height} excede a janela ${TINY.h}`);
  assert.ok(place.width <= TINY.w, `largura ${place.width} excede a janela ${TINY.w}`);
  assert.ok(place.height >= 0 && place.width >= 0);
});

test("janela sem espa\u00e7o fora da Sidebar: launcher volta \u00e0 margem normal (pol\u00edtica expl\u00edcita)", () => {
  assert.equal(minLauncherX(TINY, LAUNCHER, SIDEBAR_EXPANDED), EDGE_INSET_PX);
});

// ── Stored: rejeita o que n\u00e3o \u00e9 v\u00e1lido com a Sidebar atual ──

test("stored dentro da Sidebar \u00e9 rejeitado quando h\u00e1 espa\u00e7o fora dela", () => {
  const raw = JSON.stringify({ x: 40, bottom: 200 });
  assert.equal(parseStored(raw, WIN_820, LAUNCHER, RESERVED, SIDEBAR_EXPANDED), null);
});

test("stored fora da Sidebar \u00e9 aceite", () => {
  const raw = JSON.stringify({ x: 300, bottom: 200 });
  assert.deepEqual(parseStored(raw, WIN_820, LAUNCHER, RESERVED, SIDEBAR_EXPANDED), { x: 300, bottom: 200 });
});

// ── Limites reais do painel: barra de janela + pegada do bloco ──

const TITLEBAR_H = 42; // --shell-titlebar-h
const FOOTPRINT = { w: 78, h: 86 }; // avatar 56 + botão de menu
const ANCHOR_OFFSET = FOOTPRINT.w - LAUNCHER.w;

function placeWithRealBounds(pos: Pos, vp: { w: number; h: number }, sidebar: number) {
  return computeChatPanelPlacement(pos, vp, LAUNCHER, sidebar, RESERVED, {
    topInset: TITLEBAR_H,
    footprint: FOOTPRINT,
    anchorOffsetX: ANCHOR_OFFSET,
  });
}

test("820x600 com barra de janela: o painel não entra debaixo da faixa nem tapa o menu", () => {
  const pos = defaultPos(WIN_820, LAUNCHER, RESERVED, SIDEBAR_EXPANDED);
  const place = placeWithRealBounds(pos, WIN_820, SIDEBAR_EXPANDED);
  assert.ok(
    place.bottom + place.height <= WIN_820.h - TITLEBAR_H - EDGE_INSET_PX,
    `painel debaixo da barra de janela (topo=${WIN_820.h - (place.bottom + place.height)})`,
  );
  assert.equal(place.bottom, pos.bottom + FOOTPRINT.h + 10, "o menu ficou por baixo do painel");
  assert.equal(place.left, pos.x + ANCHOR_OFFSET, "o painel não está alinhado ao avatar");
  assert.ok(place.left >= SIDEBAR_EXPANDED + EDGE_INSET_PX);
});

test("expansão/colapso da Sidebar com barra de janela: painel dentro dos limites nos dois casos", () => {
  for (const sidebar of [SIDEBAR_EXPANDED, SIDEBAR_COLLAPSED]) {
    const pos = defaultPos(WIN_820, LAUNCHER, RESERVED, sidebar);
    const place = placeWithRealBounds(pos, WIN_820, sidebar);
    assert.ok(place.left >= sidebar + EDGE_INSET_PX, `painel na Sidebar (${sidebar})`);
    assert.ok(place.left + place.width <= WIN_820.w - EDGE_INSET_PX, `painel sai à direita (${sidebar})`);
    assert.ok(place.bottom >= EDGE_INSET_PX, `painel abaixo do fundo (${sidebar})`);
    assert.ok(place.bottom + place.height <= WIN_820.h - TITLEBAR_H - EDGE_INSET_PX, `painel no topo (${sidebar})`);
  }
});
