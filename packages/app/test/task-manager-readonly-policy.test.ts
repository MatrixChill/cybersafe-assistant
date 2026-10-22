import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as PROCESS_ACTIONS from "../src/lib/processActions";
import type { ProcessKillResult } from "@cybersafe/shared-types";

/**
 * P0 pós-corrida manual m1b — recusa nomeada da fronteira Windows read-only.
 *
 * O que aconteceu de facto (prova em `post-manual-p0/…`, leitura de fontes e logs):
 * no `Gestor de Tarefas` do run isolado, o pedido `service:kill-process-tree` foi
 * recusado **no processo main do Electron**, antes de chegar ao serviço:
 *   `Error occurred in handler for 'service:kill-process-tree':
 *    FronteiraWindowsReadOnlyError: dev_windows_readonly: efeito_negado_por_modo_leitura`
 * O `service/error.log` da mesma corrida não tem UM único registo de `process.killTree`
 * — ou seja, nenhum processo foi morto e o motor nunca foi contactado.
 *
 * No renderer essa rejeição cai no `catch` de `runKillProcess` e hoje é devolvida como
 * `{ status: "failed", message: "Erro ao terminar processo." }`. Isso é falso nas duas
 * direções: sugere que um terminate foi tentado e falhou, e deixa o utilizador a
 *carregar outra vez na mesma ação já recusada.
 *
 * Este ficheiro é o RED: descreve o comportamento exigido (reconhecer SÓ a recusa
 * nomeada, incluindo o envelope exacto do Electron; mensagem «indisponível nesta
 * sessão»; bloquear novas tentativas desta ação depois da recusa) sem tocar nas
 * guardas, sem inventar modo no renderer e sem alterar serviço/bridge.
 */

type Classificar = ((erro: unknown) => "dev_windows_readonly" | null) | undefined;

/** Forma do desfecho que os callbacks recebem — declarada à mão para o teste não depender de tipos novos. */
type KillOutcomeLike = { status: string; pid: number; success: boolean; message: string | null };

/** Módulo como namespace: permite falhar por asserção quando um export ainda não existe. */
const classificarRejeicaoKill = (PROCESS_ACTIONS as Record<string, unknown>)
  .classifyKillRejection as Classificar;

/** Envelope exacto que o `ipcRenderer.invoke` recebe quando o handler do main rejeita. */
const ENVELOPE_ELECTRON =
  "Error occurred in handler for 'service:kill-process-tree': FronteiraWindowsReadOnlyError: " +
  "dev_windows_readonly: efeito_negado_por_modo_leitura";

const MENSAGEM_FRONTEIRA = "dev_windows_readonly: efeito_negado_por_modo_leitura";

const KILL_NUNCA_CHAMADO = { status: "killed", pid: 1, success: true } as unknown as ProcessKillResult;

async function rejeicaoKill(mensagem: string) {
  const { runKillProcess } = PROCESS_ACTIONS;
  return runKillProcess({
    pid: 4242,
    kill: async () => {
      throw new Error(mensagem);
    },
  });
}

describe("recusa nomeada da fronteira read-only — classificação", () => {
  test("existe um classificador de rejeições do kill (RED: ainda não existe)", () => {
    assert.equal(
      typeof classificarRejeicaoKill,
      "function",
      "RED: `classifyKillRejection` ainda não é exportado por processActions",
    );
  });

  test("reconhece o envelope exacto do Electron", () => {
    if (typeof classificarRejeicaoKill !== "function") return assert.fail("RED: sem classificador");
    assert.equal(classificarRejeicaoKill(new Error(ENVELOPE_ELECTRON)), "dev_windows_readonly");
  });

  test("reconhece a mensagem nua da fronteira", () => {
    if (typeof classificarRejeicaoKill !== "function") return assert.fail("RED: sem classificador");
    assert.equal(classificarRejeicaoKill(new Error(MENSAGEM_FRONTEIRA)), "dev_windows_readonly");
  });

  test("NÃO reconhece falhas quaisquer — não se afrouxa a classificação", () => {
    if (typeof classificarRejeicaoKill !== "function") return assert.fail("RED: sem classificador");
    for (const mensagem of [
      "Error occurred in handler for 'service:analyze-process': TypeError: x is not a function",
      "connect ECONNRESET 127.0.0.1:pipe-cybersafe",
      "process.killTree: access denied",
      "dev_windows_readonly: metodo_nao_e_leitura_permitida_neste_modo", // método não-listado, não este efeito
      "",
    ]) {
      assert.equal(classificarRejeicaoKill(new Error(mensagem)), null, `falsa correspondência: ${mensagem}`);
    }
    assert.equal(classificarRejeicaoKill(undefined), null);
    assert.equal(classificarRejeicaoKill({ mensagem: ENVELOPE_ELECTRON }), null);
  });
});

