// TP-MATRIX-DRAG — RED primeiro: geometria do launcher da Matrix, sem DOM.
//   npm run test (tsx) resolve `./x.js` → `x.ts`; para correr SEM tsx usa-se o
//   loader de resolução do tooling isolado:
//   node --import <tooling>/resolve-iso.mjs --test test/matrix-launcher-position.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  MATRIX_POS_KEY,
  DRAG_THRESHOLD_PX,
  KEYBOARD_STEP_PX,
  EDGE_INSET_PX,
  defaultPos,
  clampPos,
  parseStored,
  serialize,
  movedEnoughToDrag,
  reservedBottomFromFooter,
  projectPointerDrag,
  computeChatPanelPlacement,
} from "../src/lib/matrixLauncherPosition.js";

const VP = { w: 1440, h: 1000 };
const LAUNCHER = { w: 56, h: 56 };

test("default é inferior-esquerdo e não invade a reserva do rodapé", () => {
  const reserved = 180;
  const p = defaultPos(VP, LAUNCHER, reserved);
  assert.equal(p.x, EDGE_INSET_PX, "esquerda encostada à margem de segurança");
  assert.equal(p.bottom, reserved + EDGE_INSET_PX, "fica ACIMA do bloco de conta/status");
  assert.ok(p.bottom > reserved, "respeita a reserva");
  assert.deepEqual(clampPos(p, VP, LAUNCHER, reserved), p);
});

test("arrastamento livre no ecrã todo: reserva do rodapé da Sidebar só aplica quando x sobrepõe a Sidebar", () => {
  const reserved = 180;
  const sidebarW = 260;
  // Com espaço fora da Sidebar, um x dentro dela é corrigido para fora (contenção).
  const overSidebar = clampPos({ x: 20, bottom: 12 }, VP, LAUNCHER, reserved, sidebarW);
  assert.equal(overSidebar.x, sidebarW + EDGE_INSET_PX, "x dentro da Sidebar tem de ser contido para fora");
  assert.equal(overSidebar.bottom, 12, "fora da Sidebar não há reserva do rodapé");
  // Janela estreita sem espaço fora da Sidebar: aceita sobreposição, com reserva.
  const narrow = { w: 300, h: 600 };
  const forced = clampPos({ x: 20, bottom: 12 }, narrow, LAUNCHER, reserved, sidebarW);
  assert.equal(forced.x, 20);
  assert.equal(forced.bottom, reserved + EDGE_INSET_PX, "sobre a sidebar não tapa o bloco de conta");

  const outsideSidebar = clampPos({ x: 500, bottom: 12 }, VP, LAUNCHER, reserved, sidebarW);
  assert.equal(outsideSidebar.x, 500);
  assert.equal(outsideSidebar.bottom, EDGE_INSET_PX, "fora da sidebar pode ir até ao fundo do ecrã");
});

test("projectPointerDrag calcula delta a partir de startClient (sem saltos e com movimento XY suave)", () => {
  const from = { x: 268, bottom: 138 };
  const startClient = { x: 158, y: 834 };
  // Sem mover o ponteiro: zero salto!
  const stationary = projectPointerDrag(from, startClient, { x: 158, y: 834 }, VP, LAUNCHER, 126, 256);
  assert.deepEqual(stationary, from, "sem mover o ponteiro não há salto");

  // Pedido do drag-probe: dx +160, dy -180 (180 px para cima)
  const moved = projectPointerDrag(from, startClient, { x: 158 + 160, y: 834 - 180 }, VP, LAUNCHER, 126, 256);
  assert.deepEqual(moved, { x: 428, bottom: 318 }, "delta X (+160) e delta Y (+180 em bottom) exatos");
});

