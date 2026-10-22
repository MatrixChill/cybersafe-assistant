import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createExitConfirmation, DEFAULT_EXIT_CONFIRM_TIMEOUT_MS } from "../src/exit-confirmation.ts";

/**
 * Regressão da confirmação de saída.
 *
 * A UX mudou (modal CyberSafe em vez do diálogo nativo), mas a lógica de
 * shutdown é exatamente a mesma: confirmar → quitCyberSafe() uma única vez;
 * cancelar/timeout/erro → não encerrar nada.
 */

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("confirmação de saída — decisão", () => {
  it("cancelar nunca chama o shutdown", async () => {
    let shutdowns = 0;
    const confirmation = createExitConfirmation({
      ask: async () => false,
      onConfirmed: () => {
        shutdowns += 1;
      },
    });

    assert.equal(await confirmation.request(), false);
    assert.equal(shutdowns, 0);
    assert.equal(confirmation.isConfirmed, false);
  });

  it("confirmar chama o shutdown existente exatamente uma vez", async () => {
    let shutdowns = 0;
    const confirmation = createExitConfirmation({
      ask: async () => true,
      onConfirmed: () => {
        shutdowns += 1;
      },
    });

    assert.equal(await confirmation.request(), true);
    // Pedidos seguintes (tray clicada de novo, etc.) não repetem o shutdown.
    assert.equal(await confirmation.request(), true);
    assert.equal(shutdowns, 1);
  });

  it("cliques repetidos partilham a mesma pergunta (sem modais duplicados)", async () => {
    const gate = deferred();
    let asks = 0;
    const confirmation = createExitConfirmation({
      ask: () => {
        asks += 1;
        return gate.promise;
      },
      onConfirmed: () => {},
    });

    const first = confirmation.request();
    const second = confirmation.request();
    assert.equal(confirmation.isPending, true);
    gate.resolve(true);

    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(asks, 1, "só pode existir uma pergunta em curso");
    assert.equal(confirmation.isPending, false);
  });

  it("depois de cancelar, um novo pedido volta a perguntar", async () => {
    const answers = [false, true];
    let asks = 0;
    const confirmation = createExitConfirmation({
      ask: async () => answers[asks++],
      onConfirmed: () => {},
    });

    assert.equal(await confirmation.request(), false);
    assert.equal(await confirmation.request(), true);
    assert.equal(asks, 2);
  });

  it("sem resposta dentro do prazo ⇒ cancelar (nunca encerra por timeout)", async () => {
    let shutdowns = 0;
    let timeouts = 0;
    const confirmation = createExitConfirmation({
      ask: () => new Promise(() => {}), // renderer que nunca responde
      onConfirmed: () => {
        shutdowns += 1;
      },
      timeoutMs: 30,
      onTimeout: () => {
        timeouts += 1;
      },
    });

    assert.equal(await confirmation.request(), false);
    assert.equal(timeouts, 1);
    assert.equal(shutdowns, 0);
  });

  it("falha ao perguntar não rebenta o processo nem encerra", async () => {
    let shutdowns = 0;
    let errors = 0;
    const confirmation = createExitConfirmation({
      ask: async () => {
        throw new Error("renderer morreu");
      },
      onConfirmed: () => {
        shutdowns += 1;
      },
      onError: () => {
        errors += 1;
      },
    });

    assert.equal(await confirmation.request(), false);
    assert.equal(errors, 1);
    assert.equal(shutdowns, 0);
  });

  it("prazo por omissão é generoso mas finito", () => {
    assert.ok(DEFAULT_EXIT_CONFIRM_TIMEOUT_MS >= 10_000);
    assert.ok(Number.isFinite(DEFAULT_EXIT_CONFIRM_TIMEOUT_MS));
  });
});
