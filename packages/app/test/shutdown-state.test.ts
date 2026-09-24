import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createShutdownState,
  ipcUnlessShuttingDown,
  runUnlessShuttingDown,
} from "../src/lib/shutdownState";
import { exitConfirmResponse } from "../src/lib/exitConfirm";

/**
 * Regressão do polling durante o shutdown.
 *
 * Bug manual (2ª saída): depois de o main desligar o ServiceClient, o renderer
 * continuava a pedir `service:get-protection-state/events/threats/processes/
 * connections/quarantine/pcstate` — cada um aparecia como
 * "Error occurred in handler for '...': Error: Service client disconnected".
 */

describe("shutdownState — polling para imediatamente", () => {
  test("antes do shutdown o trabalho corre normalmente", () => {
    const state = createShutdownState();
    let polls = 0;
    assert.equal(runUnlessShuttingDown(() => { polls += 1; }, state), true);
    assert.equal(polls, 1);
    assert.equal(state.isShuttingDown(), false);
  });

  test("confirmar a saída para logo o polling", () => {
    const state = createShutdownState();
    let polls = 0;

    runUnlessShuttingDown(() => { polls += 1; }, state);
    state.begin();

    assert.equal(state.isShuttingDown(), true);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(runUnlessShuttingDown(() => { polls += 1; }, state), false);
    }
    assert.equal(polls, 1, "nenhum poll novo depois de começar o shutdown");
  });

  test("begin() é idempotente e avisa os cleanups uma única vez", () => {
    const state = createShutdownState();
    let cleanups = 0;
    state.onShutdown(() => { cleanups += 1; });

    state.begin();
    state.begin();

    assert.equal(cleanups, 1);
  });

  test("timers são limpos no shutdown (o renderer pode viver mais uns ms)", () => {
    const state = createShutdownState();
    let ticks = 0;
    const timer = setInterval(() => {
      runUnlessShuttingDown(() => { ticks += 1; }, state);
    }, 5);

    const stop = state.onShutdown(() => clearInterval(timer));
    state.begin();
    stop(); // idempotente como o cleanup de um useEffect

    assert.equal(state.isShuttingDown(), true);
    assert.equal(ticks, 0);
  });

  test("um cleanup que rebenta não impede os restantes", () => {
    const state = createShutdownState();
    let secondRan = false;
    state.onShutdown(() => {
      throw new Error("cleanup avariado");
    });
    state.onShutdown(() => { secondRan = true; });

    state.begin();
    assert.equal(secondRan, true);
  });
});

describe("shutdownState — IPC guard", () => {
  test("nenhuma request nova depois do shutdown começar", async () => {
    const state = createShutdownState();
    let calls = 0;
    state.begin();

    const result = await ipcUnlessShuttingDown(async () => {
      calls += 1;
      return "proteção";
    }, state);

    assert.equal(result, null);
    assert.equal(calls, 0, "não pode haver getProtectionState/lista depois do shutdown");
  });

  test("request em voo cancelada pelo shutdown não gera erro nem ruído", async () => {
    const state = createShutdownState();
    const pending = ipcUnlessShuttingDown(
      () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Service client disconnected")), 5)),
      state,
    );

    state.begin();

    assert.equal(await pending, null, "cancelamento esperado resolve em null (sem stack)");
  });

  test("antes do shutdown a resposta chega intacta", async () => {
    const state = createShutdownState();
    assert.equal(await ipcUnlessShuttingDown(async () => 42, state), 42);
  });

  test("erro real em runtime normal continua a propagar", async () => {
    const state = createShutdownState();
    await assert.rejects(
      () => ipcUnlessShuttingDown(async () => { throw new Error("falha real do serviço"); }, state),
      /falha real do serviço/,
    );
  });

  test("resultado que chega depois do shutdown é descartado (não mexe na UI)", async () => {
    const state = createShutdownState();
    let resolveIt: (value: string) => void = () => {};
    const pending = ipcUnlessShuttingDown(
      () => new Promise<string>((resolve) => { resolveIt = resolve; }),
      state,
    );

    state.begin();
    resolveIt("snapshot tardio");

    assert.equal(await pending, null);
  });
});

describe("shutdownState — modal de saída", () => {
  test("cancelar (ou fechar o modal) não para o polling", () => {
    const state = createShutdownState();
    // Cancelar devolve false: nada é confirmado, logo nada para o polling.
    assert.equal(exitConfirmResponse("cancel"), false);
    assert.equal(exitConfirmResponse("none"), null);
    assert.equal(state.isShuttingDown(), false);

    let polls = 0;
    assert.equal(runUnlessShuttingDown(() => { polls += 1; }, state), true);
    assert.equal(polls, 1);
  });

  test("confirmar é o único caminho que para o polling", () => {
    const state = createShutdownState();
    assert.equal(exitConfirmResponse("confirm"), true);
    state.begin();
    assert.equal(runUnlessShuttingDown(() => {}, state), false);
  });
});
