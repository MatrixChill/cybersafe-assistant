import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { quarantinePolicyLabel } from "../src/lib/quarantineDisplay";

/**
 * P0-3 (15/10): a UI tem de mostrar a politica EFETIVA da quarentena, tal como
 * o servico a le. Ausencia de dados = "desconhecido" — jamais OFF fingido.
 */
describe("quarantinePolicyLabel — espelha o servico, nao a esperanca", () => {
  test("warn: OFF sem acao", () => {
    const l = quarantinePolicyLabel("warn");
    assert.equal(l.tone, "off");
    assert.match(l.text, /OFF/);
    assert.match(l.text, /nada é isolado sem a tua decisão/);
  });
  test("ask: OFF com pedido por caso", () => {
    assert.equal(quarantinePolicyLabel("ask").tone, "ask");
  });
  test("automatic-high-confidence: ON condicionado e reversivel", () => {
    const l = quarantinePolicyLabel("automatic-high-confidence");
    assert.equal(l.tone, "auto");
    assert.match(l.text, /LIGADA/);
    assert.match(l.text, /restaurável/);
    assert.match(l.text, /≥ 99%/);
  });
  test("sem valor do servico: DESCONHECIDO, nunca OFF inventado", () => {
    for (const v of [undefined, null, "", "coisa", 42]) {
      const l = quarantinePolicyLabel(v);
      assert.equal(l.tone, "unknown");
      assert.match(l.text, /desconhecido/);
    }
  });
});
