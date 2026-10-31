import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_SIDE_PANEL_MAX_W,
  CHAT_SIDE_PANEL_MIN_W,
  EDGE_INSET_PX,
  computeSidePanelPlacement,
  parseStoredMode,
} from "../src/lib/matrixLauncherPosition";

/**
 * P1 — CONVERSA EM PAINEL LATERAL.
 *
 * O painel vive à direita da ÁREA PRINCIPAL (nunca por cima da Sidebar), respeita
 * a barra de janela e publica a largura que o conteúdo cede. A conversa é a
 * mesma instância do componente: trocar de modo não apaga mensagens.
 */

const TITLEBAR = 42;
const SIDEBAR_EXPANDED = 256;
const SIDEBAR_COLLAPSED = 64;

test("o modo «panel» é um modo válido e o lixo continua a cair em floating", () => {
  assert.equal(parseStoredMode("panel"), "panel");
  for (const lixo of [null, undefined, "", "PANEL", "popup", "docked "]) {
    assert.equal(parseStoredMode(lixo as string | null | undefined), "floating", String(lixo));
  }
});

test("painel lateral: encostado à direita, nunca sobre a Sidebar, dentro do ecrã", () => {
  for (const vp of [{ w: 1440, h: 1000 }, { w: 1200, h: 800 }, { w: 820, h: 600 }]) {
    for (const sidebar of [SIDEBAR_EXPANDED, SIDEBAR_COLLAPSED, 0]) {
      const p = computeSidePanelPlacement(vp, sidebar, TITLEBAR);
      const regionLeft = sidebar > 0 ? sidebar + EDGE_INSET_PX : EDGE_INSET_PX;
      assert.ok(p.left >= regionLeft, `entra na Sidebar @${vp.w} (left=${p.left}, limite=${regionLeft})`);
      assert.equal(p.left + p.width, vp.w - EDGE_INSET_PX, `não encosta à direita @${vp.w}`);
      assert.equal(p.bottom, EDGE_INSET_PX, `não encosta ao fundo @${vp.w}`);
      assert.equal(p.bottom + p.height, vp.h - TITLEBAR - EDGE_INSET_PX, `não respeita a barra @${vp.w}`);
      assert.ok(p.width > 0 && p.height > 0, `painel sem área @${vp.w}`);
    }
  }
});

test("largura: preferida dentro dos limites quando há espaço, encolhe quando não há", () => {
  const normal = computeSidePanelPlacement({ w: 1440, h: 1000 }, SIDEBAR_EXPANDED, TITLEBAR);
  assert.ok(normal.width >= CHAT_SIDE_PANEL_MIN_W && normal.width <= CHAT_SIDE_PANEL_MAX_W, `largura ${normal.width}`);

  // 520 − 268 − 12 = 240 px livres: abaixo do mínimo, o painel encolhe em vez de
  // sair do ecrã ou entrar na barra.
  const pequeno = computeSidePanelPlacement({ w: 520, h: 420 }, SIDEBAR_EXPANDED, TITLEBAR);
  assert.equal(pequeno.width, 240);
  assert.equal(pequeno.left, SIDEBAR_EXPANDED + EDGE_INSET_PX);
  assert.ok(pequeno.left + pequeno.width <= 520 - EDGE_INSET_PX);
});

test("a área útil cede exatamente a largura do painel mais as duas margens", () => {
  const p = computeSidePanelPlacement({ w: 1200, h: 800 }, SIDEBAR_EXPANDED, TITLEBAR);
  assert.equal(p.width + 2 * EDGE_INSET_PX, p.width + 24, "largura publicada ao shell");
  const conteudo = 1200 - SIDEBAR_EXPANDED - (p.width + 2 * EDGE_INSET_PX);
  assert.ok(conteudo > 0, "o conteúdo deixou de ter área útil");
});

test("Sidebar recolhida dá mais área útil ao conteúdo (não muda a direita)", () => {
  const expandida = computeSidePanelPlacement({ w: 820, h: 600 }, SIDEBAR_EXPANDED, TITLEBAR);
  const recolhida = computeSidePanelPlacement({ w: 820, h: 600 }, SIDEBAR_COLLAPSED, TITLEBAR);
  assert.equal(expandida.left, recolhida.left, "o painel não se move com o colapso (está à direita)");
  assert.equal(expandida.width, recolhida.width);
});

