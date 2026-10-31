/**
 * P1-PROCESS-TRUTH (interface) — o Gestor de Tarefas não pode confundir
 * «não há processos» com «não se conseguiu ler os processos».
 *
 * O defeito: `estadoDaListaDeProcessos` decidia «vazio» a partir de
 * `observadoEm !== null`, e `observadoEm` era carimbado pelo `App.tsx` com
 * `Date.now()` em QUALQUER resposta. Uma resposta de falha trazia `[]` e um
 * carimbo novo: o ecrã dizia «Nenhum processo encontrado — o serviço respondeu
 * com uma lista vazia» quando o Windows nunca foi ouvido.
 *
 * Aqui: a idade passa a vir do serviço (`truth.enumeratedAt`), e a falha passa
 * a ter estado e aviso próprios. Tudo puro e testável sem React.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  estadoDaListaDeProcessos,
  rotuloDoEstadoDaLista,
  avisoDeEnumeracao,
  instanteDeLeituraValida,
  listaDesactualizada,
} from "../src/lib/processListState";
import type { ProcessEnumerationTruth } from "@cybersafe/shared-types";

const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const PAGINA = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");

const entrada = (overrides: Record<string, unknown> = {}) => ({
  total: 0,
  visiveis: 0,
  pesquisa: "",
  servicoLigado: true,
  observadoEm: null,
  ...overrides,
});

const verdade = (overrides: Partial<ProcessEnumerationTruth> = {}): ProcessEnumerationTruth => ({
  state: "ok",
  enumeratedAt: 1_700_000_000_000,
  servedFrom: "snapshot",
  attempt: { startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_001, ok: true },
  asOf: 1_700_000_000_002,
  ...overrides,
});

describe("idade da leitura vem do serviço, não do relógio do cliente", () => {
  it("ok com foto: o instante é o da foto", () => {
    assert.equal(instanteDeLeituraValida(verdade()), 1_700_000_000_000);
  });

  it("falha sem foto: não há instante a afirmar", () => {
    assert.equal(instanteDeLeituraValida(verdade({ state: "failed", enumeratedAt: null })), null);
  });

  it("falha COM foto anterior: a idade é a da foto anterior, não agora", () => {
    assert.equal(
      instanteDeLeituraValida(verdade({ state: "failed", servedFrom: "cache" })),
      1_700_000_000_000,
    );
  });

  it("sem contrato (serviço de boot anterior): não se afirma frescura", () => {
    assert.equal(instanteDeLeituraValida(verdade({ state: "unreported", enumeratedAt: null })), null);
  });

  it("REGRESSÃO: o App já não carimba Date.now() para dizer o que é actual", () => {
    assert.doesNotMatch(
      APP,
      /const observedAt = Date\.now\(\);\s*\n\s*processHistoryRef\.current\?\.registar/,
      "o carimbo do cliente voltou: qualquer resposta, inclusive uma falha, fica «actual»",
    );
    assert.match(APP, /instanteDeLeituraValida/, "o App usa o instante afirmado pelo serviço");
  });
});

describe("estados da lista — zero linhas deixaram de ser uma só coisa", () => {
  it("falha sem linhas: é falha identificável, nunca «nenhum processo»", () => {
    const estado = estadoDaListaDeProcessos(
      entrada({ verdade: verdade({ state: "failed", enumeratedAt: null, servedFrom: "cache" }) }),
    );
    assert.equal(estado.kind, "falha-enumeracao");
    const rotulo = rotuloDoEstadoDaLista(estado);
    assert.ok(rotulo);
    assert.match(rotulo.titulo, /não foi possível/i);
    assert.doesNotMatch(`${rotulo.titulo} ${rotulo.detalhe}`, /Nenhum processo/i,
      "falhou a leitura; afirmar ausência de processos é inventar");
    assert.equal(rotulo.carregando, false);
  });

  it("em curso sem linhas: diz que está a enumerar", () => {
    const estado = estadoDaListaDeProcessos(entrada({ verdade: verdade({ state: "in-progress", enumeratedAt: null, attempt: null }) }));
    assert.equal(estado.kind, "a-enumerar");
    assert.equal(rotuloDoEstadoDaLista(estado)?.carregando, true);
  });

  it("pedido em voo sem verdade ainda: também é «a enumerar»", () => {
    const estado = estadoDaListaDeProcessos(entrada({ aEnumerar: true }));
    assert.equal(estado.kind, "a-enumerar");
  });

  it("vazio legítimo exige foto do SO com zero linhas", () => {
    const estado = estadoDaListaDeProcessos(entrada({ verdade: verdade() }));
    assert.equal(estado.kind, "vazio");
    assert.match(rotuloDoEstadoDaLista(estado)!.titulo, /Nenhum processo/);
  });

  it("sem contrato e sem linhas: não afirma vazio nem actual", () => {
    const estado = estadoDaListaDeProcessos(
      entrada({ verdade: verdade({ state: "unreported", enumeratedAt: null, servedFrom: "cache", attempt: null }) }),
    );
    assert.equal(estado.kind, "sem-leitura-afirmada");
  });

  it("REGRESSÃO: sem verdade nenhuma (chamada antiga) continua a distinguir os quatro estados prévios", () => {
    assert.equal(estadoDaListaDeProcessos(entrada({ servicoLigado: false })).kind, "sem-resposta");
    assert.equal(estadoDaListaDeProcessos(entrada({ servicoLigado: null })).kind, "a-carregar");
    assert.equal(estadoDaListaDeProcessos(entrada({ observadoEm: 1 })).kind, "vazio");
  });
});

describe("aviso sobre a tabela — a falha não desaparece porque há linhas", () => {
  it("falha com linhas antigas: aviso com motivo e idade, sem apagar a tabela", () => {
    const aviso = avisoDeEnumeracao(verdade({
      state: "failed",
      servedFrom: "cache",
      attempt: { startedAt: 1, finishedAt: 2, ok: false, error: { code: "cim", message: "Enumeração de processos indisponível (CIM falhou)" } },
    }), 40);
    assert.ok(aviso, "com linhas em ecrã a falha tem de ser dita");
    assert.match(aviso.titulo, /falhou|não foi possível/i);
    assert.match(aviso.detalhe, /CIM/, "o motivo real chega ao utilizador");
    assert.doesNotMatch(aviso.detalhe, /desligado/, "falha de enumeração não é ausência de serviço");
  });

  it("ok não gera aviso nenhum", () => {
    assert.equal(avisoDeEnumeracao(verdade(), 40), null);
  });

  it("in-progress não gera aviso: está a ser tratado, não quebrado", () => {
    assert.equal(avisoDeEnumeracao(verdade({ state: "in-progress", enumeratedAt: null, attempt: null }), 40), null);
  });

  it("serviço sem contrato: avisa que a frescura não é afirmada", () => {
    const aviso = avisoDeEnumeracao(verdade({ state: "unreported", enumeratedAt: null, attempt: null }), 12);
    assert.ok(aviso);
    assert.match(aviso.titulo, /não afirma|sem contrato|não é possível confirmar/i);
  });
});

describe("cópia e ligações na interface", () => {
  it("a página recebe a verdade e mostra o aviso", () => {
    assert.match(PAGINA, /avisoDeEnumeracao\(/, "a página usa o aviso");
    assert.match(PAGINA, /verdade\??: processTruth|processTruth\?: ProcessEnumerationTruth/, "a página recebe a verdade do App");
  });

  it("control of mutação: sem a prop, o guarda acima não é sempre-verdadeiro", () => {
    assert.equal(
      /processTruth\?: ProcessEnumerationTruth/.test(`${PAGINA}`.replace("processTruth?: ProcessEnumerationTruth", "")),
      false,
    );
  });

  it("PT-PT: a copy nova dos estados não usa gerúndio brasileiro", () => {
    const rotulos = [
      rotuloDoEstadoDaLista(estadoDaListaDeProcessos(entrada({ verdade: verdade({ state: "failed", enumeratedAt: null }) }))),
      rotuloDoEstadoDaLista(estadoDaListaDeProcessos(entrada({ verdade: verdade({ state: "in-progress", enumeratedAt: null, attempt: null }) }))),
      rotuloDoEstadoDaLista(estadoDaListaDeProcessos(entrada({ verdade: verdade({ state: "unreported", enumeratedAt: null, attempt: null, servedFrom: "cache" }) }))),
      avisoDeEnumeracao(verdade({ state: "failed", servedFrom: "cache" }), 10),
      avisoDeEnumeracao(verdade({ state: "unreported", enumeratedAt: null, attempt: null }), 10),
    ].filter(Boolean) as { titulo: string; detalhe?: string }[];
    assert.ok(rotulos.length >= 5, "todos os estados novos têm copy");
    for (const r of rotulos) {
      assert.doesNotMatch(`${r.titulo} ${r.detalhe ?? ""}`, /Carregando|Verificando|Ativando/, `PT-BR em: ${r.titulo}`);
    }
  });
});