test("computeChatPanelPlacement evita sobrepor a sidebar, adapta-se ao lado do ecrã e é compacto", () => {
  const sidebarW = 260;
  const leftPlacement = computeChatPanelPlacement({ x: 12, bottom: 138 }, VP, LAUNCHER, sidebarW, 126);
  assert.equal(leftPlacement.alignHorizontal, "left", "abre alinhado à esquerda quando launcher está à esquerda");
  assert.ok(leftPlacement.width <= 420 && leftPlacement.width >= 320, `largura compacta profissional (width=${leftPlacement.width})`);
  assert.ok(leftPlacement.height <= 480 && leftPlacement.height >= 280, `altura compacta profissional (height=${leftPlacement.height})`);
  assert.ok(leftPlacement.left >= sidebarW + EDGE_INSET_PX, `não tapa a sidebar (left=${leftPlacement.left})`);

  const rightPlacement = computeChatPanelPlacement({ x: 1350, bottom: 24 }, VP, LAUNCHER, sidebarW, 126);
  assert.equal(rightPlacement.alignHorizontal, "right", "abre para a esquerda quando o launcher está à direita");
  assert.ok(rightPlacement.left + rightPlacement.width <= VP.w - EDGE_INSET_PX, "nunca sai pela direita do viewport");

  const topPlacement = computeChatPanelPlacement({ x: 500, bottom: 900 }, VP, LAUNCHER, sidebarW, 126);
  assert.equal(topPlacement.openDirection, "down", "abre para baixo do launcher quando não cabe acima");
});

test("clamp aceita o absurdo e devolve sempre geometria dentro do viewport", () => {
  const cases = [
    { x: -5000, bottom: -5000 },
    { x: 99999, bottom: 99999 },
    { x: Number.NaN, bottom: Number.POSITIVE_INFINITY },
    { x: 100, bottom: Number.NaN },
  ];
  for (const pos of cases) {
    const c = clampPos(pos, VP, LAUNCHER, 180);
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.bottom), `finitos: ${JSON.stringify(c)}`);
    assert.ok(c.x >= EDGE_INSET_PX, `x >= EDGE (recebeu ${c.x})`);
    assert.ok(c.x + LAUNCHER.w <= VP.w - EDGE_INSET_PX, `x dentro da direita (recebeu ${c.x})`);
    assert.ok(c.bottom >= 180 + EDGE_INSET_PX, `bottom acima da reserva (recebeu ${c.bottom})`);
    assert.ok(c.bottom + LAUNCHER.h <= VP.h - EDGE_INSET_PX, `bottom dentro do topo (recebeu ${c.bottom})`);
  }
  for (const bad of [null, undefined, "x", 42, {}, { x: "1" }, { x: null, bottom: undefined }] as unknown[]) {
    const c = clampPos(bad as never, VP, LAUNCHER, 180);
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.bottom), `entrada ${JSON.stringify(bad)} → ${JSON.stringify(c)}`);
  }
});

test("armazenamento corrompido volta ao default, sem rebentar e sem fingir posição", () => {
  const corrupt = ['', '   ', 'null', 'undefined', '{', '{"x":1}', '{"x":"12","bottom":"30"}',
    '{"x":null,"bottom":null}', '{"x":NaN}', '[1,2]', '{"x":1e999,"bottom":1e999}'];
  for (const raw of corrupt) {
    assert.equal(parseStored(raw, VP, LAUNCHER, 180), null, `devolve null para ${JSON.stringify(raw)}`);
  }
  assert.equal(parseStored(JSON.stringify({ x: -9000, bottom: -9000 }), VP, LAUNCHER, 180), null);
  assert.equal(parseStored(JSON.stringify({ x: 10, bottom: 2000 }), VP, LAUNCHER, 180), null);
});

test("round-trip estável e aceite pelo parse", () => {
  const pos = { x: 320, bottom: 240 };
  const raw = serialize(pos);
  assert.equal(MATRIX_POS_KEY, "cybersafe.matrixLauncher.v1", "chave com namespace do produto");
  assert.deepEqual(parseStored(raw, VP, LAUNCHER, 180), pos);
});