describe("desfecho mostrado ao utilizador", () => {
  test("recusa read-only deixa de ser «Erro ao terminar processo»", async () => {
    const outcome = await rejeicaoKill(ENVELOPE_ELECTRON);
    assert.equal(
      outcome.status,
      "unavailable",
      `RED: a recusa veio como "${outcome.status}" — uma recusa de guarda não é um terminate falhado`,
    );
    assert.equal(outcome.success, false);
    assert.match(outcome.message ?? "", /indisponível nesta sessão/i);
    assert.match(outcome.message ?? "", /modo de leitura/i);
    assert.doesNotMatch(outcome.message ?? "", /Erro ao terminar processo/);
    // Honestidade sobre o efeito: nada foi morto, nada foi alterado no Windows.
    assert.match(outcome.message ?? "", /nenhum processo/i);
  });

  test("a mensagem distingue-se de um terminate falhado real", async () => {
    const recusada = await rejeicaoKill(ENVELOPE_ELECTRON);
    const { KILL_ERROR_ERROR } = PROCESS_ACTIONS as Record<string, unknown>;
    assert.notEqual(recusada.message, KILL_ERROR_ERROR);
  });

  test("falha real continua `failed` (nada é mascarado)", async () => {
    const { runKillProcess } = PROCESS_ACTIONS;
    const falha = await runKillProcess({
      pid: 7,
      kill: async () => {
        throw new Error("connect ECONNRESET");
      },
    });
    assert.equal(falha.status, "failed");
    const timeout = await runKillProcess({
      pid: 8,
      timeoutMs: 5,
      kill: () => new Promise<ProcessKillResult>(() => {}),
    });
    assert.equal(timeout.status, "timeout");
  });

  test("recusa não provoca refetch: o Windows não mudou de estado", () => {
    const { shouldRefetchAfterKill } = PROCESS_ACTIONS;
    assert.equal(
      shouldRefetchAfterKill({
        status: "unavailable",
        pid: 1,
        success: false,
        message: "x",
      } as never),
      false,
    );
  });
});

describe("bloquear novas tentativas desta ação depois da recusa", () => {
  test("segundo clique não volta a pedir o kill (mesmo `gate` partilhado)", async () => {
    const { runKillRequest } = PROCESS_ACTIONS;
    let chamadas = 0;
    const gate = { inFlight: false };
    const base = {
      pid: 9999,
      kill: async () => {
        chamadas += 1;
        throw new Error(ENVELOPE_ELECTRON);
      },
      refresh: () => {},
      onFinish: () => {},
      gate,
    };
    const primeiro = await runKillRequest(base);
    assert.equal(primeiro.status, "unavailable", `RED: primeiro desfecho "${primeiro.status}"`);
    assert.equal(chamadas, 1);

    const segundo = await runKillRequest(base);
    assert.equal(
      chamadas,
      1,
      `RED: a ação já recusada voltou a ser pedida ${chamadas} vezes — continua a bater na mesma guarda`,
    );
    assert.equal(segundo.status, "unavailable");
    assert.match(segundo.message ?? "", /indisponível nesta sessão/i);
    // O `gate` tem de voltar a ficar livre para OUTRA ação (outro PID), sem ficar preso.
    assert.equal(gate.inFlight, false);
  });

  test("outros kills continuam a poder ser tentados até haver recusa", async () => {
    const { runKillRequest } = PROCESS_ACTIONS;
    let chamadas = 0;
    const gate = { inFlight: false };
    const sucesso = await runKillRequest({
      pid: 1,
      kill: async (): Promise<ProcessKillResult> => {
        chamadas += 1;
        return KILL_NUNCA_CHAMADO;
      },
      refresh: () => {},
      onFinish: () => {},
      gate,
    });
    assert.equal(sucesso.status, "killed");
    assert.equal(chamadas, 1);
  });
});

