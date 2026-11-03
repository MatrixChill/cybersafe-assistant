import test from "node:test";
import assert from "node:assert/strict";
import { resolveMaxTokens } from "../dist/ai.js";

test("pergunta curta fica no mínimo, sem gastar contexto", () => {
  assert.equal(resolveMaxTokens({ messages: [{ content: "olá" }] }), 400);
});

test("pedido técnico recebe espaço para explicar", () => {
  assert.equal(resolveMaxTokens({ messages: [{ content: "Explica como funciona o motor YARA" }] }), 1100);
});

test("pergunta longa sem pedido técnico sobe apenas um nível", () => {
  assert.equal(resolveMaxTokens({ messages: [{ content: "a".repeat(260) }] }), 700);
});

test("o teto é explícito e nunca é excedido", () => {
  const valor = resolveMaxTokens({ messages: [{ content: "explica ".repeat(400) }] });
  assert.ok(valor <= 1400, `teto excedido: ${valor}`);
});
