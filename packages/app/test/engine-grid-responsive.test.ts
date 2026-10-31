import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineGrid, MOTORES_PAINEL, SEM_LEITURA } from "../src/components/visual/EngineGrid";

/**
 * TP-PAP-V2-ENGINEGRID-RESPONSIVE-20261027 (Qoder)
 *
 * Defeito medido na captura Electron do Codex (página a 1200 px): o segundo
 * cartão dizia «Base de assinatu…» — o rótulo ia truncado porque o nome era o
 * único item da linha que podia ceder (`truncate`) enquanto o badge de estado
 * era `shrink-0`. Um cartão ATIVO sem nome legível é o motor ativo sem dono.
 *
 * Este ficheiro prende três coisas:
 *  1. o markup real (React 19 + `renderToStaticMarkup`, sem jsdom nem deps novas);
 *  2. o bloco CSS do componente em `src/index.css` (min-width e quebra), porque
 *     a causa não era só do TSX — um item de grelha com `min-width: auto`
 *     recusa-se a caber na pista;
 *  3. o que NÃO pode ter mudado: os quatro nomes, as tintas dos estados do
 *     contrato, a fail-closed da conexão e as frases de cobertura.
 *
 * Não prova: pixels no Electron, DPI, nem o `prefers-reduced-motion` em
 * movimento — isso é a observação manual do integrador.
 */

(globalThis as Record<string, unknown>).React = React;

