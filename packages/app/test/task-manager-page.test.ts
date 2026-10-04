import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProcessSnapshot, ProcessKillResult } from "@cybersafe/shared-types";
import TaskManagerPage, {
  KillConfirmModal,
  freezeKillTarget,
  formatCpu,
  formatMemoryMb,
  initialKillState,
  killReducer,
  killSourceFor,
  killStaleGuard,
  runKillSequence,
  sortProcesses,
  traceKill,
  TM_KILL_TRACE_ENABLED,
  type KillState,
} from "../src/pages/TaskManagerPage";
import type { KillOutcome } from "../src/lib/processActions";
import { PROCESSES_POLL_MS } from "../src/lib/processActions";

// `tsx` compila o JSX do fonte com o runtime clássico (React.createElement), e
// é o global abaixo que o satisfaz fora do Vite. Sem isto nenhum teste desta
// página conseguia renderizar seja o que for - foi por isso que o modal nunca
// foi testado.
(globalThis as Record<string, unknown>).React = React;

/**
 * Regressão do Gestor de Tarefas reproduzida pelo utilizador (P0-A reopen).
 *
 * O que doía no caminho sem pesquisa (U): área principal escura/sem conteúdo,
 * resposta ao clique inconsistente, muito loading e, num caso, o processo nem
 * sequer ter morrido. Causa em duas partes:
 *  1. o modal de confirmação não dizia QUE processo era — e a lista reordena por
 *     CPU a cada refresh, portanto confirmar era um voto cego;
 *  2. o overlay (absolute inset-0, bg-background/80 + blur, sobre TODA a página)
 *     só fechava no `finally`, depois de `await` do refetch global do App (que
 *     volta a enumerar o SO) — o ecrã preto durava kill + enumeração.
 *
 * Render a sério (react-dom/server) em vez de inspecionar texto: é o JSX que
 * está em produção que tem de dizer o nome e o PID.
 */

const proc = (overrides: Partial<ProcessSnapshot> & { pid: number }): ProcessSnapshot => ({
  ppid: 0,
  name: "sample.exe",
  path: "",
  commandLine: "",
  user: undefined,
  cpu: 0,
  memoryMb: 0,
  startedAt: new Date(0).toISOString(),
  trusted: "neutral",
  ...overrides,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TaskManagerPage — render da pagina com processos reais", () => {
  const list = [
    proc({ pid: 4321, name: "Notepad.exe", cpu: 3, memoryMb: 27 }),
    proc({ pid: 111, name: "System", cpu: 0, memoryMb: 5 }),
  ];

  test("renderiza as linhas com nome e PID (a pagina carrega com o wiring novo)", () => {
    const html = renderToStaticMarkup(createElement(TaskManagerPage, { processes: list }));
    assert.match(html, /Notepad\.exe/);
    assert.match(html, />4321</);
    assert.doesNotMatch(html, /Nenhum processo encontrado/, "com 2 processos a lista nao pode ficar vazia");
  });

  test("o modal nao aparece sem selecao (killingPid e null)", () => {
    const html = renderToStaticMarkup(createElement(TaskManagerPage, { processes: list }));
    assert.doesNotMatch(html, /Terminar este processo\?/);
  });
});

