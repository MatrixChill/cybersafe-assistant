import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProcessSnapshot } from "@cybersafe/shared-types";
import TaskManagerPage from "../src/pages/TaskManagerPage";
import {
  estadoDaListaDeProcessos,
  listaDesactualizada,
  rotuloDoEstadoDaLista,
} from "../src/lib/processListState";

// O JSX do fonte compila com o runtime clássico em `tsx`; sem o global nenhum
// teste desta página renderiza (mesma razão do task-manager-page.test.ts).
(globalThis as Record<string, unknown>).React = React;

/**
 * QA1 (2026-10-25) — o Gestor de Tarefas dizia "Nenhum processo encontrado"
 * sem haver UMA resposta válida do serviço. Três estados diferentes caíam no
 * mesmo texto:
 *
 *   1. serviço desligado  -> nunca houve leitura, mas a UI afirmava ausência;
 *   2. primeira leitura pendente -> idem, sem loading;
 *   3. lista antiga em ecrã com o serviço caído -> lida como se fosse actual.
 *
 * O que se fixa aqui: cada um desses casos tem texto próprio, e a frase
 * "Nenhum processo encontrado" só aparece quando o serviço respondeu mesmo com
 * uma lista vazia.
 */

const proc = (pid: number, name = "sample.exe"): ProcessSnapshot => ({
  ppid: 0,
  name,
  path: "",
  commandLine: "",
  user: undefined,
  cpu: 0,
  memoryMb: 0,
  startedAt: new Date(0).toISOString(),
  trusted: "neutral",
});

const render = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(
    createElement(TaskManagerPage as unknown as (p: Record<string, unknown>) => unknown, {
      onRefreshProcesses: () => {},
      ...props,
    }) as never,
  );

describe("Gestor de Tarefas — estado honesto da lista", () => {
  test("serviço desligado e sem leitura NÃO afirma 'Nenhum processo encontrado'", () => {
    const html = render({ processes: [], serviceConnected: false, processesObservedAt: null });
    assert.doesNotMatch(html, /Nenhum processo encontrado/);
    assert.match(html, /Sem leitura de processos/);
    assert.match(html, /não está ligado/i);
    assert.match(html, /não prova/i);
  });

  test("serviço ligado mas primeira leitura pendente mostra carregamento, não ausência", () => {
    const html = render({ processes: [], serviceConnected: true, processesObservedAt: null });
    assert.doesNotMatch(html, /Nenhum processo encontrado/);
    assert.match(html, /A ler a lista de processos/);
  });

  test("resposta válida com lista vazia É o único caso que diz 'Nenhum processo encontrado'", () => {
    const html = render({
      processes: [],
      serviceConnected: true,
      processesObservedAt: Date.UTC(2026, 9, 25, 12, 0, 0),
    });
    assert.match(html, /Nenhum processo encontrado/);
    assert.match(html, /lista vazia/i);
  });

  test("lista com linhas mas serviço desligado é rotulada como leitura antiga", () => {
    const html = render({
      processes: [proc(4100, "notepad.exe"), proc(4200, "chrome.exe")],
      serviceConnected: false,
      processesObservedAt: null,
    });
    // As linhas continuam visíveis (não se inventa uma lista nova)…
    assert.match(html, /notepad\.exe/);
    assert.match(html, /chrome\.exe/);
    // …mas o ecrã diz que aquilo não é uma leitura actual.
    assert.match(html, /[Úú]ltima leitura conhecida/);
    assert.match(html, /não [ée] actual/i);
  });

  test("pesquisa sem correspondências tem texto próprio, distinto de lista vazia", () => {
    const estado = estadoDaListaDeProcessos({
      total: 5,
      visiveis: 0,
      pesquisa: "zzz-inexistente",
      servicoLigado: true,
      observadoEm: 1,
    });
    assert.deepEqual(estado, { kind: "filtro-sem-resultados", total: 5, pesquisa: "zzz-inexistente" });
    const rotulo = rotuloDoEstadoDaLista(estado);
    assert.ok(rotulo);
    assert.match(rotulo!.titulo, /corresponde [àa] pesquisa/i);
    assert.match(rotulo!.detalhe, /5 processos/);
    assert.doesNotMatch(rotulo!.titulo, /Nenhum processo encontrado/);
  });

  test("a decisão pura cobre os cinco estados sem os confundir", () => {
    const base = { total: 0, visiveis: 0, pesquisa: "", observadoEm: null as number | null };

    assert.deepEqual(estadoDaListaDeProcessos({ ...base, servicoLigado: false }), {
      kind: "sem-resposta",
      motivo: "servico-desligado",
    });
    assert.deepEqual(estadoDaListaDeProcessos({ ...base, servicoLigado: null }), { kind: "a-carregar" });
    assert.deepEqual(estadoDaListaDeProcessos({ ...base, servicoLigado: true }), { kind: "a-carregar" });
    assert.deepEqual(estadoDaListaDeProcessos({ ...base, servicoLigado: true, observadoEm: 1 }), { kind: "vazio" });
    assert.deepEqual(
      estadoDaListaDeProcessos({ total: 2, visiveis: 2, pesquisa: "", servicoLigado: true, observadoEm: 1 }),
      { kind: "ok" },
    );
    // Serviço caído com linhas antigas: não é "vazio" nem "ok coroado".
    assert.deepEqual(estadoDaListaDeProcessos({ total: 2, visiveis: 2, pesquisa: "", servicoLigado: false, observadoEm: null }), {
      kind: "ok",
    });
    assert.equal(listaDesactualizada({ total: 2, servicoLigado: false, observadoEm: null }), true);
    assert.equal(listaDesactualizada({ total: 2, servicoLigado: true, observadoEm: 1 }), false);
    assert.equal(listaDesactualizada({ total: 0, servicoLigado: false, observadoEm: null }), false);
  });
});

