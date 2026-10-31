import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isProcessesEvent,
  isTerminalKillOutcome,
  KILL_ALREADY_EXITED_TEXT,
  KILL_ALIAS_STUB_ERROR,
  KILL_ERROR_ERROR,
  KILL_ACCESS_DENIED_ERROR,
  KILL_FAILED_ERROR,
  KILL_PROTECTED_ERROR,
  KILL_SUCCESS_MESSAGE,
  KILL_PROTECTED_REASON_MESSAGE,
  KILL_REUSED_ERROR,
  KILL_TIMEOUT_ERROR,
  KILL_TIMEOUT_MS,
  KILL_UNAVAILABLE_ERROR,
  mapKillResult,
  pidsConfirmedGone,
  PROCESSES_POLL_MS,
  PROCESSES_REFRESH_COALESCE_MS,
  resolveEventRefresh,
  runKillProcess,
  shouldRefreshProcessesNow,
  shouldRefetchAfterKill,
  withoutPids,
} from "../src/lib/processActions";
import type { ProcessSnapshot } from "@cybersafe/shared-types";
import type { ProcessKillResult } from "@cybersafe/shared-types";

/**
 * Regressão do "excluir" no Gestor de Tarefas.
 *
 * Bug manual: excluir deixava a página preta/vazia (overlay de kill preso) e a
 * tarefa reaparecia ao voltar. O renderer precisa de (a) um prazo máximo para o
 * kill, de modo a fechar sempre o overlay, (b) refetch autoritativo do snapshot
 * — sem remoção otimista, e (c) mensagens específicas por status do backend
 * (protected, timeout, reused, alias-stub, failed, already-exited), nunca um
 * erro genérico.
 */

const result = (overrides: Partial<ProcessKillResult>): ProcessKillResult => ({
  success: false,
  status: "failed",
  pid: 4242,
  ...overrides,
});