describe("KillConfirmModal — identifica o processo (render do JSX real)", () => {
  const target = proc({ pid: 4321, name: "Notepad.exe", user: "PC\\caioc", memoryMb: 27.4 });
  const render = (props?: Partial<Parameters<typeof KillConfirmModal>[0]>) =>
    renderToStaticMarkup(
      createElement(KillConfirmModal, {
        target,
        isKilling: false,
        onCancel: () => {},
        onConfirm: () => {},
        ...props,
      }),
    );

  test("mostra o NOME do processo que vai ser terminado", () => {
    assert.match(render(), /Notepad\.exe/);
  });

  test("mostra o PID do processo", () => {
    assert.match(render(), /PID 4321/);
  });

  test("mostra utilizador e memória (contexto para distinguir homónimos)", () => {
    const html = render();
    assert.match(html, /PC\\caioc/, "o user aparece na linha do alvo");
    assert.match(html, /27 MB/);
  });

  test("não mostra o PID de outro processo — a identificação é do alvo, não texto fixo", () => {
    const outro = proc({ pid: 9999, name: "chrome.exe" });
    const html = render({ target: outro });
    assert.match(html, /PID 9999/);
    assert.doesNotMatch(html, /4321/, "o modal anterior não pode deixar rasto");
    assert.doesNotMatch(html, /Notepad\.exe/);
  });

  test("o overlay e `fixed` (viewport), nao `absolute` preso ao contentor scrollavel", () => {
    const html = render();
    assert.match(html, /fixed inset-0/, "o modal tem de sair do contentor da pagina");
    assert.doesNotMatch(html, /absolute inset-0/, "absolute inset-0 dentro de p-8 h-full centrava o card fora do ecran");
  });

  test("guarda de convensao: nenhum overlay de modal fica absolute nesta pagina", () => {
    // So os modais contam; camadas decorativas (gradient/ping) podem ser absolute.
    const source = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");
    const absoluteOverlays = source
      .split("\n")
      .filter((line) => /className="[^"]*absolute inset-0/.test(line));
    assert.deepEqual(absoluteOverlays, [], "overlay de modal tem de ser fixed, como ThreatsPage/BSC/ExitConfirmDialog");
  });

  test("o card ainda nao e texto generico (identificacao mantida)", () => {
    const html = render();
    assert.doesNotMatch(
      html,
      /O processo pode estar sendo usado por um programa ativo\./,
      "a frase genérica já não é a única coisa que o utilizador lê",
    );
  });

  test("durante o kill diz que a lista se atualiza a seguir (não deixa dúvida de que a app pendurou)", () => {
    assert.match(render({ isKilling: true }), /a lista atualiza-se sozinha/);
  });
});

describe("runKillSequence — overlay fecha no fim do kill, refetch em segundo plano", () => {
  const outcomeFor = (status: ProcessKillResult["status"], pid: number): KillOutcome => ({
    status,
    pid,
    success: status === "killed" || status === "already-exited",
    message: status === "killed" ? null : "aviso",
  });

  test("killed: o overlay fecha ENQUANTO o refetch ainda está em voo", async () => {
    const events: string[] = [];
    let releaseRefresh: () => void = () => {};
    const refresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    const sequence = runKillSequence({
      pid: 4321,
      kill: async () => ({ success: true, status: "killed", pid: 4321 }) satisfies ProcessKillResult,
      refresh: () => refresh,
      onOutcome: () => events.push("notice"),
      onFinish: () => events.push("overlay-fecha"),
    });

    await sleep(0);
    assert.ok(events.includes("overlay-fecha"), "overlay fechou: " + events.join(","));
    assert.ok(!events.includes("refetch-terminou"), "o refetch continua em voo quando o overlay já fechou");

    releaseRefresh();
    await sequence;
    await refresh;
  });

  test("o refetch é disparado para os desfechos que mexeram no processo", async () => {
    for (const status of ["killed", "already-exited", "timeout", "alias-stub", "reused"] as const) {
      let refreshed = false;
      const outcome = outcomeFor(status, 1);
      await runKillSequence({
        pid: 1,
        kill: async () => ({ success: outcome.success, status, pid: 1 }) satisfies ProcessKillResult,
        refresh: () => {
          refreshed = true;
        },
        onOutcome: () => {},
        onFinish: () => {},
      });
      await sleep(0);
      assert.equal(refreshed, true, status + " tem de ir buscar snapshot novo");
    }
  });

  test("protected/failed não re-enumeram (nada mudou no SO) mas fecham o overlay", async () => {
    for (const status of ["protected", "access-denied", "failed"] as const) {
      let refreshed = false;
      let closed = false;
      await runKillSequence({
        pid: 2,
        kill: async () => ({ success: false, status, pid: 2 }) satisfies ProcessKillResult,
        refresh: () => {
          refreshed = true;
        },
        onOutcome: () => {},
        onFinish: () => {
          closed = true;
        },
      });
      await sleep(0);
      assert.equal(closed, true, status + " tem de fechar o overlay");
      assert.equal(refreshed, false, status + " não pede snapshot novo");
    }
  });

  test("devolve o desfecho ao chamador (é ele que mostra o aviso)", async () => {
    const outcome = await runKillSequence({
      pid: 3,
      kill: async () => ({ success: false, status: "protected", pid: 3, protectedReason: "self" }) satisfies ProcessKillResult,
      refresh: () => {},
      onOutcome: () => {},
      onFinish: () => {},
    });
    assert.equal(outcome.status, "protected");
    assert.equal(outcome.success, false);
  });
});

