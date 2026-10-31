import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScanHistoryPanel } from "../src/components/ScanHistoryPanel";

/**
 * TP-V2-HISTORY · H1 — qoder.
 *
 * Anatomia de tabela do laboratório (`SecurityPages.tsx:638 History()` +
 * `styles.css:1350-1400`) sobre os contratos reais do histórico, sem tocar no
 * controlador: `decidePaginaHistorico`, cursor, notas de leitura/null/erro e o
 * PDF por registo continuam os mesmos.
 *
 * O que isto trava:
 *  1. a linha do lab tem 6 colunas com NOME do contrato (Análise/Data/Ficheiros/
 *     Duração/Resultado/Detalhe) e a região expansível é uma linha IRMÃ
 *     (`<tr class="history-detalhe">` com `<td colSpan>`), não uma coluna dentro;
 *  2. a semântica de tabela sobrevive à camada V2: nenhuma regra muda o
 *     `display` de um `td`/`th` (mudar o display de uma célula faz o leitor de
 *     ecrã perder linha/célula — Chrome/Safari);
 *  3. nada é afirmado antes de resposta: sem leitura, não há linha nem chapa;
 *  4. os dados largos (seis contadores, escopo, dois botões) não são cortados
 *     pelo `white-space: nowrap` do lab — o desvio está na folha, declarado.
 */

(globalThis as Record<string, unknown>).React = React;

const ler = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const fonte = ler("../src/components/ScanHistoryPanel.tsx");
// O comentário diz explicitamente que o filtro do lab NÃO entra; procurar a
// palavra no fonte inteiro era apanhar a própria justificação (o erro que a
// revisão de 28/10 já tinha apanhado no `radio-dot` do Scanner).
const codigo = fonte.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
const folha = ler("../src/v2/history/history-v2.css");
const semComentario = folha.replace(/\/\*[\s\S]*?\*\//g, "");

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ScanHistoryPanel as never, props as never));