describe("entrega do desfecho na tentativa já recusada — review P0A", () => {
  /**
   * O ramo `readonlyRefused` existia só como retorno antecipado. A página limpa o
   * `killNotice` ANTES de chamar e só escreve a mensagem dentro de `onOutcome`
   * (`TaskManagerPage.tsx:480` e `:498`), por isso uma segunda tentativa devolvia
   * a mensagem certa para o sítio errado: ecrã sem aviso nenhum. Uma mensagem
   * declarada e não entregue é a mesma mentira, só mais silenciosa.
   */
  test("2ª tentativa entrega onOutcome+onFinish, sem novo RPC e sem refetch", async () => {
    const { runKillRequest } = PROCESS_ACTIONS;
    let pedidos = 0;
    let refetches = 0;
    const entregas: string[] = [];
    let terminos = 0;
    const gate = { inFlight: false };
    const deps = {
      pid: 5555,
      kill: async () => {
        pedidos += 1;
        throw new Error(ENVELOPE_ELECTRON);
      },
      refresh: () => {
        refetches += 1;
      },
      onOutcome: (o: KillOutcomeLike) => {
        entregas.push(o.message ?? "<sem mensagem>");
      },
      onFinish: () => {
        terminos += 1;
      },
      gate,
    };

    await runKillRequest(deps);
    assert.equal(pedidos, 1);
    assert.equal(entregas.length, 1, "a primeira tentativa tem de entregar");
    assert.equal(terminos, 1);

    await runKillRequest(deps);
    assert.equal(pedidos, 1, "a recusa conhecida voltou a emitir RPC");
    assert.equal(refetches, 0, "recusa não muda o Windows: nada de refetch");
    assert.equal(
      entregas.length,
      2,
      `RED: a 2ª tentativa não entregou onOutcome (entregas=${entregas.length}) — aviso silencioso`,
    );
    assert.match(entregas[1], /indisponível nesta sessão/i);
    assert.equal(
      terminos,
      2,
      "RED: onFinish não correu na recusa conhecida; quem chama perde o contrato de fecho",
    );
    // O gate tem de continuar livre: a trava é da AÇÃO recusada, não um bloqueio preso.
    assert.equal(gate.inFlight, false);
  });

  test("após a recusa, outro PID também não volta a bater na guarda — e ainda avisa", async () => {
    const { runKillRequest } = PROCESS_ACTIONS;
    let pedidos = 0;
    const entregas: string[] = [];
    const gate = { inFlight: false };
    const primeiro = {
      pid: 10,
      kill: async () => {
        pedidos += 1;
        throw new Error(ENVELOPE_ELECTRON);
      },
      refresh: () => {},
      onOutcome: (o: KillOutcomeLike) => entregas.push(o.message ?? "<sem mensagem>"),
      onFinish: () => {},
      gate,
    };
    await runKillRequest(primeiro);
    assert.equal(pedidos, 1);

    const segundo = await runKillRequest({ ...primeiro, pid: 20 });
    assert.equal(pedidos, 1, "outro PID voltou a pedir o kill depois de a fronteira ter recusado");
    assert.equal(segundo.status, "unavailable");
    assert.equal(segundo.pid, 20, "o desfecho tem de falar do PID mostrado, não do primeiro");
    assert.equal(entregas.length, 2);
  });

  test("o duplicado EM CURSO continua silencioso (não afrouxei a guarda de duplo envio)", async () => {
    const { runKillRequest } = PROCESS_ACTIONS;
    let resolver: ((v: ProcessKillResult) => void) = () => {};
    const emVoo = new Promise<ProcessKillResult>((resolve) => {
      resolver = resolve;
    });
    let entregas = 0;
    let terminos = 0;
    const gate = { inFlight: false };
    const deps = {
      pid: 1,
      kill: () => emVoo,
      refresh: () => {},
      onOutcome: () => {
        entregas += 1;
      },
      onFinish: () => {
        terminos += 1;
      },
      gate,
    };

    const primeiraChamada = runKillRequest(deps);
    const duplicado = await runKillRequest(deps);
    assert.equal(duplicado.status, "unavailable");
    assert.equal(duplicado.message, null, "o duplicado em curso não é um desfecho a anunciar");
    assert.equal(entregas, 0, "RED-review: entregar no duplicado faria dois avisos por 1 pedido");
    assert.equal(terminos, 0, "quem entrega é o primeiro pedido");

    resolver(KILL_NUNCA_CHAMADO);
    const primeiro = await primeiraChamada;
    assert.equal(primeiro.status, "killed");
    assert.equal(entregas, 1);
    assert.equal(terminos, 1);
    assert.equal(gate.inFlight, false);
  });
});

describe("limites do patch (o que NÃO é permitido fazer)", () => {
  const pagina = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");
  const acoes = readFileSync(new URL("../src/lib/processActions.ts", import.meta.url), "utf8");

  test("continua a existir UM só call site do kill na página", () => {
    assert.equal((pagina.match(/api\.killProcessTree/g) ?? []).length, 1);
  });

  test("nenhum modo novo inventado no renderer nem guarda desligada", () => {
    for (const fonte of [pagina, acoes]) {
      for (const proibido of [
        "READONLY_MODE",
        "readonlyMode",
        "DISABLE_READONLY",
        "skipGuard",
        "forceKill",
        "isPackaged = false",
      ]) {
        assert.doesNotMatch(fonte, new RegExp(proibido), `apareceu "${proibido}"`);
      }
    }
  });

  test("a mensagem de recusa não é uma das frases de sucesso nem de protected", () => {
    const constantes = PROCESS_ACTIONS as Record<string, unknown>;
    const alvo = constantes.KILL_READONLY_UNAVAILABLE ?? constantes.KILL_READ_ONLY_UNAVAILABLE;
    if (typeof alvo !== "string") return assert.fail("RED: nenhuma constante nomeada para a recusa");
    assert.notEqual(alvo, constantes.KILL_ERROR_ERROR);
    assert.notEqual(alvo, constantes.KILL_PROTECTED_ERROR);
    assert.notEqual(alvo, constantes.KILL_SUCCESS_MESSAGE);
  });
});
