import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mapKillResult,
  KILL_SUCCESS_MESSAGE,
  KILL_SUCCESS_MESSAGE_WITH_TREE,
  isKillRequestInFlight,
  beginKillRequest,
  endKillRequest,
  runKillRequest,
} from "../src/lib/processActions";
import type { ProcessKillResult } from "@cybersafe/shared-types";

/**
 * Ultimo fecho do Task Manager: o caminho de SUCESSO era silencioso, e uma
 * tentativa de terminar processo nunca pode acabar sem feedback.
 *
 * A falha ja estava corrigida (protected, timeout, reused, access-denied,
 * alias-stub, failed tem mensagem). O sucesso devolvia `message: null` e o
 * utilizador ficava sem nenhuma confirmação de que o processo morreu.
 *
 * E o duplo envio: o botão ficar `disabled` só chega no re-render, que em
 * React acontece no turno seguinte. Cliques no mesmo turno passam todos, e
 * cada um despacha um pedido. Por isso a guarda tem de ser SÍNCRONA e local ao
 * fluxo — um ref, testado à entrada, limpo num `finally`. Nada de debounce.
 */

function result(overrides: Partial<ProcessKillResult> = {}): ProcessKillResult {
  return { success: false, status: "failed", pid: 4242, ...overrides };
}

describe("A1 — o sucesso tem mensagem (nao null)", () => {
  test("killed devolve uma mensagem de sucesso, nao null", () => {
    const outcome = mapKillResult(result({ success: true, status: "killed" }));
    assert.equal(outcome.success, true);
    assert.ok(outcome.message, "o sucesso nao pode ser silencioso");
    assert.match(outcome.message!, /terminado/i);
  });

  test("SEM prova de que os filhos morreram, a mensagem NAO os afirma", () => {
    // O contrato atual (`ProcessKillResult`) NAO transporta nenhuma prova sobre
    // os filhos: tem success, status, pid, error, protectedReason, target,
    // exitCode, stdout, stderr. Nenhum campo diz quantos filhos foram
    // terminados. Afirmar "e subprocessos" seria mentira, mesmo com
    // `exitCode: 0` — o exit 0 e o relatorio do taskkill, nao uma verificacao
    // por filho. O servico so reapura o PID alvo.
    const outcome = mapKillResult(result({ success: true, status: "killed", exitCode: 0 }));
    assert.equal(outcome.message, KILL_SUCCESS_MESSAGE);
    assert.doesNotMatch(
      outcome.message!,
      /subprocess/i,
      "sem prova por filho, a mensagem nao pode afirmar os subprocessos",
    );
  });

  test("a forma longa so existe como constante, e nao e a usada por omissao", () => {
    // Existe para quando o contrato transportar a prova. Hoje nao transporta,
    // logo o caminho real nunca a usa. Fixar isto impede que a constante entre
    // em producao sem o campo que a justifica.
    assert.match(KILL_SUCCESS_MESSAGE_WITH_TREE, /subprocess/i);
    assert.notEqual(KILL_SUCCESS_MESSAGE, KILL_SUCCESS_MESSAGE_WITH_TREE);
    assert.equal(mapKillResult(result({ success: true, status: "killed" })).message, KILL_SUCCESS_MESSAGE);
  });

  test("already-exited mantem o texto que ja tinha", () => {
    const outcome = mapKillResult(result({ success: true, status: "already-exited" }));
    assert.match(outcome.message!, /já não estava em execução|n[aã]o estava em execu/i);
  });
});

describe("A3 — uma confirmacao = um request (guarda SINCRONA)", () => {
  test("duas confirmacoes no mesmo turno enviam UM request", async () => {
    let pedidos = 0;
    let libertado;
    const trava = new Promise<void>((r) => { libertado = r; });

    const deps = { pid: 7, gate: { inFlight: false }, kill: async () => { pedidos += 1; await trava; return result({ pid: 7, success: true, status: "killed" }); } };

    // Duas confirmacoes no MESMO turno, antes de qualquer re-render: e
    // exatamente o que o `disabled` do botao nao apanha.
    const primeira = runKillRequest(deps);
    const segunda = runKillRequest(deps);
    await Promise.resolve();
    assert.equal(pedidos, 1, `duas confirmacoes no mesmo turno deram ${pedidos} pedido(s)`);

    libertado!();
    const [a, b] = await Promise.all([primeira, segunda]);
    assert.equal(a.status, "killed");
    // A segunda confirmacao e rejeitada explicitamente, nao um "killed" falso.
    assert.notEqual(b.status, "killed", "a segunda nao pode fingir que foi ela a matar");
    assert.equal(pedidos, 1, "no fim, continua a ser um so pedido");
  });

  test("a guarda e por fluxo: um PID diferente nao e bloqueado pelo outro", async () => {
      const pedidos: number[] = [];
    const kill = async (pid: number) => { pedidos.push(pid); return result({ pid, success: true, status: "killed" }); };
    await Promise.all([
      runKillRequest({ pid: 1, gate: { inFlight: false }, kill }),
      runKillRequest({ pid: 2, gate: { inFlight: false }, kill }),
    ]);
    assert.deepEqual(pedidos.sort(), [1, 2], "dois alvos diferentes sao dois pedidos legítimos");
  });

  test("depois de terminar, o pedido pode ser feito de novo", async () => {
    let pedidos = 0;
    const kill = async (pid: number) => { pedidos += 1; return result({ pid, success: true, status: "killed" }); };
    await runKillRequest({ pid: 3, gate: { inFlight: false }, kill });
    await runKillRequest({ pid: 3, gate: { inFlight: false }, kill });
    assert.equal(pedidos, 2, "a guarda limpa-se no fim, senao o gestor deixava de matar");
  });

  test("a guarda e SINCRONA: reading isInFlight e true ANTES de qualquer await", () => {
    const g = { inFlight: false };
    assert.equal(isKillRequestInFlight(g), false);
    beginKillRequest(g);
    assert.equal(isKillRequestInFlight(g), true, "tem de ser verdade no mesmo instante, sem esperar turno");
    endKillRequest(g);
    assert.equal(isKillRequestInFlight(g), false);
  });
});

