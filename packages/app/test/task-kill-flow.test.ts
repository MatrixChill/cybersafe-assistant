import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  KILL_ALREADY_EXITED_TEXT,
  KILL_ERROR_ERROR,
  KILL_FAILED_ERROR,
  KILL_PROTECTED_ERROR,
  KILL_REUSED_ERROR,
  KILL_TIMEOUT_ERROR,
  KILL_UNAVAILABLE_ERROR,
  mapKillResult,
  runKillProcess,
  shouldRefetchAfterKill,
} from "../src/lib/processActions";
import type { ProcessKillResult } from "@cybersafe/shared-types";

/**
 * Regressão do "excluir" no Gestor de Tarefas.
 *
 * Bug manual: excluir deixava a página preta/vazia (overlay de kill preso) e a
 * tarefa reaparecia ao voltar. O renderer precisa de (a) um prazo máximo para o
 * kill, de modo a fechar sempre o overlay, (b) refetch autoritativo do snapshot
 * — sem remoção otimista, e (c) mensagens específicas por status do backend
 * (protected, timeout, reused, failed, already-exited), nunca um erro genérico.
 */

const result = (overrides: Partial<ProcessKillResult>): ProcessKillResult => ({
  success: false,
  status: "failed",
  pid: 4242,
  ...overrides,
});

describe("mapKillResult — status estruturado vira mensagem específica", () => {
  test("killed → sucesso silencioso", () => {
    const outcome = mapKillResult(result({ status: "killed", success: true }));
    assert.equal(outcome.status, "killed");
    assert.equal(outcome.success, true);
    assert.equal(outcome.message, null);
  });

  test("already-exited → sucesso informativo (o objetivo foi atingido)", () => {
    const outcome = mapKillResult(result({ status: "already-exited", success: true }));
    assert.equal(outcome.status, "already-exited");
    assert.equal(outcome.success, true);
    assert.equal(outcome.message, KILL_ALREADY_EXITED_TEXT);
  });

  test("protected → mensagem de processo protegido, não erro genérico", () => {
    const outcome = mapKillResult(result({ status: "protected", protectedReason: "self" }));
    assert.equal(outcome.status, "protected");
    assert.equal(outcome.success, false);
    assert.equal(outcome.message, KILL_PROTECTED_ERROR);
    assert.match(outcome.message ?? "", /protegido/i);
  });

  test("timeout → usa a mensagem do backend quando existe", () => {
    const outcome = mapKillResult(result({ status: "timeout", error: "taskkill não terminou dentro do prazo." }));
    assert.equal(outcome.status, "timeout");
    assert.equal(outcome.message, "taskkill não terminou dentro do prazo.");

    const fallback = mapKillResult(result({ status: "timeout" }));
    assert.equal(fallback.message, KILL_TIMEOUT_ERROR);
  });

  test("reused → mensagem de PID reutilizado", () => {
    const outcome = mapKillResult(result({ status: "reused" }));
    assert.equal(outcome.status, "reused");
    assert.equal(outcome.success, false);
    assert.equal(outcome.message, KILL_REUSED_ERROR);
  });

  test("failed → usa a mensagem do backend quando existe", () => {
    const outcome = mapKillResult(result({ status: "failed", error: "access denied" }));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.message, "access denied");

    const fallback = mapKillResult(result({ status: "failed" }));
    assert.equal(fallback.message, KILL_FAILED_ERROR);
  });

  test("resultado inválido → failed, sem rebentar", () => {
    for (const bad of [null, undefined]) {
      const outcome = mapKillResult(bad);
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.success, false);
      assert.equal(outcome.message, KILL_FAILED_ERROR);
    }
  });
});

describe("runKillProcess — sempre devolve um desfecho (nunca deixa o overlay preso)", () => {
  test("sucesso do backend é propagado tal como vem", async () => {
    const outcome = await runKillProcess({
      pid: 4242,
      kill: async () => result({ status: "killed", success: true }),
    });
    assert.equal(outcome.status, "killed");
    assert.equal(outcome.success, true);
    assert.equal(outcome.message, null);
  });

  test("protected do backend chega à UI com a mensagem certa", async () => {
    const outcome = await runKillProcess({
      pid: 7,
      kill: async () => result({ pid: 7, status: "protected", protectedReason: "ancestor" }),
    });
    assert.equal(outcome.status, "protected");
    assert.equal(outcome.message, KILL_PROTECTED_ERROR);
  });

  test("rejeição da invoke → failed, nunca propaga exceção", async () => {
    const outcome = await runKillProcess({
      pid: 9,
      kill: async () => {
        throw new Error("Service client disconnected");
      },
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.message, KILL_ERROR_ERROR);
  });

  test("invoke que nunca resolve → timeout do renderer (o overlay já pode fechar)", async () => {
    const startedAt = Date.now();
    const outcome = await runKillProcess({
      pid: 10,
      kill: () => new Promise<ProcessKillResult>(() => {}),
      timeoutMs: 15,
    });

    assert.equal(outcome.status, "timeout");
    assert.equal(outcome.success, false);
    assert.equal(outcome.message, KILL_TIMEOUT_ERROR);
    assert.ok(Date.now() - startedAt < 5_000, "não pode esperar indefinidamente");
  });

  test("resposta que chega depois do prazo é ignorada (overlay não reabre)", async () => {
    const outcome = await runKillProcess({
      pid: 11,
      kill: () =>
        new Promise<ProcessKillResult>((resolve) =>
          setTimeout(() => resolve(result({ pid: 11, status: "killed", success: true })), 50),
        ),
      timeoutMs: 10,
    });
    assert.equal(outcome.status, "timeout");
  });

  test("a copy de timeout explica que o processo pode não ter sido terminado", () => {
    assert.match(KILL_TIMEOUT_ERROR, /n[ãa]o respondeu|n[ãa]o responde/);
    assert.match(KILL_UNAVAILABLE_ERROR, /indispon/i);
    assert.notEqual(KILL_TIMEOUT_ERROR, KILL_FAILED_ERROR);
  });
});

describe("shouldRefetchAfterKill — snapshot autoritativo", () => {
  test("killed, already-exited e timeout exigem refetch", () => {
    assert.equal(shouldRefetchAfterKill({ status: "killed", pid: 1, success: true, message: null }), true);
    assert.equal(shouldRefetchAfterKill({ status: "already-exited", pid: 1, success: true, message: KILL_ALREADY_EXITED_TEXT }), true);
    assert.equal(shouldRefetchAfterKill({ status: "timeout", pid: 1, success: false, message: KILL_TIMEOUT_ERROR }), true);
  });

  test("protected/reused/failed/unavailable não mexeram no processo: sem refetch", () => {
    assert.equal(shouldRefetchAfterKill({ status: "protected", pid: 1, success: false, message: KILL_PROTECTED_ERROR }), false);
    assert.equal(shouldRefetchAfterKill({ status: "reused", pid: 1, success: false, message: KILL_REUSED_ERROR }), false);
    assert.equal(shouldRefetchAfterKill({ status: "failed", pid: 1, success: false, message: KILL_FAILED_ERROR }), false);
    assert.equal(shouldRefetchAfterKill({ status: "unavailable", pid: 1, success: false, message: KILL_UNAVAILABLE_ERROR }), false);
  });
});
