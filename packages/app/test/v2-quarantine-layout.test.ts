import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuarantinePage from "../src/pages/QuarantinePage";
import type { QuarantineEntry } from "@cybersafe/shared-types";

/**
 * TP-V2-QUARANTINE-Q2 · decisão A — qoder.
 *
 * O que este ficheiro trava, e porque é que a asserção é feita no FONTE e não
 * só no markup renderizado:
 *
 *  A região de detalhes só existe com `expanded === entry.id`, e `expanded` é
 *  estado interno — `renderToStaticMarkup` só vê o estado inicial, por isso um
 *  teste renderizado NUNCA veria a irmandade. O que se mede aqui é a árvore do
 *  próprio fonte: o `<div className="quarantine-row">` tem de FECHAR antes de
 *  `{expandido && (…`, e `id={idDetalhes}` não pode viver dentro da linha. É
 *  exatamente a decisão A («cada `li` invólucro contém uma linha flexível do
 *  lab e, como irmã dessa linha, a região expansível»), e é verificável sem
 *  browser. O efeito em pixels (flex com `wrap`, 900/1200/1600px) fica para o
 *  gate do integrador — não há run Electron nesta lane.
 *
 *  O resto é o que não pode ter mudado com a reestruturação: fita de aviso,
 *  portão de confirmação, os quatro desfechos V4, «Atualizar»/recuperação,
 *  chamadas IPC reais, `aria-controls`/`aria-expanded`/`role="region"` e a
 *  asserção de vacuidade só com leitura confirmada.
 */

(globalThis as Record<string, unknown>).React = React;

const ler = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const pagina = ler("../src/pages/QuarantinePage.tsx");
const folha = ler("../src/v2/quarantine/quarantine-v2.css");
const semComentario = folha.replace(/\/\*[\s\S]*?\*\//g, "");

const entrada = (overrides: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  id: "e1",
  originalPath: "C:\\temp\\ameaca.dll",
  quarantinePath: "C:\\quarantine\\e1",
  fileName: "ameaca.dll",
  sha256: "a".repeat(64),
  verdict: "malicious",
  riskScore: 90,
  quarantinedAt: "2026-10-27T10:00:00.000Z",
  ...overrides,
});

