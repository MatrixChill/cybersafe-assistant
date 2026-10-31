import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GUARDA DE LAYOUT DO SHELL V2 (D2c).
 *
 * O que isto fixa é um defeito de produto que eu introduzi em D2a e que o runtime
 * mediu (corrida KQFMvJ): `.cs-v2` declarava `display: grid` com colunas
 * `220px + minmax(0,1fr)`, mas o root do `App.tsx` tem um único filho
 * (`cs-shell-frame`). Sem `grid-column`, esse filho foi colocado automaticamente
 * na segunda coluna — o main do Scanner ficou com 66 px de largura dentro de um
 * rect de 1530 px de altura, a x=246, e nenhum ponto da zona de largar estava
 * desobstruído. Não era o harness nem a navegação: era a camada de identidade a
 * activar um layout antes de existir marcação que o preencha.
 *
 * A invariant é a parelha: o grafo do shell só existe com a marcação do shell.
 * Sem essa parelha verificada, o mesmo erro volta com outro pretexto.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, "..", "src", ...parts), "utf8");
const shell = read("v2", "shell.css");
const semComentarios = shell.replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("App.tsx");
const sid = read("components", "Sidebar.tsx");

/** O conteúdo do bloco `.cs-v2 { … }` que não é composto com outro seletor. */
function blocoRaiz(css: string): string {
  const m = /\.cs-v2\s*\{([^}]*)\}/.exec(css);
  return m ? m[1] : "";
}