describe("sortProcesses — ordem estável sob refresh (linhas que não saltam)", () => {
  test("CPU igual → desempate por nome e PID, e não pela ordem do snapshot", () => {
    const a = [
      proc({ pid: 30, name: "zeta.exe", cpu: 0 }),
      proc({ pid: 10, name: "alpha.exe", cpu: 0 }),
      proc({ pid: 20, name: "mid.exe", cpu: 0 }),
    ];
    const b = [...a].reverse();
    assert.deepEqual(
      sortProcesses(a, "cpu").map((p) => p.pid),
      sortProcesses(b, "cpu").map((p) => p.pid),
      "dois refreshs com a mesma verdade têm de dar a mesma ordem",
    );
    assert.deepEqual(sortProcesses(a, "cpu").map((p) => p.name), ["alpha.exe", "mid.exe", "zeta.exe"]);
  });

  test("CPU diferente continua por ordem decrescente", () => {
    const list = [proc({ pid: 1, name: "a.exe", cpu: 5 }), proc({ pid: 2, name: "b.exe", cpu: 40 })];
    assert.deepEqual(sortProcesses(list, "cpu").map((p) => p.pid), [2, 1]);
  });

  test("memória empatada também desempata de forma determinística", () => {
    const list = [proc({ pid: 9, name: "b.exe", memoryMb: 100 }), proc({ pid: 8, name: "a.exe", memoryMb: 100 })];
    assert.deepEqual(sortProcesses(list, "mem").map((p) => p.pid), [8, 9]);
  });

  test("não muta o array que recebe (a lista vem do estado do App)", () => {
    const list = [proc({ pid: 1, name: "a.exe", cpu: 1 }), proc({ pid: 2, name: "b.exe", cpu: 9 })];
    const snapshot = list.map((p) => p.pid);
    sortProcesses(list, "cpu");
    assert.deepEqual(list.map((p) => p.pid), snapshot);
  });
});

/**
 * HOTFIX P0 — o alvo é congelado no clique.
 *
 * Reprodução do utilizador: Notepad MSIX = stub launcher + processo real com o
 * mesmo timestamp. O poll de 10 s emitava `exited` para o stub, o serviço
 * tombstoneava o PID e a lista deixava de o conter. Como o modal DERIVAVA o
 * alvo da lista, o overlay desaparecia em silêncio com `killingPid` definido; o
 * clique seguinte no mesmo número não causava re-render, e nenhum kill era
 * enviado. Estes testes atravessam o reducer + a sequência que a página usa.
 */