const render = (entries: QuarantineEntry[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(QuarantinePage, { entries, onChanged: () => {}, embedded: true, ...extra }),
  );

/** O bloco `<li>`-template, do `<li key={entry.id}` até ao `</li>` do map. */
function blocoDaEntrada(): { bloco: string; linhaAbre: number; linhaFecha: number } {
  const abre = pagina.indexOf("<li key={entry.id}");
  assert.ok(abre >= 0, "não se encontra o `<li>` da entrada");
  const bloco = pagina.slice(abre, pagina.indexOf("</li>", abre));

  const abreLinha = bloco.indexOf('<div className="quarantine-row">');
  assert.ok(abreLinha >= 0, "faltou a linha flexível do lab");
  // Contagem de profundidade sobre `<div` / `</div>`: sem parser, mas com as
  // duas únicas formas que existem neste bloco (ambas na mesma linha).
  let profundidade = 0;
  let fechaLinha = -1;
  const etiquetas = bloco.slice(abreLinha).matchAll(/<div\b|<\/div>/g);
  for (const m of etiquetas) {
    if (m[0] === "<div") profundidade += 1;
    else {
      profundidade -= 1;
      if (profundidade === 0) {
        fechaLinha = abreLinha + m.index;
        break;
      }
    }
  }
  assert.ok(fechaLinha >= 0, "a linha flexível nunca fecha no fonte");
  return { bloco, linhaAbre: abreLinha, linhaFecha: fechaLinha };
}

describe("Q2 decisão A — o `<li>` é invólucro, a linha é do lab", () => {
  test("a linha flexível contém mosaico, coluna de texto e acções", () => {
    const { bloco, linhaAbre, linhaFecha } = blocoDaEntrada();
    const linha = bloco.slice(linhaAbre, linhaFecha);
    assert.match(linha, /className=\{emCurso \? "icon-tile icon-tile--proc"/, "o mosaico vive na linha");
    assert.match(linha, /<div className="quarantine-col min-w-0 space-y-1\.5">/, "a coluna de texto é a do lab");
    assert.match(linha, /className="row-act flex shrink-0 flex-col items-end gap-1\.5"/, "as acções vivem na linha");
    assert.equal(linha.includes("id={idDetalhes}"), false, "a região de detalhes NÃO é filha da linha — é irmã");
  });

  test("detalhes, confirmação e «a comunicar» são irmãos da linha, no mesmo item", () => {
    const { bloco, linhaFecha } = blocoDaEntrada();
    for (const [nome, agulha] of [
      ["detalhes", "{expandido && ("],
      ["confirmação", "{aConfirmar && ("],
      ["curso", "{emCurso && ("],
    ] as const) {
      const i = bloco.indexOf(agulha);
      assert.ok(i >= 0, `faltou o bloco ${nome}`);
      assert.ok(i > linhaFecha, `${nome} aparece dentro da linha: a irmandade partiu-se`);
    }
    assert.equal(bloco.includes("col-span-full"), false, "o `col-span-full` da grelha de 3 colunas não volta");
  });

  test("mesma entrada e identidade: IDs, aria-controls, role e fita de aviso", () => {
    const { bloco } = blocoDaEntrada();
    assert.match(bloco, /id=\{idTitulo\} title=\{entry\.fileName\}/);
    assert.match(bloco, /aria-expanded=\{expandido\}/);
    assert.match(bloco, /aria-controls=\{idDetalhes\}/);
    assert.match(bloco, /id=\{idDetalhes\} role="region" aria-labelledby=\{idTitulo\} className="quarantine-details/);
    assert.match(pagina, /className=\{cn\("row-item quarantine-item", isolation\.warn && "border-l-2 border-l-cyber-yellow"\)\}/, "a fita de aviso continua no invólucro");
  });

  test("o estado inicial renderiza a linha do lab, uma por entrada, sem vazios falsos", () => {
    const html = render([entrada({ id: "a" }), entrada({ id: "b", fileName: "outra.dll", quarantinedAt: "2026-10-26T10:00:00.000Z" })], { estadoLeitura: "confirmado" });
    assert.equal((html.match(/class="row-item quarantine-item/g) ?? []).length, 2, "um invólucro por entrada");
    assert.equal((html.match(/class="quarantine-row"/g) ?? []).length, 2, "uma linha do lab por entrada");
    assert.equal((html.match(/row-item/g) ?? []).length, 2, "o primitivo da lista não se duplicou");
    assert.match(html, /class="quarantine-col min-w-0 space-y-1\.5"/);
    assert.equal(html.includes("quarantine-details"), false, "nada de região de detalhes sem pedido de expansão");
    assert.equal(html.includes("A quarentena está vazia"), false, "lista cheia nunca se afirma vazia");
  });
});

describe("Q2 — folha local", () => {
  test("o invólucro perde a grelha e a linha ganha o flex do lab", () => {
    assert.match(semComentario, /\.cs-v2 \.v2-quarantine \.row-item\.quarantine-item \{\s*display: block;\s*\}/, "sem isto, a primeira criança da linha ficava no rasto de 2.25rem do `.row-item`");
    assert.match(semComentario, /\.cs-v2 \.v2-quarantine \.quarantine-row \{[\s\S]{0,120}display: flex;\s*align-items: center;\s*flex-wrap: wrap;\s*gap: 18px;/);
    assert.match(semComentario, /\.quarantine-row \.quarantine-col \{\s*flex: 1 1 16rem;\s*\}/);
    assert.match(semComentario, /\.quarantine-row > \.icon-tile \{\s*flex: 0 0 auto;\s*\}/);
    assert.match(semComentario, /\.quarantine-row > \.row-act \{\s*flex: 0 0 auto;\s*\}/);
  });

  test("escala do lab preservada do Q1, chapa continua descendente", () => {
    assert.match(semComentario, /\.quarantine-row \.row-title \{\s*font-size: 13px;\s*\}/);
    assert.match(semComentario, /\.quarantine-row \.row-meta \{\s*font-size: 10px;\s*margin-top: 5px;\s*\}/);
    assert.match(semComentario, /\.cs-v2 \.v2-quarantine \.quarantine-row \.state-chip \{\s*margin-left: auto;\s*\}/, "descendente: a chapa também vive na coluna de texto, não só no fim da linha");
    assert.equal(/> \.state-chip/.test(semComentario), false, "o filho directo não volta");
  });

  test("classe do lab que NÃO é copiada, com a razão escrita na folha", () => {
    assert.equal(semComentario.includes(".quarantine-actions"), false, "grupo de ícones horizontal do lab não é a coluna de botões rotulados do produto");
    assert.match(folha, /\.quarantine-actions/ , "a justificação existe no comentário");
  });

  test("regras todas dentro do invólucro V2 da Quarentena, sem tinta inventada", () => {
    const seletores = [...semComentario.matchAll(/([^{}\s][^{}]*?)\s*\{/g)].map((m) => m[1].trim());
    assert.ok(seletores.length >= 8, `menos regras do que a composição exige: ${seletores.length}`);
    for (const s of seletores) assert.match(s, /^\.cs-v2 \.v2-quarantine/, `regra fora do invólucro: ${s}`);
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(semComentario), false, "cor literal na folha V2");
    assert.equal(/@import/.test(folha), false);
    assert.equal(pagina.includes("quarantine-v2.css"), false, "a ligação à cascata é delta proposto no main.tsx do integrador");
  });
});

describe("Q2 — o que a reestruturação não tinha direito de tocar", () => {
  test("quatro desfechos V4, banda, Atualizar, recuperação e IPC", () => {
    for (const tipo of ["confirmada", "aviso", "recusada", "sem_confirmacao"]) {
      assert.ok(pagina.includes(tipo), `faltou o desfecho ${tipo}`);
    }
    assert.match(pagina, /export const QUARENTENA_ATUALIZAR = "Atualizar"/);
    assert.match(pagina, /aria-label=\{QUARENTENA_ATUALIZAR_ARIA\}/);
    assert.match(pagina, /aria-live=\{PAPEL_BANDEIRA\[bandeira\.tipo\] === "alert" \? "assertive" : "polite"\}/);
    assert.match(pagina, /await api\.restoreQuarantine\(entry\.id\)/);
    assert.match(pagina, /await api\.deleteQuarantine\(entry\.id\)/);
    assert.match(pagina, /setBandeira\(decideBandeira\(entry, decideResultadoAcao\(result\)\)\)/);
    assert.match(pagina, /decideRecuperacao\(anterior, estadoLeitura\)/);
    assert.match(pagina, /lista\.afirmaVazia/, "vacuidade só se afirma com leitura confirmada");
    assert.match(pagina, /setPending\(\{ id: entry\.id, action: "restore" \}\)/);
    assert.match(pagina, /if \(!api\) \{/, "ausência de serviço continua a ser desfecho, não exceção");
  });

  test("nada de material do laboratório nem estado inventado", () => {
    const html = render([entrada()], { estadoLeitura: "confirmado" });
    for (const demo of ["demo", "fictíci", "simula", "Repor cenário", "amostra", "/ 4 motores"]) {
      assert.equal(html.toLowerCase().includes(demo.toLowerCase()), false, `markup: ${demo}`);
      assert.equal(pagina.toLowerCase().includes(demo.toLowerCase()), false, `fonte: ${demo}`);
    }
    assert.equal(html.includes("Nenhuma entrada corresponde"), false, "filtro não foi adicionado nesta entrega — nada de UI que filtre o que não existe");
  });
});