describe("grapho do shell V2 está condicionado à marcação", () => {
  test("o root nu `.cs-v2` não declara grid nem colunas", () => {
    const raiz = blocoRaiz(semComentarios);
    assert.ok(raiz.length > 0, "o bloco .cs-v2 desapareceu");
    assert.equal(/display:\s*grid/.test(raiz), false, "grid no root nu — foi exatamente o defeito do KQFMvJ");
    assert.equal(/grid-template-columns/.test(raiz), false, "colunas definidas no root nu");
    assert.equal(/grid-template-rows/.test(raiz), false, "linhas definidas no root nu");
  });

  test("o grafo vive em `.cs-v2.cs-v2-shell`", () => {
    assert.match(semComentarios, /\.cs-v2\.cs-v2-shell\s*\{[^}]*display:\s*grid/);
    /* Reancorado com a medição de kHSgRC: a pista fixa (`var(--v2-sidebar-width)`)
       era a segunda fonte da largura da sidebar e sobrepunha-se ao `width` inline do
       spring em 48 px. O grafo passa a ter UMA fonte — a pista mede a sidebar. */
    assert.match(semComentarios, /\.cs-v2\.cs-v2-shell\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
    assert.equal(/grid-template-columns:\s*var\(--v2-sidebar-width\)/.test(semComentarios), false, "voltou a haver duas fontes para a largura da sidebar");
  });

  test("não há seletores do shell sem consumidor", () => {
    // O repo já rejeita CSS dormente (`.liquid-panel`, `.glass-panel`); o shell V2
    // não pode chegar ao mesmo estado. `cs-shell-frame` deixou de existir no App em
    // D2b-ii, pelo que a sua regra de defesa tinha de morrer com ele. A proteção que
    // essa regra dava passa a estar onde é verificável: a ordem dos filhos do grafo
    // (teste acima) e uma única fonte para a largura da sidebar (kHSgRC mediu a
    // segunda fonte a sobrepor 48 px do conteúdo).
    assert.equal(semComentarios.includes('.cs-shell-frame {'), false, 'regra para um invólucro que já não existe');
    assert.equal(/\.collapsed/.test(semComentarios), false, 'regras de colapso por classe no root: o colapso da app é estado React + `data-collapsed`');
    assert.equal(semComentarios.includes('--v2-sidebar-width'), false, 'token de largura sem consumidor = segunda fonte');
    assert.equal(semComentarios.includes('.sidebar-bottom .collapse-button'), false, 'regra sem consumidor na app');
  });

  test("App.tsx não arma o grafo sem montar a marcação do shell", () => {
    const armaGrafo = /cs-v2-shell/.test(app);
    if (!armaGrafo) {
      // Estado atual: tokens, cor e tipografia aplicados; layout deixado como está.
      assert.match(app, /"cs-v2 titlebar-offset/, "o root deveria continuar a levar cs-v2");
      return;
    }
    // Quem armar o grafo tem de montar os dois filhos do grid, na ordem.
    // O `Sidebar` é um componente: o que se verifica é que ele é filho direto do
    // root (antes da coluna) e que o componente próprio leva a classe do shell.
    assert.match(app, /<Sidebar/, "cs-v2-shell sem <Sidebar /> no grafo");
    assert.match(sid, /"sidebar sidebar-surface/, "o aside não leva a classe do shell V2");
    assert.match(app, /main-shell/, "cs-v2-shell sem `.main-shell` no grafo");
    assert.ok(
      app.indexOf("sidebar") < app.indexOf("main-shell"),
      "sidebar tem de ser o primeiro filho do grafo (a segunda coluna é o conteúdo)",
    );
  });

  test("os filhos do grafo estão na ordem: faixa, sidebar, coluna de conteúdo", () => {
    // D2b-ii armou o grafo. O que matou o layout em KQFMvJ foi um filho único
    // sem `grid-column`; com três filhos diretos, a ordem é o que garante que a
    // faixa atravessa as duas colunas, a sidebar fica na primeira e a coluna de
    // conteúdo na segunda. Os overlays (backdrop, MATRIX, onboarding, avisos) são
    // `position: fixed` e por isso não disputam célula nenhuma.
    const faixa = app.indexOf("state-ribbon");
    const sidebar = app.indexOf("<Sidebar");
    const coluna = app.indexOf('className="main-shell');
    const backdrop = app.indexOf("cs-shell-backdrop");
    assert.ok(faixa > 0 && sidebar > faixa && coluna > sidebar, "ordem dos filhos do grafo alterada");
    assert.ok(backdrop > coluna, "o backdrop deixou de vir depois do conteúdo");
    assert.equal(app.includes("cs-shell-frame"), false, "o invólucro de V1 voltou e quebra o parelha grid+markup");
    assert.match(shell, /\.state-ribbon[\s\S]*?grid-column: 1 \/ -1/);
  });
});

describe("faixa V2 do conteúdo (D2b) liga estado real", () => {
  const menu = read("v2", "theme-menu.tsx");

  test("o seletor de tema é o eixo do contexto, não um estado próprio", () => {
    assert.match(menu, /useAppearance\(\)/);
    assert.match(menu, /value=\{prefs\.theme\}/);
    assert.match(menu, /setTheme\(event\.target\.value as V2Theme\)/);
    assert.match(menu, /V2_THEME_ORDER\.map/);
    assert.equal(/useState/.test(menu), false, "o menu não pode duplicar o estado do tema");
  });

  test("o App importa a peça, não os dados de identidade", () => {
    // Motivo medido em D2a: um import de `V2_THEME_META` no root rebentava o
    // render nos harness que correm AuthenticatedApp com mapa de módulos falseado.
    assert.match(app, /import \{ ThemeMenu \} from ".\/v2\/theme-menu"/);
    assert.equal(/from ".\/v2\/theme"/.test(app), false, "o root não deve importar dados de tema");
  });

  test("sino e avatar usam factos da sessão, sem número inventado", () => {
    const faixa = app.slice(app.indexOf('className="topbar"'), app.indexOf("cs-body"));
    assert.ok(faixa.length > 50, "a faixa do conteúdo desapareceu");
    assert.match(faixa, /toasts\.length/);
    // Rótulo medido no runtime de 28/10: `toasts` são avisos ACTIVOS desta
    // janela (auto-expiram). «Sem avisos desta sessão» ler-se-ia como histórico
    // total vazio, o que a app não afirma - a contagem do histórico vive em Ameaças.
    assert.match(faixa, /Sem avisos activos nesta janela/);
    assert.match(faixa, /avisos activos/);
    assert.equal(/Sem avisos desta sessão/.test(faixa), false, "rótulo do sino afirmava a sessão inteira");
    assert.match(faixa, /user\?\.name/);
    assert.match(faixa, /\{activePageTitle\}/, "as breadcrumbs têm de vir da rota ativa");
    assert.equal(/(3|5|12) avisa/.test(faixa), false, "contagem fixa na UI");
  });
});
