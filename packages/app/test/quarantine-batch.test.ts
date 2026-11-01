import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  decidirResumoLote,
  decidirTipoResumoLote,
  textoResumoLote,
} from "../src/lib/quarantineBatch";

describe("quarentena em lote — o resumo vem dos resultados por ficheiro", () => {
  test("todos confirmados: 3 de 3 e estado confirmado", () => {
    const r = decidirResumoLote([{ tipo: "confirmado" }, { tipo: "confirmado" }, { tipo: "confirmado" }], 3);
    assert.deepEqual(r, { total: 3, confirmados: 3, comAviso: 0, recusados: 0, semConfirmacao: 0, naoTentados: 0 });
    assert.equal(decidirTipoResumoLote(r), "confirmado");
    assert.match(textoResumoLote(r, "restore"), /^3 de 3 restaurados\.$/);
  });

  test("recusa parcial nao e sucesso: entradas preservadas e estado recusado", () => {
    const r = decidirResumoLote([{ tipo: "confirmado" }, { tipo: "recusado" }], 2);
    assert.equal(r.confirmados, 1);
    assert.equal(r.recusados, 1);
    assert.equal(decidirTipoResumoLote(r), "recusado");
    const texto = textoResumoLote(r, "delete");
    assert.match(texto, /1 de 2 eliminado/);
    assert.match(texto, /1 recusado — entradas preservadas/);
  });

  test("falha de comunicacao domina o estado e conta os nao tentados", () => {
    const r = decidirResumoLote([{ tipo: "confirmado" }, { tipo: "sem_confirmacao" }], 4);
    assert.equal(r.semConfirmacao, 1);
    assert.equal(r.naoTentados, 2, "os que ficaram por tentar nao podem contar como feitos");
    assert.equal(decidirTipoResumoLote(r), "sem_confirmacao");
    assert.match(textoResumoLote(r, "restore"), /2 nao tentados/);
  });

  test("sucesso com aviso mantem-se visivel no resumo", () => {
    const r = decidirResumoLote([{ tipo: "confirmado_com_aviso" }], 1);
    assert.equal(r.confirmados, 1);
    assert.equal(r.comAviso, 1);
    assert.equal(decidirTipoResumoLote(r), "confirmado_com_aviso");
    assert.match(textoResumoLote(r, "restore"), /1 com aviso do servico/);
  });

  test("lote vazio nao inventa resultados", () => {
    const r = decidirResumoLote([], 0);
    assert.equal(r.confirmados, 0);
    assert.equal(r.naoTentados, 0);
    assert.equal(decidirTipoResumoLote(r), "confirmado");
    assert.equal(textoResumoLote(r, "delete"), "0 de 0 eliminados.");
  });
});
