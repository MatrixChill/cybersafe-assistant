import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuarantineEntry } from "@cybersafe/shared-types";
import QuarantinePage, {
  decideEstadoLista,
  QUARENTENA_FALHA_NOTE,
  QUARENTENA_LER_NOTE,
  QUARENTENA_SEM_CONFIRMACAO_NOTE,
  QUARENTENA_TENTAR_NOVAMENTE,
  type EstadoLeituraQuarentena,
} from "../src/pages/QuarantinePage";

/**
 * UI-D3 (TP-PAP-UI-FUNCTIONAL-20261028, Qoder) — «vazio» é uma asserção sobre o
 * contentor, e só pode sair de uma leitura confirmada.
 *
 * O defeito real: `App.tsx` só publica a lista no sucesso do `getQuarantineFiles`
 * (App.tsx:403 na base desta lane). Uma rejeição deixa `quarantine` em `[]`
 * (App.tsx:197) e a página dizia «A quarentena está vazia». Ao arrancar, antes
 * do primeiro snapshot, era a mesma mentira.
 *
 * Métodos: verdade do puro `decideEstadoLista` + render REAL (react-dom/server)
 * de cada estado. Não simula cliques; o botão de repetir é verificado no markup
 * e a sua ligação ao `onChanged` é verificada no fonte (estrutural, declarado).
 */

(globalThis as Record<string, unknown>).React = React;

const fontePagina = readFileSync(new URL("../src/pages/QuarantinePage.tsx", import.meta.url), "utf8");

const entrada = (overrides: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  id: "e1",
  originalPath: "C:\\temp\\ameaca.dll",
  quarantinePath: "C:\\quarantine\\e1",
  fileName: "ameaca.dll",
  sha256: "a".repeat(64),
  verdict: "malicious",
  riskScore: 90,
  quarantinedAt: "2026-10-27T10:00:00.000Z",
  isolationStatus: "confirmed",
  ...overrides,
});

function renderiza(props: Partial<React.ComponentProps<typeof QuarantinePage>>): string {
  return renderToStaticMarkup(
    createElement(QuarantinePage, {
      entries: [],
      onChanged: () => {},
      ...props,
    }),
  );
}

describe("decideEstadoLista — o que cada leitura autoriza a dizer", () => {
  test("sem leitura confirmada nunca se afirma vacuidade", () => {
    for (const estado of ["a_ler", "falhou"] satisfies EstadoLeituraQuarentena[]) {
      const decisao = decideEstadoLista(estado, 0);
      assert.equal(decisao.afirmaVazia, false, `${estado} não pode dizer «vazia»`);
      assert.ok(decisao.banner, `${estado} tem de mostrar o que se passou`);
    }
  });

  test("leitura confirmada mantém a asserção de vacuidade", () => {
    assert.equal(decideEstadoLista("confirmado", 0).afirmaVazia, true);
    assert.equal(decideEstadoLista("confirmado", 3).afirmaVazia, false);
  });

  test("a omissão do prop preserva o comportamento histórico", () => {
    const semProp = decideEstadoLista(undefined, 0);
    assert.equal(semProp.afirmaVazia, true, "sem sinal, a lista que chega é tratada como confirmada");
    assert.equal(semProp.banner, null);
  });

  test("com entradas em ecrã, a lista é rotulada como última leitura confirmada", () => {
    for (const estado of ["a_ler", "falhou"] satisfies EstadoLeituraQuarentena[]) {
      const decisao = decideEstadoLista(estado, 2);
      assert.equal(decisao.afirmaVazia, false);
      assert.match(decisao.rotuloLista ?? "", /Última leitura confirmada/, `${estado} rotula as linhas`);
    }
    assert.equal(decideEstadoLista("confirmado", 2).rotuloLista, null, "confirmado não pede rótulo");
  });
});