test("entradas absurdas devolvem sempre geometria contida e finita", () => {
  const casos: Array<[number, number, number, { w: number; h: number }]> = [
    [Number.NaN, Number.NaN, Number.NaN, { w: 1024, h: 768 }],
    [Number.POSITIVE_INFINITY, 5000, 9999, { w: 1024, h: 768 }],
    [-30, -30, -30, { w: 1024, h: 768 }],
    [0, 0, 0, { w: 300, h: 300 }],
  ];
  for (const [sidebar, topInset, _na, vp] of casos) {
    const p = computeSidePanelPlacement(vp, sidebar, topInset);
    assert.ok(Number.isFinite(p.left) && Number.isFinite(p.bottom), "geometria não finita");
    assert.ok(p.width >= 0 && p.height >= 0, "dimensão negativa");
    assert.ok(p.left >= 0 && p.left + p.width <= vp.w, "painel sai do ecrã");
    assert.ok(p.bottom >= 0 && p.bottom + p.height <= vp.h, "painel sai do ecrã");
  }
});

// ── Ligação ao componente e ao shell (leitura da fonte) ──

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, ...parts), "utf8");
const assistant = read("..", "src", "components", "AIAssistant.tsx");
const app = read("..", "src", "App.tsx");
const css = read("..", "src", "index.css");

test("o componente calcula e publica a largura do painel no <html>", () => {
  assert.match(assistant, /computeSidePanelPlacement\(viewport\(\), sidebarWidth, topInset\)/);
  assert.match(assistant, /root\.setAttribute\("data-matrix-panel", "open"\)/);
  assert.match(assistant, /setProperty\("--matrix-panel-w", `\$\{place\.width \+ 2 \* EDGE_INSET_PX\}px`\)/);
  assert.match(assistant, /removeAttribute\("data-matrix-panel"\)/, "o sinal não é limpo ao sair do modo");
});

test("o shell cede largura real à área principal (sem novo sistema de janelas)", () => {
  assert.match(app, /<main ref=\{mainScrollRef\} data-cs-main=""/, "a área principal não é identificável");
  assert.match(css, /html\[data-matrix-panel="open"\] \[data-cs-main\]\s*\{[^}]*padding-right:\s*var\(--matrix-panel-w/, "o conteúdo não cede largura");
});

test("os três modos ficam alcançáveis: flutuante, lateral e minimizada", () => {
  assert.match(assistant, /Abrir painel lateral/, "falta a opção de painel no menu");
  assert.match(assistant, /persistLauncherMode\("panel"\)/, "o modo painel não é persistido");
  assert.match(assistant, /aria-label="Voltar a flutuar"/, "não há caminho de volta ao flutuante");
  assert.match(assistant, /aria-label="Minimizar a Matrix"/, "não há caminho para minimizada");
  assert.match(assistant, /launcherMode === "panel"[\s\S]{0,200}persistLauncherMode\("floating"\)/, "fechar o painel não devolve o avatar");
});

test("o painel lateral não desenha a linha do avatar por baixo do chat", () => {
  assert.match(assistant, /\{launcherMode !== "panel" && \(\s*\n\s*<div\s*\n\s*ref=\{launcherRowRef\}/, "o avatar continua a competir com o painel");
});

test("trocar de modo preserva a conversa (o mesmo estado, sem remontagem)", () => {
  const persist = /const persistLauncherMode = useCallback\(\(next: MatrixMode\) => \{([\s\S]*?)\}, \[\]\)/.exec(assistant)?.[1] ?? "";
  assert.ok(persist, "persistLauncherMode não encontrado");
  assert.doesNotMatch(persist, /setMessages|setInput|setPhase/, "mudar de modo apaga a conversa");
  assert.doesNotMatch(assistant, /key=\{launcherMode\}/, "o chat é remontado ao mudar de modo");
});