describe("Histórico H1 — tabela do lab com colunas do contrato", () => {
  test("as seis colunas do lab, com escopo de cabeçalho", () => {
    assert.match(fonte, /<div className="table-scroll">/);
    assert.match(fonte, /<table className="history-table">/);
    for (const col of ["Análise", "Data", "Ficheiros", "Duração", "Resultado"]) {
      assert.ok(fonte.includes(`<th scope="col">${col}</th>`), `faltou a coluna ${col}`);
    }
    assert.match(fonte, /<span className="sr-only">Detalhe<\/span>/);
    assert.match(fonte, /<caption className="sr-only">/);
  });

  test("uma linha por registo, chave no Fragment, estado no data-estado", () => {
    assert.match(fonte, /<Fragment key=\{e\.id\}>/);
    assert.match(fonte, /<tr className="history-row" data-estado=\{e\.status\} data-parcial=\{resultado\.partial \? "true" : "false"\}>/);
    assert.match(fonte, /<th scope="row" className="history-col-analise">/);
    assert.equal(fonte.includes("<article key={e.id}"), false, "o `<article>` da lista não volta misturado com a tabela");
    assert.equal(/<div className="row-list">/.test(fonte), false, "a lista anterior não coexiste com a tabela");
  });

  test("detalhe é linha irmã, com colSpan — não coluna dentro da linha", () => {
    const fechaLinhaDados = fonte.indexOf("</tr>");
    const detalhe = fonte.indexOf('<tr className="history-detalhe">');
    assert.ok(detalhe > fonte.indexOf('<tr className="history-row"'), "a linha de detalhe vem depois da linha de dados");
    assert.ok(detalhe > fechaLinhaDados, "o bloco de detalhe aparece dentro da linha");
    assert.match(fonte, /<td colSpan=\{6\}>/);
    assert.equal(/<tr className="history-detalhe">[\s\S]{0,90}<td colSpan=\{6\}>/.test(fonte), true, "a linha irmã abre com a célula de 6 colunas");
    assert.ok(fonte.includes("{expandido && ("), "o detalhe continua condicionado à expansão");
  });

  test("render: sem resposta do serviço não há tabela, linhas nem chapas", () => {
    // `entradas` vive em estado interno alimentado por `getScanHistory` dentro
    // de um efeito, e `renderToStaticMarkup` não corre efeitos: o que aqui se
    // pode provar é a recusa — a anatomia nova não desenha estrutura antes de o
    // serviço ter confirmado uma página.
    const vazio = render({});
    assert.equal(vazio.includes("<table"), false, "sem página lida não há tabela");
    assert.equal(vazio.includes("history-row"), false, "sem página lida não há linhas");
    assert.equal(vazio.includes("state-chip"), false, "sem dados não há chapas de estado");
    assert.equal(vazio.includes("considerados"), false, "sem dados não há contadores");
    assert.match(vazio, /v2-history/, "a âncora existe, mas vazia é só casca");
  });

  test("null, vazio e erro continuam a ser três coisas diferentes", () => {
    assert.match(fonte, /export function decidePaginaHistorico/);
    assert.ok(fonte.includes("HISTORICO_SEM_CONFIRMACAO_NOTE"), "o «sem confirmação» mantém-se");
    assert.ok(fonte.includes("HISTORICO_ULTIMA_LEITURA_NOTE"), "a rotulagem de leitura antiga mantém-se");
    assert.match(fonte, /O histórico não pôde ser lido/);
    assert.match(fonte, /\{cursor !== null && \(/, "o cursor do serviço manda no «Carregar mais»");
    assert.match(fonte, /\{aCarregarMais \? "A carregar…" : "Carregar mais"\}/);
  });

  test("acessibilidade e acções intactas: expanded, rótulo por data, PDF gated", () => {
    assert.match(fonte, /aria-expanded=\{expandido\}/);
    assert.match(fonte, /aria-label=\{`\$\{expandido \? "Ocultar" : "Ver"\} detalhes da análise de \$\{dataHora\(e\.startedAt\)\}`\}/);
    assert.match(fonte, /aria-label=\{`Exportar PDF da análise de \$\{dataHora\(e\.startedAt\)\}`\}/);
    assert.match(fonte, /disabled=\{!expandido \|\| estado\.tipo === "a_guardar"\}/, "o PDF continua a exigir registo aberto e não duplica o pedido");
    assert.match(fonte, /aria-labelledby="historico-titulo"/);
    assert.match(fonte, /className="v2-history cyber-border rounded-xl p-5 space-y-4"/, "âncora V2 na casca, sem trocar a casca");
  });

  test("nada de material de demonstração do lab, nem filtro inventado", () => {
    for (const demo of ["fictíci", "demo", "2 / 4", "Repor cenário"]) {
      assert.equal(fonte.toLowerCase().includes(demo.toLowerCase()), false, `entrou material do lab: ${demo}`);
    }
    // O lab usa um `.segmented` de filtro por estado. Não é copiado nesta
    // entrega, e o motivo é do contrato: a paginação é do serviço, por isso
    // filtrar só a página já carregada diria «concluídas» sobre um subconjunto
    // que ninguém contou. Sem parâmetro de filtro no IPC, não há filtro honesto
    // para oferecer — e o IPC é read-only nesta lane.
    assert.equal(codigo.includes("segmented"), false, "filtro de página não entra");
    assert.equal(codigo.includes("aria-pressed"), false, "nem a sua semântica de seleção");
    assert.equal(/className="[^"]*segmented/.test(codigo), false, "a classe do filtro do lab não volta");
  });
});

describe("Histórico H2 — toolbar e vacuidade com a anatomia do lab", () => {
  test("a contagem diz o que existe: registos carregados, nunca total nem página", () => {
    assert.match(
      fonte,
      /<div className="table-toolbar">\s*<span className="caption">/,
      "toolbar do lab (styles.css:1350-1356) acima da tabela",
    );
    assert.match(fonte, /\{entradas\.length\} \{entradas\.length === 1 \? "registo carregado" : "registos carregados"\}/);
    assert.match(fonte, /\{cursor !== null \? " · o serviço indicou mais registos" : ""\}/, "o cursor do serviço é dito, não escondido");
    for (const mentira of ["desta página", "no total", "registos totais", "totalCount"]) {
      assert.equal(fonte.includes(mentira), false, `a contagem afirmaria mais do que sabe: ${mentira}`);
    }
    // «Carregar mais» acumula em `entradas`; chamar-lhe «total» ou «desta página»
    // seria mentira nas duas direções.
    assert.match(fonte, /setEntradas\(\(atual\) => \[\.\.\.atual, \.\.\.decisao\.entradas\]\)/);
  });

  test("vacuidade só se afirma com leitura confirmada, e usa `.empty` do lab", () => {
    assert.match(
      fonte,
      /\{fase === "pronto" && total === 0 && \(\s*<div className="empty" role="status">/,
      "o `<div class=empty role=status>` do lab (styles.css:2389-2399) só aparece em `pronto`",
    );
    assert.match(fonte, /<h2>Ainda não há análises registadas<\/h2>/);
    assert.ok(
      fonte.includes("O serviço respondeu à consulta e não devolveu nenhuma análise terminada"),
      "a frase de verdade foi preservada palavra a palavra, não reescrita",
    );
    assert.match(fonte, /\{registoDoTerminalEmFalta \? \(\s*<p>\{notaRegistoPendente\}<\/p>/, "registo pendente não se apresenta como ausência");
    assert.equal(/fase === "a_ler"[\s\S]{0,120}empty/.test(fonte), false, "a ler nunca desenha vacuidade");
    assert.equal(fonte.includes('className="empty"') && fonte.match(/className="empty"/g)?.length, 1, "uma só asserção de vazio");
  });

  test("os três primitivos do lab já existem em primitives.css — nada de regra concorrente", () => {
    const primitivos = ler("../src/v2/primitives.css");
    for (const [nome, métrica] of [
      [".cs-v2 .empty", "padding: 40px"],
      [".cs-v2 .caption", "font-size: 10px"],
      [".cs-v2 .table-toolbar", "margin-bottom: 19px"],
    ] as const) {
      const i = primitivos.indexOf(nome + " {");
      assert.ok(i >= 0, `faltou o primitivo ${nome}`);
      assert.ok(primitivos.slice(i, i + 220).includes(métrica), `${nome} não tem a métrica do lab (${métrica})`);
    }
    for (const nome of [".empty", ".caption", ".table-toolbar"]) {
      assert.equal(semComentario.includes(nome), false, `a folha do Histórico redeclara ${nome} — duas fontes para a mesma métrica`);
    }
  });

  test("densidade da coluna de acções: o caminho do PDF diz-se uma vez, na linha de detalhe", () => {
    // O review do H1 mediu transbordo interno da tabela (scroll 995 px contra
    // 694/872 do contentor em 900/1200 px) com as acções fora do recorte. Um dos
    // blocos que punha a coluna larga era o caminho absoluto repetido: ele já
    // vive na linha de detalhe (`PDF guardado em: …`). Não se declara «sem
    // overflow» — o que aqui se trava é a duplicação e a largura morta.
    assert.equal(codigo.includes("Download"), false, "o ícone e o texto do caminho saíram da coluna de acções");
    assert.equal((fonte.match(/PDF guardado em: \{estado\.caminho\}/g) ?? []).length, 1, "o caminho guardado aparece exatamente uma vez");
    assert.match(fonte, /disabled=\{!expandido \|\| estado\.tipo === "a_guardar"\}/, "o PDF continua gated pela expansão");
  });
});

describe("Histórico H1 — folha local", () => {
  test("métricas do lab transcritas, tokens do tema", () => {
    assert.match(semComentario, /\.cs-v2 \.v2-history \.table-scroll \{\s*overflow-x: auto;\s*\}/);
    assert.match(semComentario, /border-collapse: collapse;[\s\S]{0,80}font-size: 11px;/);
    assert.match(semComentario, /th\[scope="col"\] \{[\s\S]{0,240}font-size: 9px;[\s\S]{0,120}padding: 13px 12px;/);
    assert.match(semComentario, /\.history-table td \{\s*padding: 18px 12px;/);
    assert.match(semComentario, /font-family: var\(--v2-font-data\)/);
  });

  test("NENHUMA regra muda o display de uma célula — a tabela tem de continuar tabela", () => {
    const regras = [...semComentario.matchAll(/([^{}]*?)\{([^}]*)\}/g)];
    assert.ok(regras.length >= 10, `esperava regras de célula, vi ${regras.length}`);
    let vistas = 0;
    for (const [, sel, corpo] of regras) {
      const ultimo = sel.trim().split(/[\s>]+/).pop() ?? "";
      const heCelula = /^(td|th)\b/.test(ultimo);
      if (!heCelula) continue;
      vistas += 1;
      assert.equal(/display:\s*(flex|grid|block|inline-flex)/.test(corpo), false, `display alterado numa célula: ${sel.trim()}`);
    }
    assert.ok(vistas >= 3, `menos células vigiadas do que a tabela tem: ${vistas}`);
    assert.match(semComentario, /\.history-col-analise > span \{\s*display: inline-grid;/, "o alinhamento é feito DENTRO da célula");
  });

  test("desvio do nowrap declarado e aplicado só onde há dados largos", () => {
    assert.match(semComentario, /\.history-table \{[\s\S]{0,120}white-space: nowrap;/);
    assert.match(semComentario, /\.history-col-analise,\s*\.cs-v2 \.v2-history \.history-table td\.mono,\s*\.cs-v2 \.v2-history \.history-col-acoes \{\s*white-space: normal;\s*\}/);
  });

  test("tudo dentro do invólucro V2 do Histórico, sem cor literal, sem import", () => {
    const seletores = [...semComentario.matchAll(/([^{}\s][^{}]*?)\s*\{/g)].map((m) => m[1].trim());
    assert.ok(seletores.length >= 10, `menos regras do que a tabela exige: ${seletores.length}`);
    for (const s of seletores) assert.match(s, /^\.cs-v2 \.v2-history/, `regra fora do invólucro: ${s}`);
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(semComentario), false, "cor literal na folha V2");
    assert.equal(/@import/.test(folha), false);
    assert.equal(fonte.includes("history-v2.css"), false, "a ligação à cascata é delta proposto no main.tsx do integrador");
  });
});