describe("A2/A4/A5 — estado de progresso: entra e sai sempre", () => {
  test("A2 — enquanto o pedido esta em curso o estado diz 'A terminar processo...'", () => {
    const g = { inFlight: false };
    assert.equal(isKillRequestInFlight(g), false);
    beginKillRequest(g);
    assert.equal(isKillRequestInFlight(g), true);
  });

  test("A2b — a UI mostra mesmo esse texto, e so enquanto o pedido esta em curso", () => {
    // Os testes deste package nao montam React: seguem a convencao de ler o
    // .tsx como texto (ver task-manager-page.test.ts). O que se fixa e que o
    // texto existe E que esta preso ao estado de curso — um texto de progresso
    // que aparece sempre nao e feedback, e decoracao.
    const page = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");
    assert.match(page, /A terminar processo/, "a UI tem de mostrar o progresso");
    assert.match(page, /\{isKilling && \(/, "o texto tem de estar preso ao estado de curso");
    // E o botao continua disabled como segunda camada, a par da guarda síncrona.
    assert.match(page, /disabled=\{isKilling\}/, "o disabled continua, como segunda camada");
    assert.match(page, /killRequestGate/, "a guarda síncrona tem de estar ligada ao fluxo real");
  });

  test("A4 — o SUCESSO limpa o estado de curso", async () => {
    const g = { inFlight: false };
    const deps = { kill: async (pid: number) => result({ pid, success: true, status: "killed" }), gate: g };
    await runKillRequest({ ...deps, pid: 10 });
    assert.equal(isKillRequestInFlight(g), false, "o sucesso tem de limpar a guarda");
  });

  test("A5 — a FALHA limpa o estado de curso", async () => {
    for (const status of ["protected", "timeout", "reused", "access-denied", "alias-stub", "failed"] as const) {
      const g = { inFlight: false };
      await runKillRequest({
        pid: 11,
        gate: g,
        kill: async (pid: number) => result({ pid, status, error: "erro do backend" }),
      });
      assert.equal(isKillRequestInFlight(g), false, `o estado de curso ficou preso apos "${status}"`);
    }
  });

  test("A5b — o `kill` que LANCA tambem limpa a guarda", async () => {
    const g = { inFlight: false };
    await runKillRequest({
      pid: 12,
      gate: g,
      kill: async () => { throw new Error("ipc caiu"); },
    });
    assert.equal(isKillRequestInFlight(g), false, "uma excecao nao pode deixar o gestor bloqueado para sempre");
  });
});

describe("A6 — as mensagens de falha nao regredem", () => {
  test("cada motivo continua a ter a sua mensagem especifica", () => {
    const casos: Array<[string, RegExp]> = [
      ["protected", /serviço de proteção do CyberSafe|próprio serviço/i],
      ["access-denied", /acess/i],
    ];
    for (const [status, re] of casos) {
      const outcome = mapKillResult(result({ status, protectedReason: status === "protected" ? "self" : undefined }));
      assert.ok(outcome.message, `${status} ficou sem mensagem`);
      assert.match(outcome.message!, re, `${status}: ${outcome.message}`);
    }
  });

  test("o erro real do backend continua a ganhar ao texto de recurso", () => {
    const outcome = mapKillResult(result({ status: "access-denied", error: "Access is denied. (os=5)" }));
    assert.equal(outcome.message, "Access is denied. (os=5)");
  });

  test("protected continua a expor o protectedReason", () => {
    const outcome = mapKillResult(result({ status: "protected", protectedReason: "ancestor" }));
    assert.equal(outcome.protectedReason, "ancestor");
  });
});
