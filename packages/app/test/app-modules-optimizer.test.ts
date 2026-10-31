/**
 * TP-APP-MODULES-FREEBUFF-20261024 — Otimizador.
 *
 * O cartão «Espaço em disco» chamava `describeDiskSpace` e, mesmo quando a
 * função dizia `unknown` (sem leitura fiável), gravava `ok: true` e escrevia
 * «0 GB livres de 0 GB». É um zero inventado e uma verificação dada como
 * concluída sem medição. A decisão passa a ser uma função pura testável.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { desfechoVerificacaoDisco } from "../src/pages/OtimizarPage";

const volume = (over: Record<string, unknown> = {}) => ({
  mount: "C:",
  fileSystem: "NTFS",
  totalGb: 500,
  usedGb: 300,
  freeGb: 200,
  usagePercent: 60,
  kind: "working",
  readOnly: false,
  ...over,
}) as never;

describe("Otimizador — verificação de espaço em disco", () => {
  test("sem leitura fiável falha com motivo e não inventa 0 GB", () => {
    const r = desfechoVerificacaoDisco(volume({ totalGb: null, usedGb: null, freeGb: null, usagePercent: null }), "10:00:00");
    assert.equal(r.ok, false);
    assert.equal(r.severidade, null);
    assert.match(r.mensagem, /sem leitura fiável|não foi possível medir/i);
    assert.match(r.evidencia, /sem leitura fiável/i);
    assert.doesNotMatch(r.evidencia, /0 GB|0,0 GB|de 0/i, "0 GB seria uma medição que não existe");
  });

  test("espaço medido e saudável conclui a verificação com o valor real", () => {
    const r = desfechoVerificacaoDisco(volume(), "10:00:00");
    assert.equal(r.ok, true);
    assert.equal(r.severidade, null);
    assert.match(r.evidencia, /200 GB livres de 500 GB/);
    assert.match(r.evidencia, /medido/);
  });

  test("espaço apertado continua a ser uma medição com aviso", () => {
    const r = desfechoVerificacaoDisco(volume({ totalGb: 500, usedGb: 480, freeGb: 20, usagePercent: 96 }), "10:00:00");
    assert.equal(r.ok, true);
    assert.equal(r.severidade, "atencao");
    assert.match(r.mensagem, /libertar/i);
  });
});
