import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyError, AI_REQUEST_TIMEOUT_MS } from "../dist/ai.js";

describe("Matrix — limite do pedido JSON ao provider", () => {
  test("o pedido JSON tem timeout finito e razoavel (nunca indefinido)", () => {
    assert.equal(typeof AI_REQUEST_TIMEOUT_MS, "number");
    assert.ok(AI_REQUEST_TIMEOUT_MS > 0 && AI_REQUEST_TIMEOUT_MS <= 60000, String(AI_REQUEST_TIMEOUT_MS));
  });
});

describe("Matrix — classificação de erros do provider", () => {
  test("404 de modelo inexistente vira model_unavailable, sem eco da mensagem crua", () => {
    const e = classifyError({ status: 404, message: "The model `groq/compound` does not exist" });
    assert.equal(e.kind, "model_unavailable");
    assert.equal(e.status, 404);
    assert.doesNotMatch(e.message, /groq\/compound/);
  });

  test("timeout do SDK vira timeout", () => {
    const e = classifyError({ name: "APIConnectionTimeoutError", message: "Request timed out." });
    assert.equal(e.kind, "timeout");
  });

  test("429 continua rate_limited e 401/403 continuam auth", () => {
    assert.equal(classifyError({ status: 429 }).kind, "rate_limited");
    assert.equal(classifyError({ status: 401 }).kind, "auth");
    assert.equal(classifyError({ status: 403 }).kind, "auth");
  });

  test("erro de rede genérico não ecoa a mensagem original", () => {
    const e = classifyError({ message: "getaddrinfo ENOTFOUND api.groq.com" });
    assert.equal(e.kind, "network");
    assert.doesNotMatch(e.message, /ENOTFOUND/);
  });
});
