import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Guardas do restauro partilhado do scroll entre rotas.
 *
 * O contentor que faz scroll e o `<main>` (overflow-y-auto) do App; nao ha
 * React Router nem window-scroll. A ancora de reset tem de estar atrelada a
 * MONTAGEM do elemento da pagina (key={page}) com identidade estavel, para:
 *   · Gestor de Tarefas -> Monitor de Rede -> Definicoes começarem no topo;
 *   · um refresh da MESMA rota (poling, busca) nao perder a posicao.
 *
 * (O jsdom nao modela layout nem scroll real: aqui verifica-se o fio
 * estrutural, exatamente como os testes que leem o App.tsx fonte.)
 */

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("o scroller provado e o <main>, e esta ligado ao ref do scroll", () => {
  assert.match(
    appSource,
    /<main\s+ref=\{mainScrollRef\}[\s\S]{0,120}overflow-y-auto/,
    "o <main> com overflow-y-auto tem de carregar o ref que o reset escreve",
  );
});

test("o reset escreve scrollTop no contentor, nao no window", () => {
  assert.match(appSource, /mainScrollRef\.current\.scrollTop\s*=\s*0/);
  assert.doesNotMatch(
    appSource,
    /window\.(scrollTo|scrollBy|pageYOffset)/,
    "window nao e o scroller: um window.scrollTo seria o reset errado",
  );
});

test("a ancora dispara na montagem da pagina nova (key={page}), nao ao render", () => {
  const keyedBlock = appSource.match(/<motion\.div\s+key=\{page\}[\s\S]{0,200}/);
  assert.ok(keyedBlock, "a pagina tem de continuar montada no motion.div key={page}");
  assert.match(
    keyedBlock[0],
    /ref=\{anchorNewPageAtTop\}/,
    "o reset tem de estar no elemento que muda de identidade com a rota",
  );
});

test("a identidade da ancora e estavel (useCallback [])", () => {
  // Um ref recreated a cada render e desanexado/reanexado em cada commit:
  // o reset dispararia tambem nos refreshes da mesma rota — o bug inverso.
  assert.match(
    appSource,
    /const anchorNewPageAtTop = useCallback\([\s\S]{0,250}scrollTop\s*=\s*0[\s\S]{0,120}\}, \[\]\);/,
    "a ancora tem de ser um useCallback com dependencias vazias",
  );
  // E so age em montagens (node nao-nulo), nunca no desmontar da pagina que sai.
  assert.match(appSource, /if \(node && mainScrollRef\.current\)/);
});