test("viewport que encolhe traz o launcher para dentro (re-clamp, sem desaparecer)", () => {
  const wide = clampPos({ x: 1300, bottom: 700 }, VP, LAUNCHER, 180);
  assert.ok(wide.x + LAUNCHER.w <= VP.w - EDGE_INSET_PX);
  const small = { w: 800, h: 600 };
  const re = clampPos(wide, small, LAUNCHER, reservedBottomFromFooter({ top: 420, height: 160 }, small));
  assert.ok(re.x + LAUNCHER.w <= small.w - EDGE_INSET_PX, `x dentro (recebeu ${re.x})`);
  assert.ok(re.bottom + LAUNCHER.h <= small.h - EDGE_INSET_PX, `bottom dentro (recebeu ${re.bottom})`);
  assert.ok(re.bottom >= EDGE_INSET_PX);
});

test("limiar separa clique de arrasto (distância euclidiana, não só um eixo)", () => {
  assert.equal(movedEnoughToDrag({ x: 0, bottom: 0 }, { x: 5, bottom: 0 }), false);
  assert.equal(movedEnoughToDrag({ x: 0, bottom: 0 }, { x: 0, bottom: 5 }), false);
  assert.equal(movedEnoughToDrag({ x: 0, bottom: 0 }, { x: 4, bottom: 4 }), DRAG_THRESHOLD_PX ** 2 <= 32);
  assert.equal(movedEnoughToDrag({ x: 0, bottom: 0 }, { x: 6, bottom: 1 }), true);
  assert.equal(movedEnoughToDrag({ x: 100, bottom: 50 }, { x: 100, bottom: 50 }), false, "sem movimento é clique");
});

test("teclado anda em passos e nunca sai do viewport", () => {
  assert.equal(KEYBOARD_STEP_PX, 16);
  let pos = defaultPos(VP, LAUNCHER, 180);
  for (let i = 0; i < 200; i++) pos = clampPos({ x: pos.x - KEYBOARD_STEP_PX, bottom: pos.bottom + KEYBOARD_STEP_PX }, VP, LAUNCHER, 180);
  assert.equal(pos.x, EDGE_INSET_PX, "bate na margem e pára");
  assert.ok(pos.bottom + LAUNCHER.h <= VP.h - EDGE_INSET_PX);
});

test("reserva do rodapé: medida real, sem rodapé é zero, Rect inválido não inventa", () => {
  assert.equal(reservedBottomFromFooter({ top: 700, height: 280 }, VP), 1000 - 700, "do topo do rodapé até à base");
  assert.equal(reservedBottomFromFooter(null, VP), 0);
  assert.equal(reservedBottomFromFooter({ top: NaN, height: 10 }, VP), 0);
  assert.equal(reservedBottomFromFooter({ top: -50, height: 10 }, VP), 0, "rodapé fora do viewport não reserva");
});

test("painel flutuante com limites reais: barra de janela + pegada do bloco (avatar+menu)", () => {
  const sidebarW = 260;
  const footprint = { w: 78, h: 86 };
  const pos = { x: 300, bottom: 100 };

  const semLimites = computeChatPanelPlacement(pos, VP, LAUNCHER, sidebarW, 126);
  const comLimites = computeChatPanelPlacement(pos, VP, LAUNCHER, sidebarW, 126, {
    topInset: 42,
    footprint,
    anchorOffsetX: footprint.w - LAUNCHER.w,
  });

  // Âncora horizontal é o avatar (bloco à esquerda + 22 px), não a borda do menu.
  assert.equal(comLimites.left, pos.x + 22);
  // Âncora vertical é o TOPO do bloco inteiro (menu incluído).
  assert.equal(comLimites.bottom, pos.bottom + footprint.h + 10);
  assert.ok(comLimites.bottom > semLimites.bottom, "a pegada do menu não elevou o painel");
  assert.ok(
    comLimites.bottom + comLimites.height <= VP.h - 42 - EDGE_INSET_PX,
    "o painel entrou debaixo da barra de janela",
  );
});
