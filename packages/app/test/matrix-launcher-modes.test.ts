import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCK_SLOT_PX,
  EDGE_INSET_PX,
  MATRIX_MODE_KEY,
  MATRIX_POS_KEY,
  clampPos,
  computeDockedChatPlacement,
  computeMinimizedPos,
  defaultPos,
  isDockGesture,
  parseStored,
  parseStoredMode,
  projectPointerDrag,
  serialize,
} from "../src/lib/matrixLauncherPosition";

/**
 * TP-MATRIX-DOCK — os três modos do launcher da Matrix.
 *
 * O que se prova aqui é o MECANISMO puro: leitura retrocompatível da
 * preferência antiga, decisão de encaixe, colocação do chat fixado e do botão
 * minimizado. O gesto real (arrastar e largar) e o pixel ficam para a
 * verificação humana; o que não pode regredir sem ninguém dar por isso é a
 * geometria, e é isso que está aqui.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, ...parts), "utf8");

const SIDEBAR = 256;
const FAB = { w: 56, h: 56 };
const VP = { w: 1200, h: 800 };

describe("preferência de modo — compatível com a versão anterior", () => {
  test("sem valor guardado o modo é flutuante (a preferência antiga só tinha posição)", () => {
    assert.equal(parseStoredMode(null), "floating");
    assert.equal(parseStoredMode(undefined), "floating");
    assert.equal(parseStoredMode(""), "floating");
  });

  test("os três modos válidos são lidos tal e qual", () => {
    for (const modo of ["floating", "docked", "minimized"] as const) {
      assert.equal(parseStoredMode(modo), modo);
    }
  });

  test("lixo nunca vira um modo inventado", () => {
    assert.equal(parseStoredMode("docked "), "floating");
    assert.equal(parseStoredMode("FIXO"), "floating");
    assert.equal(parseStoredMode("{\"x\":1}"), "floating");
  });

  test("a posição antiga continua a ser aceite (duas chaves, não uma migração destrutiva)", () => {
    const guardada = serialize({ x: SIDEBAR + EDGE_INSET_PX + 40, bottom: 120 });
    const lida = parseStored(guardada, VP, FAB, 0, SIDEBAR);
    assert.deepEqual(lida, { x: SIDEBAR + EDGE_INSET_PX + 40, bottom: 120 });
    assert.notEqual(MATRIX_MODE_KEY, MATRIX_POS_KEY, "o modo não pode partilhar a chave da posição");
  });
});

describe("gesto de encaixe — o centro do avatar decide", () => {
  test("centro dentro da barra é intenção de fixar", () => {
    assert.equal(isDockGesture({ x: 40, bottom: 100 }, FAB, SIDEBAR), true);
    assert.equal(isDockGesture({ x: SIDEBAR - FAB.w, bottom: 100 }, FAB, SIDEBAR), true);
  });

  test("encostar à barra sem o centro lá dentro não fixa", () => {
    assert.equal(isDockGesture({ x: SIDEBAR + 4, bottom: 100 }, FAB, SIDEBAR), false);
  });

  test("sem barra medida não há zona de encaixe", () => {
    assert.equal(isDockGesture({ x: 0, bottom: 100 }, FAB, 0), false);
  });

  test("o arrasto pode entrar na barra para fixar, mas largar fora dela volta a re-encaixar", () => {
    // Durante o gesto a barra não é parede: projectPointerDrag com sidebarWidth
    // 0 permite x dentro dela, que é o que torna o encaixe alcançável.
    const dentro = projectPointerDrag(
      { x: SIDEBAR + EDGE_INSET_PX, bottom: 200 },
      { x: 500, y: 300 },
      { x: 200, y: 300 },
      VP, FAB, 0, 0,
    );
    assert.ok(dentro.x < SIDEBAR, "o arrasto não conseguiu chegar à barra");

    // Largar fora: clampPos com a barra medida devolve-o para fora dela.
    const solto = clampPos(dentro, VP, FAB, 0, SIDEBAR);
    assert.ok(solto.x >= SIDEBAR + EDGE_INSET_PX, "ficou meio dentro da barra");
  });
});

describe("chat fixado — área principal, colado à barra e dentro do ecrã", () => {
  test("abre à direita da barra, nunca por cima dela", () => {
    const p = computeDockedChatPlacement(VP, SIDEBAR, 120);
    assert.ok(p, "sem colocação para uma janela normal");
    assert.equal(p.left, SIDEBAR + EDGE_INSET_PX);
    assert.ok(p.left >= SIDEBAR, "chat por cima da barra lateral");
    assert.ok(p.left + p.width <= VP.w - EDGE_INSET_PX, "chat sai pela direita");
    assert.ok(p.bottom >= EDGE_INSET_PX && p.bottom + p.height <= VP.h - EDGE_INSET_PX, "chat sai por cima ou por baixo");
    assert.ok(p.height > 0 && p.width > 0, "chat sem área");
  });

  test("quando a área principal não chega, devolve null (o chamador cai no painel ancorado)", () => {
    // 520 - 268 - 12 = 240 px livres: abaixo da largura mínima do painel.
    assert.equal(computeDockedChatPlacement({ w: 520, h: 700 }, SIDEBAR, 0), null);
    assert.equal(computeDockedChatPlacement(VP, 0, 0), null);
  });

  test("a altura acompanha a janela, sem sair do ecrã", () => {
    const baixa = computeDockedChatPlacement({ w: 1000, h: 360 }, 240, 0);
    assert.ok(baixa, "devia caber em largura");
    assert.ok(baixa.bottom + baixa.height <= 360 - EDGE_INSET_PX, "o painel passou do fundo");
  });
});

describe("minimizado — botão discreto na área útil", () => {
  test("fica fora da barra, encostado ao canto, dentro do ecrã", () => {
    const p = computeMinimizedPos(VP, { w: 40, h: 40 }, SIDEBAR);
    assert.ok(p.x >= SIDEBAR + EDGE_INSET_PX, "o botão minimizado invade a barra");
    assert.ok(p.x + 40 <= VP.w, "sai pela direita");
    assert.equal(p.bottom, EDGE_INSET_PX);
  });

  test("em janela pequena mantém-se dentro dos limites", () => {
    const p = computeMinimizedPos({ w: 300, h: 200 }, { w: 40, h: 40 }, SIDEBAR);
    assert.ok(p.x >= EDGE_INSET_PX && p.x + 40 <= 300, "saiu da janela pequena");
  });

  test("o modo fixado reserva altura na barra; o flutuante não reserva nada", () => {
    assert.ok(DOCK_SLOT_PX >= FAB.h, "a zona de encaixe é mais baixa do que o avatar");
    assert.ok(DOCK_SLOT_PX <= 96, "a zona de encaixe rouba espaço a mais à navegação");
  });
});

describe("ligações na interface — o modo chega ao componente e à barra", () => {
  const assistant = read("..", "src", "components", "AIAssistant.tsx");
  const sidebar = read("..", "src", "components", "Sidebar.tsx");

  test("a Sidebar expõe a zona de encaixe, com altura própria e fora do caminho", () => {
    assert.match(sidebar, /data-cs-matrix-dock=""/, "a barra lateral não tem zona de encaixe");
    assert.match(sidebar, /height: "var\(--matrix-dock-slot-h, 0px\)"/, "a zona não começa a 0 px");
    // A zona tem de estar ANTES do bloco de conta/estado para não os tapar.
    assert.ok(
      sidebar.indexOf("data-cs-matrix-dock") < sidebar.indexOf("data-cs-reserve=\"matrix\""),
      "a zona de encaixe ficou abaixo da conta — tapava-a",
    );
  });

  test("o launcher lê e grava o modo, e expõe-no no DOM", () => {
    assert.match(assistant, /parseStoredMode\(safeReadLauncherMode\(\)\)/, "o modo não é lido do armazenamento");
    assert.match(assistant, /localStorage\.setItem\(MATRIX_MODE_KEY, next\)/, "o modo não é persistido");
    assert.match(assistant, /data-matrix-mode=\{launcherMode\}/, "o modo não é observável no DOM");
    assert.match(assistant, /setProperty\("--matrix-dock-slot-h", launcherMode === "docked"/, "a barra não recebe a altura do encaixe");
  });

  test("há alternativa ao arrasto: menu com Fixar / Soltar / Minimizar", () => {
    assert.match(assistant, /aria-haspopup="menu"/, "o menu não é anunciado como menu");
    assert.match(assistant, /Fixar na sidebar/, "falta a ação de fixar no menu");
    assert.match(assistant, /Soltar na página/, "falta a ação de soltar no menu");
    assert.match(assistant, />\s*Minimizar\s*</, "falta a ação de minimizar no menu");
  });

  test("o arrasto marca a zona de encaixe e larga-a em modo fixado", () => {
    assert.match(assistant, /isDockGesture\(next, launcherSize, sidebarWidth\)/, "o arrasto não deteta a zona");
    assert.match(assistant, /if \(estavaSobreEncaixe\)/, "largar sobre a barra não fixa");
    assert.match(assistant, /persistLauncherMode\("docked"\)/, "o encaixe não é persistido");
    // O alvo visual é uma pista, não um alvo de clique.
    assert.match(assistant, /pointer-events-none fixed z-\[99\] rounded-xl border-2 border-dashed border-primary/, "o alvo de encaixe não é uma pista visual");
  });

  test("sem legendas permanentes e «Repor posição» só dentro do menu", () => {
    // P1 22/10: a bolha «Matrix AI / Pergunta-me algo» sobrepunha-se a gráficos
    // e cartões. O nome acessível do FAB já diz o mesmo a quem usa leitor.
    assert.equal(/>\s*Pergunta-me algo\s*</.test(assistant), false, "voltou a legenda por cima do conteúdo");
    assert.equal(/showLabel/.test(assistant), false, "sobrou estado de rótulo permanente");
    const reposicoes = (assistant.match(/Repor posição/g) ?? []).length;
    assert.equal(reposicoes, 1, "«Repor posição» tem de existir uma só vez, no menu");
    const menu = assistant.slice(assistant.indexOf('role="menu"'));
    assert.match(menu, /Repor posição/, "«Repor posição» saiu do menu de opções");
  });

  test("minimizado é um botão real, com nome acessível e restauro", () => {
    assert.match(assistant, /aria-label="Restaurar a Matrix"/, "o botão minimizado não tem nome");
    assert.match(assistant, /persistLauncherMode\("floating"\)/, "minimizar não pode ser um caminho sem volta");
    assert.match(assistant, /computeMinimizedPos\(viewport\(\), launcherSize, sidebarWidth\)/, "o botão minimizado não usa a geometria contida");
  });
});