/**
 * R1 — janela de RECONEXÃO.
 *
 * O `App` limpa `processesObservedAt` ao desconectar mas CONSERVA `processes`.
 * Quando a ligação volta, `serviceConnected` já é `true` e ainda não chegou
 * leitura nova — as linhas no ecrã são as antigas. A versão anterior de
 * `listaDesactualizada` só olhava para `servicoLigado === false`, logo nessa
 * janela (e com ligação ainda desconhecida) o banner desaparecia e as linhas
 * antigas passavam a ser lidas como actuais. O banner também não pode dizer
 * "desligado" quando o serviço está ligado ou por confirmar.
 */
describe("banner de leitura antiga — reconexão e ligação desconhecida", () => {
  test("linhas antigas com serviço LIGADO continuam marcadas como antigas", () => {
    assert.equal(listaDesactualizada({ total: 2, servicoLigado: true, observadoEm: null }), true);
  });

  test("linhas antigas com ligação DESCONHECIDA também", () => {
    assert.equal(listaDesactualizada({ total: 2, servicoLigado: null, observadoEm: null }), true);
  });

  test("linhas antigas com serviço desligado continuam marcadas", () => {
    assert.equal(listaDesactualizada({ total: 2, servicoLigado: false, observadoEm: null }), true);
  });

  test("uma leitura válida torna a lista actual", () => {
    assert.equal(listaDesactualizada({ total: 2, servicoLigado: true, observadoEm: 1 }), false);
    assert.equal(listaDesactualizada({ total: 2, servicoLigado: false, observadoEm: 1 }), false);
  });

  test("sem linhas não há leitura antiga a rotular", () => {
    for (const servicoLigado of [true, false, null] as const) {
      assert.equal(listaDesactualizada({ total: 0, servicoLigado, observadoEm: null }), false);
    }
  });

  test("banner com serviço ligado NÃO diz 'desligado' e explica a espera", () => {
    const html = render({
      processes: [proc(4100, "notepad.exe"), proc(4200, "chrome.exe")],
      serviceConnected: true,
      processesObservedAt: null,
    });
    assert.match(html, /[Úú]ltima leitura conhecida/);
    assert.doesNotMatch(html, /desligado/i);
    assert.match(html, /ainda não chegou uma leitura nova/i);
    assert.match(html, /não [ée] actual/i);
  });

  test("banner com ligação desconhecida NÃO diz 'desligado'", () => {
    const html = render({ processes: [proc(4100, "notepad.exe")], serviceConnected: null, processesObservedAt: null });
    assert.match(html, /[Úú]ltima leitura conhecida/);
    assert.doesNotMatch(html, /desligado/i);
    assert.match(html, /por confirmar/i);
  });

  test("banner com serviço desligado diz que está desligado", () => {
    const html = render({ processes: [proc(4100, "notepad.exe")], serviceConnected: false, processesObservedAt: null });
    assert.match(html, /desligado/i);
    assert.match(html, /[Úú]ltima leitura conhecida/);
  });
});