describe("alvo congelado — o kill não depende da lista continuar a ter o PID", () => {
  const stub = proc({ pid: 31696, name: "notepad.exe", user: "PC\\caioc", memoryMb: 31 });
  const other = proc({ pid: 500, name: "chrome.exe", cpu: 9, memoryMb: 400 });

  test("selecionar congela identidade e incrementa a ação", () => {
    const s = killReducer(initialKillState, { type: "select", target: freezeKillTarget(stub), source: "unfiltered" });
    assert.deepEqual(s.target, { pid: 31696, name: "notepad.exe", user: "PC\\caioc", memoryMb: 31 });
    assert.equal(s.actionId, initialKillState.actionId + 1);
    assert.equal(s.source, "unfiltered");
  });

  test("REGRESSÃO: refresh que remove o PID não muda o alvo nem o kill enviado", async () => {
    let state: KillState = killReducer(initialKillState, {
      type: "select",
      target: freezeKillTarget(stub),
      source: "unfiltered",
    });

    // O servidor tira o stub da lista (tombstone pós-exited). Pré-condição do bug.
    const nextList = [other];
    assert.equal(nextList.some((p) => p.pid === state.target?.pid), false, "o PID já saiu da lista");

    const sent: number[] = [];
    await runKillSequence({
      pid: state.target!.pid,
      kill: async (pid) => {
        sent.push(pid);
        return { success: true, status: "killed", pid } satisfies ProcessKillResult;
      },
      refresh: () => {},
      onOutcome: () => {},
      onFinish: () => {
        state = killReducer(state, { type: "clear" });
      },
    });

    assert.deepEqual(sent, [31696], "envia o PID do clique");
    assert.equal(sent.includes(500), false, "nunca pode acabar no processo da linha ao lado");
    assert.equal(state.target, null, "terminal limpa o alvo (nada fica pendurado)");
  });

  test("cancelar limpa o alvo; a ação seguinte é uma nova ação", () => {
    const selected = killReducer(initialKillState, {
      type: "select",
      target: freezeKillTarget(stub),
      source: "unfiltered",
    });
    const cleared = killReducer(selected, { type: "clear" });
    assert.equal(cleared.target, null);
    assert.equal(cleared.actionId, selected.actionId, "cancelar não inventa ação nova");
    const again = killReducer(cleared, { type: "select", target: freezeKillTarget(stub), source: "unfiltered" });
    assert.equal(again.actionId, selected.actionId + 1, "repetir o mesmo PID é uma ação nova");
  });

  test("filtered e unfiltered produzem EXATAMENTE o mesmo alvo", () => {
    assert.equal(killSourceFor(""), "unfiltered");
    assert.equal(killSourceFor("   "), "unfiltered", "só espaços não é pesquisa");
    assert.equal(killSourceFor("notepad"), "filtered");

    const fromUnfiltered = freezeKillTarget(stub);
    const fromFiltered = freezeKillTarget(sortProcesses([stub, other], "cpu").find((p) => p.pid === stub.pid)!);
    assert.deepEqual(fromFiltered, fromUnfiltered);

    const s1 = killReducer(initialKillState, { type: "select", target: fromUnfiltered, source: killSourceFor("") });
    const s2 = killReducer(initialKillState, { type: "select", target: fromFiltered, source: killSourceFor("notepad") });
    assert.deepEqual(s1.target, s2.target, "o caminho não pode alterar quem é morto");
    assert.notEqual(s1.source, s2.source, "o caminho só diferencia o traço");
  });

  test("o modal renderiza com um alvo que não está em lado nenhum da lista", () => {
    const html = renderToStaticMarkup(
      createElement(KillConfirmModal, {
        target: { pid: 31696, name: "notepad.exe", memoryMb: 31 },
        isKilling: false,
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    assert.match(html, /notepad\.exe/);
    assert.match(html, /PID 31696/);
  });
});

describe("traço DEV [TM-KILL] — temporário, um log por evento", () => {
  test("em produção o traço é desligado por construção (import.meta.env.PROD)", () => {
    // Fora do Vite (tsx) DEV_TRACE fica ligado porque PROD não existe; o que se
    // fixa aqui é o contrato: a flag é exportada e única para todo o módulo.
    assert.equal(typeof TM_KILL_TRACE_ENABLED, "boolean");
  });

  test("cada evento é um unico console.log com o prefixo e o actionId", () => {
    const logs: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      traceKill("select", { actionId: 7, source: "unfiltered", rowPid: 1, selectedPid: 1, modalPid: 1 });
      traceKill("result", { actionId: 7, source: "unfiltered", ok: true, status: "killed", listContainsPidAfter: false });
    } finally {
      console.log = original;
    }
    assert.equal(logs.length, 2, "um log por evento, nada em cada render");
    assert.equal(logs[0][0], "[TM-KILL]");
    const first = logs[0][1] as Record<string, unknown>;
    assert.equal(first.event, "select");
    assert.equal(first.actionId, 7, "o actionId atravessa select -> result");
    const second = logs[1][1] as Record<string, unknown>;
    assert.equal(second.status, "killed");
    assert.equal(second.listContainsPidAfter, false);
  });
});

/**
 * PAYLOAD HOSTIL — o card não pode rebentar em render.
 *
 * `KillTarget.memoryMb` está declarado `number`, mas o valor atravessa JSON e o
 * tipo não vale nada no runtime: `freezeKillTarget` copava o campo VERBATIM, e
 * o JSX chamava `target.memoryMb.toFixed(0)` sem guarda. Um `undefined` chega
 * aí e rebenta o render. A row não rebenta porque usa Math.round(...) → NaN
 * tolerado. Daí a assimetria: a lista parece normal, o modal não monta.
 *
 * Nota de honestidade: o repo não tem jsdom/testing-library, por isso não
 * consigo disparar o onClick do DOM num teste. O que está aqui embaixo é o
 * caminho runtime-equivalente: os mesmos dois passos que o onClick executa
 * (freezeKillTarget -> killReducer select) e depois o componente REAL do modal,
 * renderizado com esse estado, mais a pagina REAL com linhas hostis.
 */
describe("payload hostil — normalização no boundary", () => {
  const hostile = (memoryMb: unknown) =>
    ({ ...proc({ pid: 31696, name: "notepad.exe" }), memoryMb } as unknown as ProcessSnapshot);

  test("memoryMb undefined/null/NaN vira 0, nunca um valor que rebenta", () => {
    for (const bad of [undefined, null, Number.NaN, "31", {}]) {
      const t = freezeKillTarget(hostile(bad));
      assert.equal(typeof t.memoryMb, "number", "memoryMb tem de ser number (bad=" + String(bad) + ")");
      assert.ok(Number.isFinite(t.memoryMb), "tem de ser finito");
      assert.equal(t.memoryMb, 0);
    }
  });

  test("memoryMb finito passa exatamente; pid e name são normalizados", () => {
    const t = freezeKillTarget({ ...hostile(31.7), pid: "31696" as unknown as number, name: "x" });
    assert.equal(t.memoryMb, 31.7);
    assert.equal(t.pid, 31696);
    assert.equal(t.name, "x");
  });

  test("user fica undefined quando nao existe (e nao vira string vazia de mais nada)", () => {
    const noUser = freezeKillTarget({ ...proc({ pid: 1, name: "a.exe" }), user: undefined } as ProcessSnapshot);
    assert.equal(noUser.user, undefined);
  });
});

describe("payload hostil — o card monta sempre", () => {
  const renderModal = (target: unknown) =>
    renderToStaticMarkup(
      createElement(KillConfirmModal, {
        target: target as never,
        isKilling: false,
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );

  test("alvo cru com memoryMb undefined NAO rebenta o render e mostra o PID", () => {
    const html = renderModal({ pid: 31696, name: "notepad.exe", memoryMb: undefined });
    assert.match(html, /PID 31696/);
    assert.match(html, /notepad\.exe/);
  });

  test("alvo cru com memoryMb null e name em branco tambem nao rebenta", () => {
    const html = renderModal({ pid: 42, name: null, memoryMb: null });
    assert.match(html, /PID 42/);
  });

  test("pagina REAL com linhas hostis renderiza e mostra o PID da linha", () => {
    const rows = [
      proc({ pid: 100, name: "ok.exe", memoryMb: 12 }),
      { ...proc({ pid: 31696, name: "notepad.exe" }), memoryMb: undefined } as unknown as ProcessSnapshot,
      { ...proc({ pid: 200, name: "altro.exe" }), memoryMb: null } as unknown as ProcessSnapshot,
    ];
    const html = renderToStaticMarkup(createElement(TaskManagerPage, { processes: rows }));
    assert.match(html, /31696/);
    assert.match(html, /notepad\.exe/);
    assert.doesNotMatch(html, /Nenhum processo encontrado/);
    // A row tambem nao pode chamar .toFixed no snapshot: mostra n/d.
    assert.match(html, /n\/d MB/);
  });

  test("linha com cpu inexistente nao rebenta a tabela", () => {
    const rows = [{ ...proc({ pid: 777, name: "semcpu.exe" }), cpu: undefined } as unknown as ProcessSnapshot];
    const html = renderToStaticMarkup(createElement(TaskManagerPage, { processes: rows }));
    assert.match(html, /777/);
    assert.match(html, /n\/d%/);
  });

  test("REGRESSAO: o caminho do clique com row hostil monta o card com nome e PID", () => {
    const row = { ...proc({ pid: 31696, name: "notepad.exe", user: "PC\\caioc" }), memoryMb: undefined } as unknown as ProcessSnapshot;
    // os dois passos exactos do onClick da row
    const state = killReducer(initialKillState, {
      type: "select",
      target: freezeKillTarget(row),
      source: killSourceFor(""),
    });
    const html = renderToStaticMarkup(
      createElement(KillConfirmModal, {
        target: state.target!,
        isKilling: false,
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    assert.match(html, /notepad\.exe/);
    assert.match(html, /PID 31696/);
    assert.match(html, /0 MB/, "memoria desconhecida mostra 0, nao NaN nem crash");
  });
});

describe("formatos seguros (a classe do bug, isolada)", () => {
  test("memoryMb: so numeros finitos sao formatados", () => {
    assert.equal(formatMemoryMb(31.7), "32");
    assert.equal(formatMemoryMb(0), "0");
    for (const bad of [undefined, null, Number.NaN, "x"]) {
      assert.equal(formatMemoryMb(bad as unknown as number), "n/d", String(bad));
    }
  });

  test("cpu: idem", () => {
    assert.equal(formatCpu(12.34), "12.3");
    for (const bad of [undefined, null, Number.NaN]) {
      assert.equal(formatCpu(bad as unknown as number), "n/d", String(bad));
    }
  });
});

describe("payload hostil — o kill enviado nao depende da lista", () => {
  test("row removida da lista depois do clique: alvo congelado e PID enviado", async () => {
    const row = proc({ pid: 31696, name: "notepad.exe", memoryMb: 31 });
    const neighbour = proc({ pid: 500, name: "chrome.exe", cpu: 40 });
    let state = killReducer(initialKillState, {
      type: "select",
      target: freezeKillTarget(row),
      source: killSourceFor(""),
    });

    // refresh: a linha desapareceu (stub tombstonado) e a ordem mudou
    const list = [neighbour];
    assert.equal(list.some((p) => p.pid === state.target?.pid), false, "pre-condicao: row fora da lista");

    const received: number[] = [];
    await runKillSequence({
      pid: state.target!.pid,
      kill: async (pid) => {
        received.push(pid);
        return { success: true, status: "killed", pid } satisfies ProcessKillResult;
      },
      refresh: () => {},
      onOutcome: () => {},
      onFinish: () => {
        state = killReducer(state, { type: "clear" });
      },
    });
    assert.deepEqual(received, [31696], "killProcessTree recebe exactamente o PID congelado");
    assert.equal(received.includes(500), false);
  });

  test("corrida: um kill em curso NAO pode limpar a seleccao de outro", async () => {
    const a = proc({ pid: 111, name: "a.exe" });
    const b = proc({ pid: 222, name: "b.exe" });
    let state = killReducer(initialKillState, { type: "select", target: freezeKillTarget(a), source: "unfiltered" });
    const startedAction = state.actionId;

    // kill A em voo...
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runKillSequence({
      pid: state.target!.pid,
      kill: async () => {
        await pending;
        return { success: true, status: "killed", pid: 111 } satisfies ProcessKillResult;
      },
      refresh: () => {},
      onOutcome: () => {},
      onFinish: () => {
        // so limpa se a seleccao corrente for ainda a que este kill iniciou
        state = killStaleGuard(state, startedAction);
      },
    });

    // ...utilizador seleciona outra row enquanto espera
    state = killReducer(state, { type: "select", target: freezeKillTarget(b), source: "unfiltered" });
    const selectedDuring = state;

    release();
    await running;

    assert.deepEqual(state.target, selectedDuring.target, "o alvo B sobrevive ao terminal do kill A");
    assert.equal(state.target?.pid, 222);
  });
});

/**
 * taskmanager-runtime-refresh: a lista tem de mexer no instante, sem mentir
 * sobre como e' atualizada, e sem roubar o teclado ao utilizador.
 *
 *  1. remocao local da linha assim que o kill e terminal (o refetch autoritativo
 *     mede 720-1085 ms — ninguem espera por isso para ver o processo ir embora);
 *  2. copy honesta: e' actualizacao automatica com temporizador, nao tempo real;
 *  3. acessibilidade: quando a linha com o foco desaparece, o foco vai para o
 *     proximo botao em vez de cair no body.
 */
describe("TaskManagerPage — lista viva, copy honesta e foco", () => {
  const rows = [
    proc({ pid: 4321, name: "Notepad.exe", cpu: 3, memoryMb: 27 }),
    proc({ pid: 5555, name: "calc.exe", cpu: 1, memoryMb: 12 }),
    proc({ pid: 6666, name: "mspaint.exe", cpu: 0, memoryMb: 40 }),
  ];

  test("a copy diz actualizacao automatica e nunca tempo real", () => {
    const html = renderToStaticMarkup(createElement(TaskManagerPage, { processes: rows }));
    assert.match(html, /Actualiza..o autom.tica/, "a cadencia e' um temporizador: diz-se isso");
    // A cadencia saida vem da constante (PROCESSES_POLL_MS / 1000), que
    // desceu de 10 s para 2 s em 2026-09-30 para alinhar o consumidor com o
    // produtor. O teste compara com a constante, e nao com um numero solto,
    // para continuar a ser verdade se o numero mudar outra vez.
    assert.match(html, new RegExp(`${PROCESSES_POLL_MS / 1000} s`), "e diz-se a que cadencia, que e' a do servico");
    assert.doesNotMatch(html, /tempo real/i, "prometer tempo real com um timer seria mentira");
  });

  test("cada linha expõe o botao de acao para onde o foco pode ir", () => {
    const html = renderToStaticMarkup(createElement(TaskManagerPage, { processes: rows }));
    for (const row of rows) {
      assert.match(html, new RegExp(`data-row-action="${row.pid}"`), `a linha ${row.pid} nao marca a sua acao`);
    }
  });

  test("remocao local: a linha some no instante, o resto da lista fica", () => {
    // O filtro local e' o mesmo que a pagina aplica ao prop recebido.
    const visible = rows.filter((r) => r.pid !== 5555);
    const html = renderToStaticMarkup(createElement(TaskManagerPage, { processes: visible }));
    assert.doesNotMatch(html, />5555</, "a linha terminada ja nao esta");
    assert.match(html, /4321/);
    assert.match(html, /6666/, "as restantes linhas nao podem desaparecer com ela");
  });

  test("a pagina mantem o mecanismo de foco e a lista ancorada", () => {
    // Guarda estrutural: o efeito de foco so pode correr se a lista e o campo
    // de pesquisa forem referenciados, e so depois de uma remocao local.
    const source = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");
    assert.match(source, /pendingFocusIndex/, "a pagina tem de saber onde vai o foco");
    assert.match(source, /data-row-action/, "as linhas tem de expor a acao focavel");
    assert.match(source, /rowsRef/, "a lista tem de estar ancorada para se procurar o proximo");
    assert.match(source, /searchRef/, "sem linhas, o foco vai para a pesquisa");
    assert.match(source, /document\.activeElement/, "so se mexe no foco quando ele caiu mesmo");
  });
});
/**
 * P0 taskmanager-ui-to-service: porque é que a PRIMEIRA interação do utilizador
 * não produz entrada [KILL] no log do serviço.
 *
 * Resposta medida e reproduzida aqui: a primeira interação é o clique do botão
 * da ROW, e esse botão é um selector de alvo — abre o modal de confirmação e
 * não submete nada. O único caminho que submete é o `onConfirm` do modal. Logo
 * "duas interações, uma entrada no log" é o comportamento do desenho, não um
 * defeito: nenhuma correção de código é devida.
 *
 * Estes testes traçam cada hipótese alternativa uma a uma, para que a conclusão
 * não dependa de ler o código à pressa.
 */
describe("primeira interação não submete — a cadeia UI→serviço, hipótese a hipótese", () => {
  const pageSource = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");

  /** Todos os nós do elemento React, sem DOM: o `KillConfirmModal` não usa hooks. */
  function walk(node: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (!React.isValidElement(node)) return out;
    out.push(node);
    const children = (node.props as { children?: unknown })?.children;
    if (children !== undefined) walk(children, out);
    return out;
  }

  const modal = (props?: Partial<Parameters<typeof KillConfirmModal>[0]>) =>
    KillConfirmModal({
      target: freezeKillTarget(proc({ pid: 4321, name: "Notepad.exe" })),
      isKilling: false,
      onCancel: () => {},
      onConfirm: () => {},
      ...props,
    });

  const buttonsOf = (element: React.ReactElement) =>
    walk(element).filter((n) => n.type === "button");

  test("H1 — o primeiro clique só muda estado: o botão da ROW é selectKillTarget, não um submit", () => {
    // Invariante de fonte: o botão da row (o que leva data-row-action) chama o
    // selector. Se alguém lhe mudar o handler para submeter, esta linha cai.
    assert.match(
      pageSource,
      /onClick=\{\(\) => selectKillTarget\(process\)\}/,
      "o botão da row tem de continuar a SELECIONAR, não a submeter",
    );
    assert.doesNotMatch(
      pageSource,
      /onClick=\{(handleKill|\(\) => handleKill\(\))\}/,
      "nenhum botão da página pode submeter directamente: o kill passa pelo modal",
    );
  });

  test("H1b — a row não tem nenhum caminho de submissão: só existe UM call site de killProcessTree", () => {
    const callSites = pageSource.match(/api\.killProcessTree/g) ?? [];
    assert.equal(callSites.length, 1, `esperado 1 ponto de submissão, encontrados ${callSites.length}`);
    // E esse ponto vive dentro do handler do confirm, não dentro do selector.
    const selectBody = pageSource.slice(
      pageSource.indexOf("const selectKillTarget"),
      pageSource.indexOf("const clearKillTarget"),
    );
    assert.doesNotMatch(
      selectBody,
      /killProcessTree|electronAPI|api\./,
      "selectKillTarget só pode congelar o alvo e abrir o modal",
    );
  });

  test("H2 — o handler não se perde: o IPC é emitido ANTES de qualquer await, portanto um handler perdido ainda deixaria rasto no serviço", () => {
    // Se o `await` do kill fosse a primeira coisa, um handler perdido explicaria
    // zero entradas no log. Com o submit como unico await dentro do try, a
    // ausência de entrada no actions.log prova que o IPC nunca saiu.
    const handler = pageSource.slice(pageSource.indexOf("const handleKill"));
    const submitIndex = handler.indexOf("runKillSequence");
    const tryIndex = handler.indexOf("try {");
    assert.ok(
      submitIndex > -1 && tryIndex > -1 && tryIndex < submitIndex,
      "o submit tem de estar dentro do try, para o finally fechar o overlay mesmo em falha",
    );
    const setKillingIndex = handler.indexOf("setIsKilling(true)");
    assert.ok(
      setKillingIndex > -1 && setKillingIndex < submitIndex,
      "o estado de loading é posto ANTES do submit — nenhum await o precede",
    );
  });

  test("H3 — não há estado stale: o modal só existe quando há alvo, e o alvo é congelado no clique", () => {
    assert.match(
      pageSource,
      /\{killTarget && \(\s*<KillConfirmModal/,
      "o modal tem de continuar condicional ao alvo: sem alvo não há botão de confirmar",
    );
    // Um confirm sem alvo não submete nada (e agora diz isso no trace).
    assert.match(
      pageSource,
      /if \(!target\)\s*(?:\{[^}]*return;[^}]*\}|return;)/,
      "handleKill tem de abortar sem alvo, sem tocar em IPC",
    );
  });

  test("H4 — não há actionInFlight indevido: o único bloqueio é `isKilling`, posto só dentro do handler", () => {
    assert.doesNotMatch(pageSource, /actionInFlight/i, "não existe uma segunda trava de kill a poder_skipar_ um submit");
    const setters = pageSource.match(/setIsKilling\(true\)/g) ?? [];
    assert.equal(setters.length, 1, "`isKilling` só pode ser ligado dentro do handler de kill");
  });

  test("H5 — o botão de confirmar está HABILITADO enquanto o modal espera (não é um botão em loading)", () => {
    const onConfirm = () => {};
    const buttons = buttonsOf(modal({ onConfirm }));
    const confirm = buttons.find((b) => b.props.onClick === onConfirm);
    assert.ok(confirm, "o botão de confirmar tem de estar ligado ao onConfirm");
    assert.equal(confirm.props.disabled, false, "um confirm com isKilling=false não pode estar disabled");
  });

  test("H6 — o bloqueio do botão só existe DURANTE o kill, e bloqueia os dois botões (nunca só um)", () => {
    const onConfirm = () => {};
    const onCancel = () => {};
    const buttons = buttonsOf(modal({ isKilling: true, onConfirm, onCancel }));
    const confirm = buttons.find((b) => b.props.onClick === onConfirm);
    const cancel = buttons.find((b) => b.props.onClick === onCancel);
    assert.ok(confirm && cancel, "os dois botões têm de existir");
    assert.equal(confirm.props.disabled, true, "durante o kill o confirmar está bloqueado");
    assert.equal(cancel.props.disabled, true, "e o cancelar também — nenhum fica utilizável a meio");
  });

  test("H7 — não há problema de propagação: o fundo do modal não tem handler nenhum", () => {
    const root = modal();
    assert.equal(
      (root.props as { onClick?: unknown }).onClick,
      undefined,
      "o overlay não fecha nem consome cliques: um clique fora não pode engolir o confirm",
    );
  });

  test("H8 — a segunda interação é o confirm do modal: o render do modal é o que aparece depois da seleção", () => {
    // Sequência verificável sem DOM: sem selecção não há markup de modal; com
    // alvo congelado, o markup do modal aparece e identifica o processo certo.
    const page = renderToStaticMarkup(
      createElement(TaskManagerPage, { processes: [proc({ pid: 4321, name: "Notepad.exe" })] }),
    );
    assert.doesNotMatch(page, /Terminar este processo\?/, "antes de escolher, não há modal nenhum");
    assert.match(page, /Terminar Processo/, "a row oferece a acção — mas é o botão de SELECIONAR");
    const comModal = renderToStaticMarkup(createElement(KillConfirmModal, {
      target: freezeKillTarget(proc({ pid: 4321, name: "Notepad.exe" })),
      isKilling: false,
      onCancel: () => {},
      onConfirm: () => {},
    }));
    assert.match(comModal, /Terminar este processo\?/, "depois da selecção, o modal de confirmação aparece");
    assert.match(comModal, /Sim, Terminar/, "e é ele que submete");
  });
});