const fonte = readFileSync(new URL("../src/components/visual/EngineGrid.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

const motor = (status: string, coverage?: string) => ({ status, ...(coverage ? { coverage } : {}) });
const relatorio = {
  yara: motor("degraded", "limited"),
  hashDb: motor("active"),
  clamav: motor("degraded"),
  nativeEngine: motor("degraded"),
} as never;

const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(EngineGrid, props));
const comLigacao = () => render({ engine: relatorio, conexao: true });

describe("TP ENGINE GRID RESPONSIVE — o nome do motor nunca é cortado", () => {
  test("os quatro nomes saem por extenso no markup", () => {
    const html = comLigacao();
    for (const { nome } of MOTORES_PAINEL) {
      assert.ok(html.includes(`>${nome}</span>`), `nome truncado ou ausente: ${nome}`);
    }
    assert.doesNotMatch(html, /Base de assinatur\w*\u2026/, "o rótulo voltou a ser partido com elipse");
  });

  test("o cartão YARA não afirma uma identidade de motor que o contrato não dá", () => {
    // TP-PAP-UI-YARA-IDENTITY: o serviço corre YARA clássico 4.6.0. «YARA-X» era
    // identidade falsa a partir do próximo arranque; «YARA» é o nome genérico
    // verdadeiro para os dois, sem campo novo no contrato.
    const html = comLigacao();
    assert.match(html, />YARA</, "o rótulo genérico não chegou ao markup");
    assert.doesNotMatch(html, /YARA-X/, "YARA-X voltou ao cartão");
    assert.equal(MOTORES_PAINEL.find((m) => m.chave === "yara")?.nome, "YARA");
  });

  test("nenuma utilidade de truncamento sobra no cabeçalho", () => {
    const html = comLigacao();
    assert.doesNotMatch(html, /truncate|text-ellipsis|overflow-hidden[^"]*"[^>]*data-engine/, "truncamento de volta ao nome");
    assert.doesNotMatch(fonte, /\btruncate\b/, "a classe `truncate` voltou ao componente");
  });

  test("o nome pode encolher e quebrar; o estado não pode ser comprimido", () => {
    const html = comLigacao();
    const nome = html.match(/<span class="([^"]*cs-engine-nome[^"]*)"/)?.[1] ?? "";
    assert.ok(nome, "faltava a classe própria do nome");
    for (const precisa of ["min-w-0", "flex-1", "basis-24", "leading-tight"]) {
      assert.ok(nome.split(/\s+/).includes(precisa), `nome sem ${precisa}: ${nome}`);
    }
    const estado = html.match(/<span class="([^"]*cs-engine-state[^"]*)"/)?.[1] ?? "";
    assert.ok(estado.includes("shrink-0") && estado.includes("whitespace-nowrap"), `estado comprimível: ${estado}`);
  });

  test("o cabeçalho é uma linha que pode quebrar", () => {
    const html = comLigacao();
    const cab = html.match(/<div class="(cs-engine-head[^"]*)"/)?.[1] ?? "";
    assert.ok(cab.includes("flex-wrap") && cab.includes("items-start"), `cabeçalho sem flex-wrap/items-start: ${cab}`);
  });
});

describe("TP ENGINE GRID RESPONSIVE — a causa também era do CSS", () => {
  test("o cartão pode encolher até à pista da grelha", () => {
    const bloco = css.slice(css.indexOf(".cs-engine-card {"), css.indexOf(".dashboard-page .cs-engine-card"));
    assert.match(bloco, /min-width:\s*0;/, "sem `min-width: 0` um item de grelha não cede");
  });

  test("a quebra é ao limite da palavra, não a meio", () => {
    const regra = css.slice(css.indexOf(".cs-engine-nome {"));
    assert.match(regra.slice(0, 200), /overflow-wrap:\s*break-word;/);
    assert.doesNotMatch(regra.slice(0, 200), /overflow-wrap:\s*anywhere|word-break:\s*break-all/, "partir «assinaturas» ao meio é o mesmo defeito");
  });

  test("as tintas dos cinco estados continuam declaradas", () => {
    for (const estado of ["active", "degraded", "error", "unavailable", "sem-leitura"]) {
      assert.match(css, new RegExp(`\\.cs-engine-state\\[data-state="${estado}"\\]`), `falta a tinta de ${estado}`);
    }
    for (const estado of ["active", "degraded", "error", "unavailable", "sem-leitura"]) {
      assert.match(css, new RegExp(`\\.cs-engine-card\\[data-state="${estado}"\\]`), `falta a borda de estado de ${estado}`);
    }
  });

  test("os fallbacks de decoração e contraste forçado sobrevivem ao patch", () => {
    assert.match(css, /@supports not \(color: color-mix/);
    const blocos = css.split("@media (forced-colors: active) {").slice(1);
    assert.ok(blocos.length > 0, "não havia nenhum bloco forced-colors");
    assert.ok(
      blocos.some((b) => b.slice(0, 900).includes(".cs-engine-card")),
      "o bloco forced-colors do cartão de motor desapareceu",
    );
  });

  test("a decisão de layout da grelha não foi tocada", () => {
    const html = comLigacao();
    assert.match(html, /class="grid grid-cols-2 items-stretch gap-2 lg:grid-cols-4"/);
  });
});

describe("TP ENGINE GRID RESPONSIVE — semântica de conexão e cobertura intacta", () => {
  test("sem conexão confirmada nada aparece ativo", () => {
    for (const conexao of [false, null, undefined]) {
      const html = render({ engine: relatorio, conexao });
      assert.match(html, new RegExp(`data-conexao="${conexao === false ? "desligada" : "nao-confirmada"}"`));
      assert.doesNotMatch(html, /data-state="active"/, "estado do relatório mostrado sem ligação");
      assert.ok(html.includes(SEM_LEITURA));
    }
  });

  test("as duas legendas de proveniência distinguem-se", () => {
    assert.match(render({ engine: relatorio, conexao: false }), /Serviço desligado: os cartões abaixo não são uma leitura atual/);
    assert.match(render({ engine: relatorio, conexao: null }), /Ligação ao serviço não confirmada/);
    assert.match(comLigacao(), /Ligação confirmada[\s\S]{0,200}idade não é afirmada/);
  });

  test("cobertura: ausente nunca vira normal", () => {
    assert.match(comLigacao(), /Cobertura limitada/);
    assert.match(comLigacao(), /Cobertura não comunicada por este serviço/);
    const normalComMotorVivo = render({
      engine: { yara: motor("active", "normal"), hashDb: motor("active", "normal"), clamav: motor("degraded", "normal"), nativeEngine: motor("active", "unknown") } as never,
      conexao: true,
    });
    assert.match(normalComMotorVivo, /Cobertura comunicada como normal pelo serviço/);
    assert.match(normalComMotorVivo, /Cobertura não verificada/, "normal com motor não-ativo tem de descer a não verificada");
  });

  test("estado fora do contrato não é interpretado", () => {
    const html = render({
      engine: { yara: motor("a-induzir-em-breve"), hashDb: motor("active"), clamav: motor("active"), nativeEngine: motor("active") } as never,
      conexao: true,
    });
    assert.match(html, /Estado fora do contrato — não interpretado\./);
    assert.match(html, /data-state="a-induzir-em-breve"/, "o valor tem de chegar ao DOM, não ser substituído");
  });

  test("quatro cartões, sempre, com as chaves do contrato", () => {
    const html = comLigacao();
    for (const chave of ["yara", "hashDb", "clamav", "nativeEngine"]) {
      assert.ok(html.includes(`data-engine="${chave}"`), `faltava o cartão ${chave}`);
    }
    assert.equal((html.match(/data-engine="/g) ?? []).length, 4);
  });
});
