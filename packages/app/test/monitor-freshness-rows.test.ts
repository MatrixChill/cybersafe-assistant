import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MonitorPage from "../src/pages/MonitorPage";
import type { ProcessSnapshot, ProcessEnumerationTruth } from "@cybersafe/shared-types";

/**
 * Frescura do Monitor com **linhas presentes** — o caso que a revisão v2
 * reproduziu e que o v2 não cobria.
 *
 * A ligação que faltava: `estadoDaListaDeProcessos` decide o que dizer quando a
 * lista está VAZIA. Com `total > 0` e linhas visíveis devolve `ok` e o rótulo é
 * `null` — é o desenho dele, não um bug dele. O Gestor de Tarefas por isso usa
 * um SEGUNDO eixo (`avisoDeEnumeracao` + `listaDesactualizada`), que continua a
 * avisar quando há linhas antigas em ecrã: sem esse eixo, a tabela tapava a
 * falha e «165 processos» era lido como facto actual.
 *
 * Este ficheiro é comportamental de propósito: renderiza o Monitor a sério
 * (`renderToStaticMarkup`) e lê o markup. Os testes estruturais de v2
 * (`monitor-process-freshness.test.ts`) provavam que a página *chamava* o
 * avaliador; não provavam que o aviso chega ao ecrã quando há linhas.
 *
 * Nenhum relógio do cliente: a idade vem de `verdade.asOf - verdade.enumeratedAt`,
 * ambos carimbados pelo serviço.
 */

const AS_OF = 1_700_000_000_000;
/** Últimas 165 linhas de uma foto tirada 105 s antes da última resposta. */
const FOTO_ANTIGA = AS_OF - 105_000;

/** Foto com `n` linhas, com os campos que a tabela do Monitor lê de facto. */
function linhas(n: number): ProcessSnapshot[] {
  return Array.from({ length: n }, (_, i): ProcessSnapshot => ({
    pid: 1000 + i,
    ppid: 4,
    name: `processo-${i}`,
    path: "C:\\x",
    commandLine: "C:\\x",
    cpu: 0,
    memoryMb: 1,
    startedAt: "2026-10-26T00:00:00.000Z",
    trusted: "neutral",
  }));
}

function verdade(campos: Partial<ProcessEnumerationTruth>): ProcessEnumerationTruth {
  return {
    state: "ok",
    enumeratedAt: FOTO_ANTIGA,
    asOf: AS_OF,
    ...campos,
  } as ProcessEnumerationTruth;
}

function renderizar(
  total: number,
  processTruth: ProcessEnumerationTruth | null | undefined,
  extras: { serviceConnected?: boolean | null; processesObservedAt?: number | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(MonitorPage, {
      events: [],
      processes: linhas(total),
      connections: [],
      quarantine: [],
      protection: null,
      processTruth,
      serviceConnected: extras.serviceConnected ?? true,
      processesObservedAt:
        "processesObservedAt" in extras ? extras.processesObservedAt : processTruth?.enumeratedAt ?? null,
    }),
  );
}

test("linhas + enumeração falhada: o Monitor avisa sobre as linhas e diz a idade da foto", () => {
  const html = renderizar(165, verdade({
    state: "failed",
    enumeratedAt: FOTO_ANTIGA,
    attempt: { error: { message: "CreateToolhelp32Snapshot falhou" } },
  }));
  assert.ok(
    html.includes("A enumeração de processos falhou"),
    "com 165 linhas em ecrã, `estadoDaLista` é `ok` e a falha desaparecia sem o segundo eixo",
  );
  assert.ok(html.includes("CreateToolhelp32Snapshot falhou"), "o motivo do serviço tem de aparecer");
  assert.ok(/105\s?s/.test(html), "a idade da foto (do serviço, não do cliente) tem de aparecer");
  // O número não é apagado — é a última foto — mas não pode aparecer sem aviso.
  assert.ok(html.includes("165"), "o valor da última foto preserva-se");
});