describe("Quarentena renderizada — cada estado da leitura", () => {
  test("falhou com lista vazia: diz a falha, não diz «vazia»", () => {
    const html = renderiza({ estadoLeitura: "falhou", entries: [] });
    assert.ok(html.includes(QUARENTENA_FALHA_NOTE), "mostra a razão");
    assert.ok(!html.includes("A quarentena está vazia"), "nunca afirma vacuidade sem leitura");
    assert.match(html, /role="alert"/, "é um alerta, não estatística");
    assert.ok(html.includes(QUARENTENA_TENTAR_NOVAMENTE), "oferece repetir a leitura");
  });

  test("a_ler com lista vazia: diz que está a consultar, não diz «vazia»", () => {
    const html = renderiza({ estadoLeitura: "a_ler", entries: [] });
    assert.ok(html.includes(QUARENTENA_LER_NOTE));
    assert.ok(!html.includes("A quarentena está vazia"));
    assert.ok(!html.includes(QUARENTENA_TENTAR_NOVAMENTE), "uma leitura em curso não se repete");
  });

  test("confirmado com lista vazia: continua a dizer «vazia»", () => {
    const html = renderiza({ estadoLeitura: "confirmado", entries: [] });
    assert.match(html, /A quarentena está vazia\./);
    assert.ok(!html.includes(QUARENTENA_FALHA_NOTE));
  });

  test("sem o prop (compatibilidade): render de hoje intacto", () => {
    assert.match(renderiza({}), /A quarentena está vazia\./);
    assert.match(renderiza({ entries: [entrada()] }), /ameaca\.dll/);
  });

  test("falhou com entradas: mantém a lista e rotula a proveniência", () => {
    const html = renderiza({ estadoLeitura: "falhou", entries: [entrada()] });
    assert.match(html, /ameaca\.dll/, "as linhas lidas não desaparecem");
    assert.ok(html.includes(QUARENTENA_FALHA_NOTE));
    assert.match(html, /Última leitura confirmada — esta consulta não respondeu\./);
    assert.ok(!html.includes("A quarentena está vazia"));
  });
});

describe("verificação estrutural (não simula eventos)", () => {
  test("a recarga chama o recarregamento que o contentor já possui", () => {
    // V4: um só botão, no cabeçalho, com o rótulo do que se pode fazer agora.
    assert.match(fontePagina, /onClick=\{\(\) => void recarregar\(\)\}/);
    const abre = fontePagina.indexOf("const recarregar = async");
    const chama = fontePagina.indexOf("await onChanged();", abre);
    const liberta = fontePagina.indexOf("setARecarregar(false)", abre);
    assert.ok(abre > 0 && chama > abre && liberta > chama, "recarregar → onChanged → libertar o botão");
    assert.match(fontePagina, /\{falhouLeitura \? QUARENTENA_TENTAR_NOVAMENTE : QUARENTENA_ATUALIZAR\}/);
    assert.match(fontePagina, /aria-label=\{QUARENTENA_ATUALIZAR_ARIA\}/, "o botão tem nome acessível");
  });

  test("o texto interno do runtime não vai para o ecrã na quarentena", () => {
    // O motivo dito pelo serviço (`result?.error`) é bem-vindo; o `message` de
    // um `Error` do service-client ("Service client disconnected") não é.
    assert.doesNotMatch(
      fontePagina,
      /message: err instanceof Error \? err\.message/,
      "a exceção técnica deixou de ser a frase do ecrã",
    );
    assert.doesNotMatch(fontePagina, /String\(err\)/);
    assert.match(fontePagina, /console\.warn\("\[Quarantine\] ação não chegou ao serviço", err\)/, "a razão fica no registo");
    assert.match(
      fontePagina,
      /setBandeira\(decideBandeira\(entry, decideResultadoAcao\(result\)\)\)/,
      "o motivo dito pelo serviço continua a chegar ao ecrã (V4: pela banda persistente)",
    );
    assert.ok(
      !/Service client|disconnected|Cannot read|undefined\b|TypeError/i.test(QUARENTENA_SEM_CONFIRMACAO_NOTE),
      "sem resquício de texto interno no ecrã",
    );
    assert.match(QUARENTENA_SEM_CONFIRMACAO_NOTE, /não foi confirmada/);
    assert.ok(!/intacto|não foi alterado/i.test(QUARENTENA_SEM_CONFIRMACAO_NOTE), "sem prova, sem asserção sobre o ficheiro");
  });
});
