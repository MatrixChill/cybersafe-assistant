import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Geometria do launcher Matrix (AIAssistant) — contrato TP-MATRIX-DRAG.
//
// Substitui o contrato anterior (âncora direita com reserva de toasts,
// TP-GROQ-MATRIX-ELECTRON-UX). O default passa a ser o canto inferior-ESQUERDO,
// fora da Sidebar, e a posição é aplicada por estilo inline (`left`/`bottom`),
// com arrasto, persistência e reposição. A aritmética pura vive em
// `lib/matrixLauncherPosition.ts` e é testada no seu próprio ficheiro.
//
// Leitura da FONTE + aritmética: nada corre a app nem a IA.

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "AIAssistant.tsx"),
  "utf8",
);

// Constantes transcritas da fonte (Tailwind: nº × 0.25rem, NÃO nº × 16).
const SIDEBAR_EXPANDED = 256; // index.css --shell-sidebar-w 16rem
const EDGE_INSET = 12; // EDGE_INSET_PX em lib/matrixLauncherPosition.ts
const FAB = 56; // `w-14` = 3.5rem = 56
const PANEL = 520; // `w-[520px]`
// Janela real do Electron: minWidth 820 / minHeight 600 (packages/desktop/src/main.ts:225).
const WIDTHS = [1200, 820];

function launcherContainerClass(): string {
  const m = SRC.match(/<div\s+ref=\{rootRef\}\s+className="(fixed z-\[100\][^"]*)"/);
  assert.ok(m, "não encontrámos o contentor do launcher (fixed z-[100] …) em AIAssistant.tsx");
  return m[1];
}

test("launcher posiciona-se por estilo inline (left/bottom), não por âncora direita", () => {
  const cls = launcherContainerClass();
  assert.doesNotMatch(cls, /\bright-/, "âncora direita antiga (right-…) ainda presente");
  assert.doesNotMatch(cls, /\bbottom-6\b/, "bottom fixo: a posição tem de vir do estado aplicado");
  // TP-MATRIX-DOCK: a posição vem de `origin`, que em modo flutuante É a
  // posição aplicada (`appliedPos`) e em modo fixado é a zona de encaixe da
  // Sidebar. O que este contrato exige mantém-se: estilo inline, não classe.
  assert.match(
    SRC,
    /style=\{\{ left: origin\.x, bottom: origin\.bottom \}\}/,
    "a posição aplicada (x, bottom) não está a ser escrita no contentor",
  );
  // P1: o painel lateral tem origem própria; fora dele (flutuante) continua a
  // ser a posição aplicada. A intenção do contrato mantém-se.
  assert.match(
    SRC,
    /const origin = panelPlacement\s*\n\s*\? \{ x: panelPlacement\.left, bottom: panelPlacement\.bottom \}\s*\n\s*: launcherMode === "docked" && dockSlot\s*\n\s*\? dockSlot\s*\n\s*: appliedPos/,
    "origin deixou de cair em appliedPos no modo flutuante",
  );
});

test("default inferior-esquerdo: fora da Sidebar, sem centro nem translate", () => {
  const cls = launcherContainerClass();
  assert.doesNotMatch(cls, /\bleft-1\/2\b/, "ainda centrado — não é o canto inferior-esquerdo");
  assert.doesNotMatch(cls, /-translate-x-1\/2/, "continua com o deslocamento de centro");
  assert.match(SRC, /defaultPos\(vp, launcherSize, reservedBottom, sidebarWidth\)/, "o default tem de usar o helper com a Sidebar medida (regra única)");
  assert.doesNotMatch(SRC, /function launcherDefault\(/, "wrapper duplicado da regra do default");
});

for (const vw of WIDTHS) {
  test(`viewport ${vw}: default do launcher e cabe fora da Sidebar`, () => {
    const x = SIDEBAR_EXPANDED + EDGE_INSET;
    assert.ok(x >= SIDEBAR_EXPANDED, `FAB em ${x} invade a Sidebar expandida @${vw}`);
    assert.ok(x + FAB <= vw, `FAB sai do ecrã @${vw}`);
  });
}

test("painel é colocado pelo helper ancorado ao launcher (não por classe fixa)", () => {
  assert.match(SRC, /computeChatPanelPlacement\(origin,/, "o painel não usa a colocacão ancorada real");
  assert.match(SRC, /computeDockedChatPlacement\(viewport\(\), sidebarWidth, reservedBottom\)/, "o modo fixado não tem colocação própria na área principal");
  assert.match(SRC, /data-matrix-chat-open=/, "a direção de abertura do painel não é exposta");
  assert.ok(PANEL <= 1200, "o painel de projeto não pode exceder a janela de referência");
});

test("identidade e ações do FAB permanecem (isto é só posicionamento)", () => {
  assert.match(SRC, /aria-label="Abrir assistente Matrix AI"/, "ação/FAB do launcher alterada");
  assert.match(SRC, />Matrix</, "identidade (título Matrix) do painel alterada");
  assert.match(SRC, /w-14 h-14 rounded-full/, "o FAB mudou de dimensão/shape");
});

test("rótulo empilhado ACIMA sem deslocar o FAB: coluna alinhada à direita", () => {
  // `items-end` (e não `items-center`): com o rótulo transiente visível, uma coluna
  // centrada alarga-se para a largura do rótulo e o FAB desloca-se.
  // TP-MATRIX-DOCK: coluna vertical no modo flutuante; linha quando está
  // fixada; coluna outra vez na barra RECOLHIDA (não há largura para a linha).
  assert.match(SRC, /"flex-col items-end"/, "launcher não é coluna alinhada à direita no modo flutuante");
  assert.match(SRC, /sidebarWidth > 0 && sidebarWidth < 140/, "a barra recolhida não tem tratamento próprio");
  assert.match(SRC, /"flex-row items-center"/, "o modo fixado deixou de ser linha");
  assert.doesNotMatch(SRC, /"flex flex-col items-center gap-1\.5"/, "coluna centrada volta a deslocar o FAB");
  // P1 22/10: a bolha «Matrix AI / Pergunta-me algo» era uma legenda permanente
  // por cima de gráficos e cartões — saiu.
  assert.doesNotMatch(SRC, />\s*Pergunta-me algo\s*</, "voltou a legenda permanente sobre o conteúdo");
  assert.doesNotMatch(SRC, /showLabel/, "sobrou estado de rótulo");
});
