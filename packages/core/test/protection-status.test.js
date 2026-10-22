/**
 * `deriveProtectionStatus` — a decisão que diz ao utilizador se está protegido.
 *
 * Tranca a regra que o motor tinha quebrado: zero ameaças com a proteção
 * desligada dava "safe". Estes testes importam a função REAL (não uma cópia),
 * para que não possam passar enquanto o motor fizer outra coisa.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveProtectionStatus, scoreToStatus } from "../dist/definitions.js";

test("proteção desligada NUNCA dá 'safe', mesmo com risco 0", () => {
  assert.equal(deriveProtectionStatus(false, 0, false), "critical");
});

test("scoreToStatus sozinho ainda daria 'safe' — é por isso que a função existe", () => {
  // Documenta o que estamos a corrigir: a função antiga respondia à
  // pergunta errada. Se isto deixar de ser verdade, o teste acima deixa de
  // ter valor e o problema volta.
  assert.equal(scoreToStatus(0, false), "safe");
});

test("desligada não é 'degraded' — o utilizador tem de distinguir", () => {
  const off = deriveProtectionStatus(false, 0, false);
  const partial = deriveProtectionStatus(true, 0, true);
  assert.equal(off, "critical");
  assert.equal(partial, "degraded");
  assert.notEqual(off, partial);
});

test("com proteção ligada, o risco e a degradação mandam como antes", () => {
  assert.equal(deriveProtectionStatus(true, 0, false), "safe");
  assert.equal(deriveProtectionStatus(true, 0, true), "degraded");
  assert.equal(deriveProtectionStatus(true, 15, false), scoreToStatus(15, false));
  assert.equal(deriveProtectionStatus(true, 40, false), scoreToStatus(40, false));
});

test("não lido (undefined/null) nunca dá 'safe'", () => {
  assert.notEqual(deriveProtectionStatus(undefined, 0, false), "safe");
  assert.notEqual(deriveProtectionStatus(null, 0, false), "safe");
});

test("só protectionEnabled === true protege", () => {
  for (const v of [false, null, undefined, 0, "", "true"]) {
    assert.notEqual(
      deriveProtectionStatus(v, 0, false),
      "safe",
      `valor não-booleano ${JSON.stringify(v)} não pode dar 'safe'`,
    );
  }
});