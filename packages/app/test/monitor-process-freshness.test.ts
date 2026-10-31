import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ler = (caminho: string) => readFileSync(new URL(caminho, import.meta.url), "utf8");
const MONITOR = ler("../src/pages/MonitorPage.tsx");
const APP = ler("../src/App.tsx");

/**
 * O que o Gestor de Tarefas já afirmava sobre a frescura da enumeração passa a
 * aparecer no Monitor. O que este lock NÃO permite:
 *  · o Monitor decidir a frescura por si (era um segundo avaliador a discutir
 *    com o primeiro sobre os mesmos dados);
 *  · o número `0` de processos ser mostrado como facto quando o serviço não
 *    respondeu;
 *  · a hora ser carimbada no `renderer` em vez de vir do instante da foto.
 */
test("o Monitor consome o avaliador de frescura partilhado, não um seu", () => {
  assert.match(MONITOR, /from "@\/lib\/processListState"/, "o Monitor deixou de usar o avaliador partilhado");
  assert.match(MONITOR, /estadoDaListaDeProcessos\(\{/, "o estado da lista deixou de ser derivado");
  assert.match(MONITOR, /rotuloDoEstadoDaLista\(/, "falta o rótulo partilhado");
  assert.match(MONITOR, /observadoEm: processesObservedAt/, "a frescura não chega ao avaliador");
  assert.match(MONITOR, /verdade: processTruth/, "o que o serviço afirma não é consultado");
  assert.match(MONITOR, /servicoLigado: serviceConnected/, "o estado da ligação não é consultado");

  assert.doesNotMatch(MONITOR, /Date\.now\(\)\s*-\s*processesObservedAt/, "o Monitor voltou a calcular a idade à mão");
  assert.doesNotMatch(MONITOR, /new Date\(\)\.getTime\(\)/, "relógio do cliente carimbado como frescura");
  assert.doesNotMatch(MONITOR, /function estadoDaLista|const estadoDaLista\s*=/, "o Monitor duplicou o avaliador");
});

test("o App entrega ao Monitor a mesma frescura que entrega ao Gestor", () => {
  const chamada = /<MonitorPage[^>]*/.exec(APP)?.[0] ?? "";
  assert.ok(chamada.length > 0, "a chamada do MonitorPage não foi encontrada");
  for (const prop of ["processesObservedAt={processesObservedAt}", "processTruth={processesTruth}", "serviceConnected={serviceConnected}"]) {
    assert.ok(chamada.includes(prop), `o Monitor deixou de receber ${prop}`);
  }
  // Mesma fonte para as duas páginas: nenhuma delas tem um instante próprio.
  assert.match(APP, /const \[processesObservedAt, setProcessesObservedAt\]/, "a origem única da frescura mudou de sítio");
});

test("sem leitura válida o número não é mostrado como contagem", () => {
  // O cartão dos processos só pode trocar o número por texto através do
  // parâmetro explícito — um `0` silencioso voltava a ler-se como «não há
  // processos» exatamente como antes.
  assert.match(MONITOR, /valorText=\{rotuloLista/, "o cartão voltou a imprimir o número sem leitura");
  assert.match(MONITOR, /valorText \?\? value/, "o MetricCard deixou de honrar a sobreposição");
  assert.match(MONITOR, /sem leitura/, "desapareceu a palavra que diz o estado");
});
