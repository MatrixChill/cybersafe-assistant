import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PROTECTION_LEVEL_META } from "../src/lib/protectionHealth";

/**
 * Invariantes de layout do cabeçalho do Painel (estado geral).
 *
 * Bug manual: o texto "Degradado" aparecia sobreposto/desalinhado no topo do
 * Painel. As causas estruturais eram (a) chips sem a utility border (o
 * modificador de cor de borda era inerte e o chip parecia desalinhado) e
 * (b) rótulos do anel sem limite de largura. Estes testes fixam os invariantes.
 */
describe("Dashboard status chip / ring layout invariants", () => {
  const levels = ["protected", "attention", "degraded", "critical"] as const;

  test("o chip inclui a utility border (sem ela, border-*/30 nao desenha)", () => {
    for (const level of levels) {
      assert.match(
        PROTECTION_LEVEL_META[level].chipClass,
        /(^|\s)border(\s|$)/,
        level + ".chipClass precisa da utility border",
      );
    }
  });

  test("o rotulo curto do anel e curto o suficiente para nao transbordar", () => {
    for (const level of levels) {
      const short = PROTECTION_LEVEL_META[level].shortLabel;
      assert.ok(short.length > 0, level + ".shortLabel nao pode ser vazio");
      assert.ok(
        short.length <= 10,
        level + ".shortLabel '" + short + "' e demasiado longo para o anel (<=10)",
      );
    }
  });

  test("cada nivel define as classes semanticas usadas no cabecalho", () => {
    for (const level of levels) {
      const meta = PROTECTION_LEVEL_META[level];
      for (const key of ["dotClass", "textClass", "chipClass", "label"] as const) {
        assert.equal(typeof meta[key], "string");
        assert.ok(meta[key].length > 0, level + "." + key + " nao pode ser vazio");
      }
    }
  });

  test("o nivel degraded expoe exatamente o texto do bug reportado", () => {
    assert.equal(PROTECTION_LEVEL_META.degraded.shortLabel, "Degradado");
  });
});