test("linhas + frescura não afirmada: aviso próprio, sem afirmar que está actual", () => {
  const html = renderizar(12, verdade({ state: "unreported", enumeratedAt: null }));
  assert.ok(html.includes("Frescura da lista não afirmada"), html.slice(0, 400));
  assert.ok(html.includes("12"), "as linhas continuam visíveis como última foto");
});

test("linhas + serviço desligado: rótulo de desconexão, não lista silenciosa", () => {
  const html = renderizar(40, verdade({ state: "ok", enumeratedAt: FOTO_ANTIGA }), {
    serviceConnected: false,
    processesObservedAt: null,
  });
  assert.ok(html.includes("o serviço está desligado"), "tem de dizer a origem do estado antigo");
  assert.ok(html.includes("40"));
});

test("linhas + reconexão sem leitura nova: diz que o serviço voltou e nada é actual", () => {
  const html = renderizar(40, verdade({ state: "ok", enumeratedAt: FOTO_ANTIGA }), {
    serviceConnected: true,
    processesObservedAt: null,
  });
  assert.ok(html.includes("voltou a ligar"), "a janela pós-reconexão é o caso R1: linhas antigas lidas como actuais");
});

test("linhas + enumeração em curso: sem alarme falso, valor preservado", () => {
  const html = renderizar(77, verdade({ state: "in-progress" }));
  assert.ok(!html.includes("A enumeração de processos falhou"), "em curso não é falha");
  assert.ok(!html.includes("Frescura da lista não afirmada"));
  assert.ok(html.includes("77"));
});

test("linhas + leitura válida recente: nenhum aviso de frescura é desenhado", () => {
  const html = renderizar(9, verdade({ state: "ok", enumeratedAt: AS_OF - 2_000 }));
  assert.ok(!html.includes("A enumeração de processos falhou"));
  assert.ok(!html.includes("Frescura da lista não afirmada"));
  assert.ok(!/Última leitura conhecida/.test(html), "com foto válida não há rótulo de leitura antiga");
});

test("lista vazia com falha: usa o avaliador da área vazia, não o aviso de linhas", () => {
  const html = renderizar(0, verdade({ state: "failed", enumeratedAt: null, attempt: { error: { message: "negado" } } }));
  assert.ok(html.includes("Não foi possível ler os processos do Windows"), "zero linhas + falha é a área vazia a falar");
});

test("vazio legítimo: o serviço respondeu com lista vazia e isso é dito como tal", () => {
  const html = renderizar(0, verdade({ state: "ok", enumeratedAt: AS_OF - 1_000 }));
  assert.ok(html.includes("Nenhum processo encontrado"));
  assert.ok(!html.includes("A ler a lista de processos"), "vazio lido ≠ a carregar");
});

/**
 * Caracterização do motivo, não do remendo.
 *
 * Esta é a razão exata pela qual o v2 tinha razão parcial e estava errado: o
 * primeiro eixo responde `ok`/`null` quando há linhas, e respondê-lo differently
 * seria estragar o avaliador da área vazia para toda a aplicação. O que faltava
 * era o segundo eixo, não uma correção ao primeiro — e fica preso aqui para que
 * ninguém « simplifique » o Monitor de volta a um só eixo.
 */
test("com linhas presentes, o eixo da área vazia é `ok` e o rótulo é null (por desenho)", async () => {
  const { estadoDaListaDeProcessos, rotuloDoEstadoDaLista } = await import("../src/lib/processListState");
  const estado = estadoDaListaDeProcessos({
    total: 165,
    visiveis: 20,
    pesquisa: "",
    servicoLigado: true,
    observadoEm: FOTO_ANTIGA,
    verdade: verdade({ state: "failed" }),
  });
  assert.equal(estado.kind, "ok", "é assim que a área vazia fica em silêncio quando há linhas");
  assert.equal(rotuloDoEstadoDaLista(estado), null, "e é por isso que um único eixo não chega");
  // O segundo eixo vê o que o primeiro não pode ver, com as MESMAS entradas.
  const { avisoDeEnumeracao } = await import("../src/lib/processListState");
  assert.equal(avisoDeEnumeracao(verdade({ state: "failed" }), 165)?.titulo, "A enumeração de processos falhou");
});