describe("mapKillResult — status estruturado vira mensagem específica", () => {
  test("killed → sucesso COM feedback (uma tentativa nunca acaba em silêncio)", () => {
    const outcome = mapKillResult(result({ status: "killed", success: true }));
    assert.equal(outcome.status, "killed");
    assert.equal(outcome.success, true);
    // Este teste fixava `message === null` e o próprio nome dizia "sucesso
    // silencioso". Era o bug: o utilizador carregava em Terminar e o caminho
    // de sucesso não devolvia feedback nenhum. A expectativa mudou; a dureza
    // não — agora é igualdade EXATA com a mensagem de sucesso, o que apanha
    // tanto uma mensagem vazia como uma que volte a prometer subprocessos.
    assert.equal(outcome.message, KILL_SUCCESS_MESSAGE);
    assert.doesNotMatch(outcome.message ?? "", /subprocess/i, "sem prova por filho, não se afirma");
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
    // KILL-UX: com `protectedReason` conhecido, a mensagem é a DA razão
    // (`self`), não a frase genérica. Esta asserção fixava antes
    // `KILL_PROTECTED_ERROR` mesmo com a razão no contrato — era a prova
    // escrita de que o dado chegava e era deitado fora. Passou a exigir o
    // texto específico: mesma dureza, EXPECTativa nova.
    assert.equal(outcome.message, KILL_PROTECTED_REASON_MESSAGE.self);
    assert.notEqual(outcome.message, KILL_PROTECTED_ERROR);
    assert.match(outcome.message ?? "", /próprio serviço de proteção/i);
  });

  test("protected SEM protectedReason → frase genérica honesta (não inventa razão)", () => {
    const outcome = mapKillResult(result({ status: "protected" }));
    assert.equal(outcome.message, KILL_PROTECTED_ERROR);
    assert.equal(outcome.protectedReason, undefined, "não pode inventar uma razão");
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

  // O `success` do backend nunca é lido: quem decide é o `status`. Um reused
  // com success:true nao pode virar sucesso na UI, e um already-exited com
  // success:false nao pode virar erro.
  test("o status manda: o success do backend nunca decide o desfecho mostrado", () => {
    const reused = mapKillResult(result({ status: "reused", success: true }));
    assert.equal(reused.success, false, "PID reutilizado nunca é sucesso no renderer");
    assert.equal(reused.message, KILL_REUSED_ERROR);

    const exited = mapKillResult(result({ status: "already-exited", success: false }));
    assert.equal(exited.success, true, "ja nao estar em execucao e o objetivo, nao um erro");
    assert.equal(exited.message, KILL_ALREADY_EXITED_TEXT);
  });

  test("failed → usa a mensagem do backend quando existe", () => {
    const outcome = mapKillResult(result({ status: "failed", error: "access denied" }));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.message, "access denied");

    const fallback = mapKillResult(result({ status: "failed" }));
    assert.equal(fallback.message, KILL_FAILED_ERROR);
  });

  test("access-denied → mensagem específica do Windows ter recusado (nunca a genérica)", () => {
    const outcome = mapKillResult(result({ status: "access-denied", exitCode: 5 }));
    assert.equal(outcome.status, "access-denied");
    assert.equal(outcome.success, false);
    assert.equal(outcome.message, KILL_ACCESS_DENIED_ERROR);
    assert.match(outcome.message ?? "", /acesso negado|recusou/i);
    assert.notEqual(outcome.message, KILL_FAILED_ERROR);
  });

  test("access-denied com diagnóstico real do taskkill chega ao utilizador", () => {
    const outcome = mapKillResult(
      result({
        status: "access-denied",
        exitCode: 5,
        error: 'ERROR: The process "123" could not be terminated. Reason: Access is denied.',
      }),
    );
    assert.match(outcome.message ?? "", /Access is denied/);
  });

  test("access-denied não refetch: o processo ficou intacto", () => {
    assert.equal(
      shouldRefetchAfterKill({ status: "access-denied", pid: 1, success: false, message: KILL_ACCESS_DENIED_ERROR }),
      false,
    );
  });

  // P5: o serviço distingue "matei o lançador, a app real está viva noutro PID"
  // (Notepad/MSIX no Windows 11). Antes disto `alias-stub` caía no `default` →
  // "falha genérica" SEM refetch: a linha do PID morto ficava na lista e o PID
  // real nunca aparecia. É o "um run nunca acabou" do teste manual.
  test("alias-stub → mensagem do backend (com o PID real), nunca falha genérica", () => {
    const backendError =
      "O PID 4321 era um stub/App Execution Alias do Windows; o processo real com a mesma identidade está vivo no PID 4322 — termina esse PID.";
    const outcome = mapKillResult(result({ status: "alias-stub", pid: 4321, error: backendError }));
    assert.equal(outcome.status, "alias-stub");
    assert.equal(outcome.success, false);
    assert.equal(outcome.message, backendError, "a mensagem do serviço é o que diz ao utilizador qual é o PID real");
    assert.equal(shouldRefetchAfterKill(outcome), true, "o serviço já tirou o PID morto do cache — a lista tem de ser relida");
  });

  test("alias-stub sem error do backend tem copy própria (e cai para ela)", () => {
    const outcome = mapKillResult(result({ status: "alias-stub", pid: 1 }));
    assert.equal(outcome.message, KILL_ALIAS_STUB_ERROR);
    assert.notEqual(outcome.message, KILL_FAILED_ERROR);
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
    // "Tal como vem" passou a incluir a mensagem de sucesso: o `status` e o
    // `success` propagam-se como antes, e o que faltava era o feedback.
    assert.equal(outcome.message, KILL_SUCCESS_MESSAGE);
  });

  test("protected do backend chega à UI com a mensagem certa", async () => {
    const outcome = await runKillProcess({
      pid: 7,
      kill: async () => result({ pid: 7, status: "protected", protectedReason: "ancestor" }),
    });
    assert.equal(outcome.status, "protected");
    // KILL-UX: `ancestor` diz "é o processo que iniciou o CyberSafe". A
    // frase genérica deixava de distinguir isto do resto.
    assert.equal(outcome.message, KILL_PROTECTED_REASON_MESSAGE.ancestor);
    assert.equal(outcome.protectedReason, "ancestor");
  });

  test("alias-stub do backend chega à UI como alias-stub (não como failed)", async () => {
    const outcome = await runKillProcess({
      pid: 8,
      kill: async () => result({ pid: 8, status: "alias-stub", error: "processo real no PID 900" }),
    });
    assert.equal(outcome.status, "alias-stub");
    assert.equal(outcome.success, false);
    assert.match(outcome.message ?? "", /PID 900/);
    assert.equal(shouldRefetchAfterKill(outcome), true);
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

  // Pior caso do serviço = orcamento (12 000) + piso do reap (2 000). Se o
  // renderer desistisse antes disso, um kill que FUNCIONOU aparecia como
  // timeout ao utilizador. O contrato com o serviço e testado em
  // packages/service/test/kill-budget.test.js, que le as mesmas parcelas.
  test("o prazo do renderer cobre o pior caso do serviço", () => {
    const serviceWorstCase = 12_000 + 2_000;
    assert.ok(
      KILL_TIMEOUT_MS > serviceWorstCase,
      `prazo do renderer (${KILL_TIMEOUT_MS} ms) tem de passar o pior caso do servico (${serviceWorstCase} ms)`,
    );
  });
});

describe("shouldRefetchAfterKill — snapshot autoritativo", () => {
  test("killed, already-exited e timeout exigem refetch", () => {
    assert.equal(shouldRefetchAfterKill({ status: "killed", pid: 1, success: true, message: null }), true);
    assert.equal(shouldRefetchAfterKill({ status: "already-exited", pid: 1, success: true, message: KILL_ALREADY_EXITED_TEXT }), true);
    assert.equal(shouldRefetchAfterKill({ status: "timeout", pid: 1, success: false, message: KILL_TIMEOUT_ERROR }), true);
  });

  test("reused também exige: o serviço tirou do cache a entrada do dono antigo", () => {
    // P3 mudou o serviço: num PID reutilizado a linha em cache é de outro
    // processo e sai, com a janela de frescura invalidada. Sem refetch a UI
    // ficaria com um fantasma até ao próximo evento.
    assert.equal(shouldRefetchAfterKill({ status: "reused", pid: 1, success: false, message: KILL_REUSED_ERROR }), true);
  });

  test("protected/failed/unavailable não mexeram no processo: sem refetch", () => {
    assert.equal(shouldRefetchAfterKill({ status: "protected", pid: 1, success: false, message: KILL_PROTECTED_ERROR }), false);
    assert.equal(shouldRefetchAfterKill({ status: "failed", pid: 1, success: false, message: KILL_FAILED_ERROR }), false);
    assert.equal(shouldRefetchAfterKill({ status: "unavailable", pid: 1, success: false, message: KILL_UNAVAILABLE_ERROR }), false);
  });
});

/**
 * Actualização da LISTA de processos (taskmanager-runtime-refresh).
 *
 * Números medidos nesta máquina: enumeração completa (`processes.list`)
 * 720-1085 ms, poll do serviço 648-747 ms de 10 em 10 s, e um poll inicial que
 * emitiu 177 `process.started` de uma vez. A rajada de arranque custava 7
 * pedidos IPC por evento (o `fetchSnapshot` completo) — daí estas guardas.
 */
describe("actualização da lista de processos — sem tempestade, sem trabalho deitado fora", () => {
  test("eventos de processos nunca sao confundidos com os outros", () => {
    // Regra por PREFIXO: qualquer `process.*` e' da lista. Um sufixo novo nao
    // pode escapar e cair no snapshot completo sem ninguem dar por isso.
    for (const type of ["process.started", "process.exited", "process.blocked", "process.kiado-amanha"]) {
      assert.equal(isProcessesEvent(type), true, type);
    }
    for (const type of ["scan.progress", "threat.detected", "artifact.analyzed", "file.created"]) {
      assert.equal(isProcessesEvent(type), false, `${type} nao e um evento de lista`);
    }
  });

  test("pedido em voo, aba escondida ou shutdown nao abrem um pedido novo", () => {
    const base = { visible: true, shuttingDown: false, lastRequestedAt: 0, now: 10_000 };
    assert.equal(shouldRefreshProcessesNow({ ...base, inFlight: true }), false, "pedido em voo");
    assert.equal(shouldRefreshProcessesNow({ ...base, inFlight: false, visible: false }), false, "aba escondida");
    assert.equal(shouldRefreshProcessesNow({ ...base, inFlight: false, shuttingDown: true }), false, "shutdown");
  });

  test("a janela de rajada agrupa a onda seguinte num unico pedido no fim", () => {
    // Rajada: o primeiro evento abre a janela, os restantes caem dentro dela.
    // A janela conta-se a partir do ultimo pedido, logo so o primeiro da
    // rajada passa e o resto sai num pedido so no fim da janela.
    assert.equal(
      shouldRefreshProcessesNow({ inFlight: false, visible: true, shuttingDown: false, lastRequestedAt: 0, now: 1_000 }),
      true,
      "a primeira onda passa",
    );
    for (let i = 1; i <= 176; i++) {
      const t = 1_000 + i;
      assert.equal(
        shouldRefreshProcessesNow({ inFlight: false, visible: true, shuttingDown: false, lastRequestedAt: t - 1, now: t }),
        false,
        `evento ${i} da rajada nao pode abrir um pedido proprio`,
      );
    }
    // Passada a janela, o proximo evento volta a poder pedir.
    assert.equal(
      shouldRefreshProcessesNow({
        inFlight: false,
        visible: true,
        shuttingDown: false,
        lastRequestedAt: 1_000,
        now: 1_000 + PROCESSES_REFRESH_COALESCE_MS,
      }),
      true,
    );
  });

  test("a cadencia esta alinhada com a do servico, e um poll mais rapido nao paga enumeracoes", () => {
    // REGRA INVERTIDA em 2026-09-30, com medicao. A versao anterior deste teste
    // exigia `PROCESSES_POLL_MS >= 10 000` com a razao "o poll do renderer nao
    // pode ser mais rapido que o do servico, senao paga enumeracoes (~800 ms
    // cada) para mostrar a mesma verdade".
    //
    // A PREMISA estava errada, e e a premissa que caiu, nao a prudencia:
    //  1. o poll do renderer e um pedido IPC de LEITURA DE CACHE. Nao e uma
    //     enumeracao do SO. Quem enumera e o cadence adaptativo do servico;
    //  2. com o poll a marcar observador, o cache fica com ~2 s de idade, muito
    //     abaixo do TTL de 20 s: o servico responde de cache e nao forca SO.
    //     Medido em service/test/process-kill.test.js: 2 s e 10 s dao o MESMO
    //     numero de enumeracoes em 60 s (o TTL e que manda, nao o poll);
    //  3. o custo real de uma enumeracao e mediana 591 ms, nao ~800 ms.
    //
    // E o ganho era real: com o poll a 10 s, o servico descobria o processo em
    // ~2,1 s mas o ecra so o mostrava ~5 s depois, em media. Ler atrasado da
    // verdade e o que o utilizador sentiu.
    assert.ok(PROCESSES_POLL_MS <= 2_000, `cadencia ${PROCESSES_POLL_MS} ms volta a ler a verdade atrasada`);
    // E a janela de rajada tem de ser pequena face a uma enumeracao: 250 ms
    // contra mediana 591 ms medida, ou seja ~42% da mais rapida. Uma janela que
    // se aproximasse de uma enumeracao esconderia mudancas que o utilizador
    // sente (uma saida de processo demoraria ate 591 ms a aparecer).
    assert.ok(
      PROCESSES_REFRESH_COALESCE_MS <= 591 * 0.5,
      `janela de ${PROCESSES_REFRESH_COALESCE_MS} ms ja tapa uma enumeracao (mediana 591 ms)`,
    );
  });

  const rows = [
    { pid: 1, name: "a.exe" },
    { pid: 2, name: "b.exe" },
    { pid: 3, name: "c.exe" },
  ];

  test("a remocao local tira so o PID, e a verdade desfaz o filtro", () => {
    assert.deepEqual(withoutPids(rows, [2]).map((r) => r.pid), [1, 3]);
    assert.deepEqual(withoutPids(rows, []), rows, "sem remocoes a lista e a mesma");
    // O snapshot autoritativo ja nao traz o PID: pode-se esquecer o filtro.
    assert.deepEqual(pidsConfirmedGone([rows[0], rows[2]], [2]), [2]);
    // Se o snapshot ainda trouxer o PID, a verdade manda: a linha volta.
    assert.deepEqual(pidsConfirmedGone(rows, [2]), []);
  });

  test("so morto ou ja nao estava retiram a linha", () => {
    assert.equal(isTerminalKillOutcome({ status: "killed", pid: 1, success: true, message: null }), true);
    assert.equal(
      isTerminalKillOutcome({ status: "already-exited", pid: 1, success: true, message: KILL_ALREADY_EXITED_TEXT }),
      true,
    );
    // Estas tres NAO podem apagar a linha: o estado real e desconhecido
    // (timeout), e outro dono (reused), ou a recusa foi do proprio CyberSafe.
    for (const outcome of [
      { status: "timeout", pid: 1, success: false, message: KILL_TIMEOUT_ERROR },
      { status: "reused", pid: 1, success: false, message: KILL_REUSED_ERROR },
      { status: "protected", pid: 1, success: false, message: KILL_PROTECTED_ERROR },
    ] as KillOutcome[]) {
      assert.equal(isTerminalKillOutcome(outcome), false, `${outcome.status} nao pode retirar a linha`);
    }
  });

  test("o helper de lista nao tropeca em linhas invalidas", () => {
    const partial = [{ pid: 7 }] as ProcessSnapshot[];
    assert.deepEqual(withoutPids(partial, [7]), []);
  });
});

/**
 * Tabela de rota dos eventos (taskmanager-runtime-refresh).
 *
 * Não há DOM nem jsdom neste package: o invariant "nenhum evento de processos
 * dispara o snapshot global" prova-se na DECISÃO pura que o App consome
 * (`resolveEventRefresh`), não montando o App. Estes testes executam a função
 * real: se a rota mudar, caem.
 *
 * Regra medida que justifica: o poll inicial do serviço emitiu 177
 * `process.started` num único poll (747,2 ms), e cada evento fazia
 * `fetchSnapshot` = 7 pedidos IPC.
 */
describe("resolveEventRefresh — a decisão que o App consome", () => {
  /** Simula o handler: rota + janela de agrupamento + guarda de pedido em voo. */
  function simulate(events: { type: string; at: number }[]) {
    const counts = { processes: 0, snapshots: 0, none: 0 };
    let windowOpenUntil: number | null = null;
    let inFlightUntil = 0;
    const ordered = [...events].sort((a, b) => a.at - b.at);
    for (const event of ordered) {
      const route = resolveEventRefresh(event.type);
      if (route === "none") {
        counts.none += 1;
        continue;
      }
      if (route === "snapshot") {
        counts.snapshots += 1;
        // Um snapshot completo traz a lista: custa 7 pedidos IPC e a lista
        // responde em ~720-1085 ms, logo fica em voo nesse intervalo.
        inFlightUntil = Math.max(inFlightUntil, event.at + 800);
        continue;
      }
      // "processes": passa pela janela de agrupamento e pela guarda de voo.
      if (windowOpenUntil !== null && event.at < windowOpenUntil) continue;
      if (event.at < inFlightUntil) continue;
      if (
        !shouldRefreshProcessesNow({
          inFlight: false,
          visible: true,
          shuttingDown: false,
          lastRequestedAt: event.at - PROCESSES_REFRESH_COALESCE_MS,
          now: event.at,
        })
      ) {
        continue;
      }
      counts.processes += 1;
      windowOpenUntil = event.at + PROCESSES_REFRESH_COALESCE_MS;
      inFlightUntil = event.at + 800; // o pedido em voo
    }
    return counts;
  }

  const burst = (type: string, n: number, spreadMs = 0) =>
    Array.from({ length: n }, (_, i) => ({ type, at: i * spreadMs }));

  test("1. rajada de process.started: N seguidas pedem a lista, nunca o snapshot", () => {
    for (let n = 1; n <= 200; n += 7) {
      const c = simulate(burst("process.started", n));
      assert.equal(c.snapshots, 0, `${n} process.started deram ${c.snapshots} snapshots completos`);
      assert.ok(c.processes >= 1, `${n} process.started nao pediram a lista`);
    }
  });

  test("2. rajada de process.exited: o mesmo, e a lista tem de ser relida", () => {
    for (let n = 1; n <= 200; n += 7) {
      const c = simulate(burst("process.exited", n));
      assert.equal(c.snapshots, 0, `${n} process.exited deram ${c.snapshots} snapshots completos`);
      assert.ok(c.processes >= 1, `${n} process.exited nao pediram a lista`);
    }
  });

  test("3. coalescing: N no mesmo instante dá 1 refresh, e o número não cresce com N", () => {
    const sizes = [1, 5, 25, 177, 1_000];
    const refreshes = sizes.map((n) => simulate(burst("process.started", n, 0)).processes);
    for (const n of sizes) {
      assert.equal(
        simulate(burst("process.started", n, 0)).processes,
        1,
        `${n} eventos no MESMO instante tem de dar 1 refresh`,
      );
    }
    assert.equal(new Set(refreshes).size, 1, `o refresh cresceu com N: ${sizes.map((n, i) => `${n}=>${refreshes[i]}`).join(", ")}`);
  });

  test("4. processo novo aparece: o arranque pede a lista, e a lista traz a linha nova", () => {
    // Um processo novo = um `process.started`. A rota tem de ser a lista, e o
    // pedido tem de acontecer mesmo no meio de uma rajada.
    const c = simulate(burst("process.started", 177, 4));
    assert.equal(c.snapshots, 0);
    assert.equal(c.processes, 1, "a rajada de arranque tem de dar UM pedido de lista");
    // E um evento isolado, muito depois, volta a poder pedir.
    const later = simulate([{ type: "process.started", at: 60_000 }]);
    assert.equal(later.processes, 1, "um processo novo isolado tem de pedir a lista");
  });

  test("5. processo encerrado desaparece: o exit também lê a lista", () => {
    const c = simulate([{ type: "process.exited", at: 30_000 }]);
    assert.equal(c.processes, 1, "um processo que sai tem de ser relido da lista");
    assert.equal(c.snapshots, 0, "sair nao e motivo para um snapshot completo");
  });

  test("6. tabela completa, por exaustão", () => {
    // Todos os tipos que o serviço publica hoje (engine.ts: eventBus.publish).
    const published = [
      "file.created",
      "file.modified",
      "file.deleted",
      "file.renamed",
      "quarantine.requested",
      "quarantine.added",
      "quarantine.failed",
      "engine.health",
      "protection.changed",
      "registry.persistence.changed",
      "process.started",
      "process.exited",
      "process.blocked",
      "script.blocked",
      "threat.detected",
      "artifact.analyzed",
      "scan.progress",
    ];
    const expected: Record<string, string> = {
      "file.created": "none",
      "file.modified": "none",
      "file.deleted": "none",
      "file.renamed": "none",
      "quarantine.requested": "none",
      "quarantine.added": "snapshot",
      "quarantine.failed": "snapshot",
      "engine.health": "snapshot",
      "protection.changed": "snapshot",
      "registry.persistence.changed": "snapshot",
      "process.started": "processes",
      "process.exited": "processes",
      // Decisão deliberada: um script bloqueado é um evento `process.*`, e a
      // lista é o que o rota por prefixo manda. O aviso de bloqueado é
      // mostrado na mesma (o toast vive antes desta rota).
      "process.blocked": "processes",
      "script.blocked": "snapshot",
      "threat.detected": "snapshot",
      "artifact.analyzed": "none",
      "scan.progress": "none",
    };
    for (const type of published) {
      assert.equal(resolveEventRefresh(type), expected[type], `rota errada para ${type}`);
    }
    // Invariante por prefixo: NENHUM `process.*` cai em snapshot, com qualquer
    // sufixo — mesmo um que ninguém viu ainda.
    for (const suffix of ["started", "exited", "blocked", "killed", "criado-amanha", "xyz"]) {
      assert.equal(resolveEventRefresh(`process.${suffix}`), "processes", `process.${suffix} caiu fora da lista`);
    }
    // E `scan.progress` não pede nada, nem quando chumba de uma família:
    for (const type of ["scan.progress", "scan.progress.lote", "scan.progressX"]) {
      assert.notEqual(resolveEventRefresh(type), "processes", `${type} pediu a lista`);
    }
  });
});
