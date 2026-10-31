import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_INSET_PX,
  clampPos,
  defaultPos,
  isDockGesture,
  projectPointerDrag,
} from "../src/lib/matrixLauncherPosition";

/**
 * REGRESSÃO P0 (22/10) — a «linha invisível» do arrasto.
 *
 * Relato humano: no Electron, o avatar não descia além de ~180 px acima do
 * fundo da janela. A causa não era a reserva do rodapé em si: era o arrasto
 * chamar `projectPointerDrag` com `sidebarWidth = 0`, e esse 0 ser lido como
 * «sidebar desconhecida → reserva conservadora». A reserva protege o rodapé da
 * BARRA LATERAL; na área principal o limite inferior é a margem de segurança.
 *
 * Estes casos reproduzem exatamente o gesto: arrastar na área principal até
 * ~12 px do fundo, com o rodapé da sidebar presente (conta + estado).
 */

const FAB = { w: 56, h: 56 };
const SIDEBAR = 256;
const SIDEBAR_COLLAPSED = 72;
const RESERVED = 180; // topo do bloco de conta/estado até à base da janela
const VP = { w: 1440, h: 1000 };

function dragDown(fromX: number, fromBottom: number, pixelsDown: number, sidebarWidth: number) {
  const start = { x: fromX + 20, y: 200 };
  return projectPointerDrag(
    { x: fromX, bottom: fromBottom },
    start,
    { x: start.x, y: start.y + pixelsDown },
    VP,
    FAB,
    RESERVED,
    sidebarWidth,
    { allowDockBand: true },
  );
}

describe("P0 — limite inferior do arrasto na área principal", () => {
  test("arrastar até ao fundo chega a ~12 px, mesmo com o rodapé da sidebar presente", () => {
    const p = dragDown(SIDEBAR + EDGE_INSET_PX + 120, 400, 600, SIDEBAR);
    assert.equal(p.bottom, EDGE_INSET_PX, `parou em ${p.bottom} px — é a linha invisível`);
    assert.ok(p.bottom >= 12 && p.bottom <= 20, "tem de ficar a 12–20 px do fundo");
    assert.ok(p.x >= SIDEBAR + EDGE_INSET_PX, "não pode entrar na barra");
  });

  test("a CHAMADA antiga (sidebar 0) é o que produzia a linha: fica registada como regressão", () => {
    // Sem largura de barra, a reserva é conservadora e o fundo é 192 px.
    const antigo = dragDown(SIDEBAR + EDGE_INSET_PX + 120, 400, 600, 0);
    assert.equal(antigo.bottom, RESERVED + EDGE_INSET_PX, "o modo antigo continua a reservar (documentado, não usado no arrasto)");
    // Com a barra medida, o mesmo gesto desce até ao fundo.
    const agora = dragDown(SIDEBAR + EDGE_INSET_PX + 120, 400, 600, SIDEBAR);
    assert.ok(agora.bottom < antigo.bottom, "o arrasto na área principal tem de descer mais do que antes");
  });

  test("sobre a barra lateral a reserva continua a proteger conta e estado", () => {
    // x = 100 está dentro da barra: aqui a reserva é legítima.
    const p = dragDown(100, 400, 600, SIDEBAR);
    assert.equal(p.x, 100);
    assert.equal(p.bottom, RESERVED + EDGE_INSET_PX, "o avatar tapava a conta/estado");
  });

  test("os quatro limites: nunca sai da janela, com margem pequena", () => {
    const fundo = dragDown(SIDEBAR + 200, 300, 5000, SIDEBAR);
    assert.equal(fundo.bottom, EDGE_INSET_PX);

    const topo = projectPointerDrag(
      { x: 600, bottom: 300 }, { x: 620, y: 300 }, { x: 620, y: -5000 }, VP, FAB, RESERVED, SIDEBAR, { allowDockBand: true },
    );
    assert.equal(topo.bottom, VP.h - FAB.h - EDGE_INSET_PX, "saiu pelo topo");

    const direita = projectPointerDrag(
      { x: 600, bottom: 300 }, { x: 620, y: 300 }, { x: 5000, y: 300 }, VP, FAB, RESERVED, SIDEBAR, { allowDockBand: true },
    );
    assert.equal(direita.x, VP.w - FAB.w - EDGE_INSET_PX, "saiu pela direita");

    const esquerda = projectPointerDrag(
      { x: 600, bottom: 300 }, { x: 620, y: 300 }, { x: -5000, y: 300 }, VP, FAB, RESERVED, SIDEBAR, { allowDockBand: true },
    );
    assert.equal(esquerda.x, EDGE_INSET_PX, "saiu pela esquerda");
  });

  test("sidebar recolhida: o limite inferior não muda", () => {
    const p = dragDown(SIDEBAR_COLLAPSED + EDGE_INSET_PX + 80, 400, 600, SIDEBAR_COLLAPSED);
    assert.equal(p.bottom, EDGE_INSET_PX);
    assert.ok(p.x >= SIDEBAR_COLLAPSED + EDGE_INSET_PX);
  });

  test("janela pequena (820x600) também desce até ao fundo", () => {
    const vp = { w: 820, h: 600 };
    const p = projectPointerDrag(
      { x: 400, bottom: 200 }, { x: 420, y: 200 }, { x: 420, y: 900 }, vp, FAB, RESERVED, SIDEBAR, { allowDockBand: true },
    );
    assert.equal(p.bottom, EDGE_INSET_PX, "a linha voltou numa janela pequena");
    assert.ok(p.bottom + FAB.h <= vp.h, "o avatar passa do fundo");
  });

  test("o gesto de encaixe continua a chegar à barra", () => {
    const p = dragDown(SIDEBAR + 200, 400, 0, SIDEBAR);
    assert.equal(isDockGesture(p, FAB, SIDEBAR), false, "à direita da barra não é encaixe");

    const naBarra = projectPointerDrag(
      { x: SIDEBAR + EDGE_INSET_PX, bottom: 200 },
      { x: 600, y: 300 },
      { x: 150, y: 300 },
      VP, FAB, RESERVED, SIDEBAR, { allowDockBand: true },
    );
    assert.ok(naBarra.x < SIDEBAR, "o arrasto deixou de alcançar a zona de encaixe");
    assert.equal(isDockGesture(naBarra, FAB, SIDEBAR), true);
  });

  test("largar fora da barra re-encaixa o avatar fora dela, sem repor a reserva", () => {
    const solto = clampPos({ x: SIDEBAR + 200, bottom: EDGE_INSET_PX }, VP, FAB, RESERVED, SIDEBAR);
    assert.equal(solto.bottom, EDGE_INSET_PX, "o clamp de repouso voltou a aplicar a reserva na área principal");
  });

  test("a posição por omissão na área principal fica junto ao fundo", () => {
    const p = defaultPos(VP, FAB, RESERVED, SIDEBAR);
    assert.equal(p.x, SIDEBAR + EDGE_INSET_PX);
    assert.equal(p.bottom, EDGE_INSET_PX, "a posição inicial ainda nasce acima da linha");
  });
});
