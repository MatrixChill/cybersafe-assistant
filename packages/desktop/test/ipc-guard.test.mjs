import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardedServiceRequest } from "../src/ipc-guard.ts";

/**
 * Regressão do ruído IPC no shutdown.
 *
 * Depois de `quitCyberSafe()` → `requestShutdown()` → `disconnect()`, qualquer
 * handler `service:*` que ainda chamasse `client.request()` era rejeitado com
 * "Service client disconnected" e o Electron logava
 * "Error occurred in handler for 'service:...'". Esses cancelamentos passam a
 * ser esperados; erros reais continuam a propagar.
 */

describe("guardedServiceRequest — durante o shutdown", () => {
  it("não inicia leituras novas", async () => {
    let calls = 0;
    const result = await guardedServiceRequest(
      () => true,
      async () => {
        calls += 1;
        return "estado";
      },
    );

    assert.equal(result, null);
    assert.equal(calls, 0, "o handler nem pode chegar a chamar client.request");
  });

  it("pedido em voo cancelado pelo shutdown resolve em null (sem stack)", async () => {
    let quitting = false;
    const pending = guardedServiceRequest(
      () => quitting,
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("Service client disconnected")), 5)),
    );

    quitting = true; // o quit começa com o pedido já em voo

    assert.equal(await pending, null);
  });

  it("resultado que chega depois do shutdown é descartado", async () => {
    let quitting = false;
    let resolveIt = () => {};
    const pending = guardedServiceRequest(
      () => quitting,
      () => new Promise((resolve) => { resolveIt = resolve; }),
    );

    quitting = true;
    resolveIt("snapshot tardio");

    assert.equal(await pending, null);
  });
});

describe("guardedServiceRequest — em runtime normal", () => {
  it("devolve a resposta do serviço intacta", async () => {
    const result = await guardedServiceRequest(() => false, async () => ({ riskScore: 3 }));
    assert.deepEqual(result, { riskScore: 3 });
  });

  it("erro real continua a propagar para o renderer", async () => {
    await assert.rejects(
      () => guardedServiceRequest(() => false, async () => { throw new Error("pipe indisponível"); }),
      /pipe indisponível/,
    );
  });
});
