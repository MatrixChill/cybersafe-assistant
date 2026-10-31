import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideAvisoCancelamento,
  decideCancelamento,
  SCAN_CANCEL_RECUSADO_NOTE,
  SCAN_CANCEL_REQUESTED_NOTE,
  SCAN_CANCEL_SEM_CONFIRMACAO_NOTE,
  type CancelamentoOutcome,
} from "../src/lib/scanSession";

/**
 * UI-D1 (TP-PAP-UI-FUNCTIONAL-20261028, Qoder) — o cancelamento só é «pedido»
 * quando o serviço o aceita.
 *
 * O defeito real, na base desta lane (`FileScannerPage.tsx:863-877`):
 * `await api.cancelScan(id)` deitava fora o `{ success }` do contrato
 * (`electron.d.ts:94`) e `setCancelRequested(true)` era incondicional. O botão
 * passava a dizer «Cancelamento pedido...» e a nota do cartão prometia ao motor
 * um pedido que o motor pode ter recusado. O `catch` mostrava o `message` cru.
 *
 * LIMITE HONESTO, declarado: o contrato em `electron.d.ts` é `{ success }` e a
 * UI passa a lê-lo. O que o serviço realmente devolve em cada caso é do backend
 * (`packages/service/src/engine.ts`, scope Codex/FreePi) — o Codex indicou que
 * `scan.cancel` pode agora responder `false` (sessão já terminal). Validar em
 * Electron: cancelamento de um scan real e recusa por `ja_terminal`, ambos com
 * raiz de fixtures; nenhum dos dois é comprovável por teste de componente.
 */

const fontePagina = readFileSync(new URL("../src/pages/FileScannerPage.tsx", import.meta.url), "utf8");

describe("decideCancelamento — leitura do contrato", () => {
  test("success:true é o único sinal de aceitação", () => {
    assert.equal(decideCancelamento({ success: true }), "pedido");
  });

  test("success:false é recusa, não pedido enviado", () => {
    assert.equal(decideCancelamento({ success: false }), "recusado");
    assert.equal(decideCancelamento({}), "recusado", "sem sucesso afirmado não há aceitação");
  });

  test("null/undefined é ausência de resposta, nem aceitação nem recusa", () => {
    assert.equal(decideCancelamento(null), "sem_confirmacao");
    assert.equal(decideCancelamento(undefined), "sem_confirmacao");
  });

  test("o vocabulário cobre o tipo", () => {
    const todos: CancelamentoOutcome[] = ["pedido", "recusado", "sem_confirmacao"];
    assert.deepEqual(todos, ["pedido", "recusado", "sem_confirmacao"]);
    assert.ok(!todos.includes("cancelado" as CancelamentoOutcome), "a UI nunca afirma o fim pelo pedido");
  });

  test("o aviso só existe para os resultados que o utilizador tem de ver", () => {
    assert.equal(decideAvisoCancelamento("pedido"), null, "aceite: é `cancelRequested` que se mostra");
    assert.deepEqual(decideAvisoCancelamento("recusado"), { tipo: "recusado", mensagem: SCAN_CANCEL_RECUSADO_NOTE });
    assert.deepEqual(decideAvisoCancelamento("sem_confirmacao"), {
      tipo: "sem_confirmacao",
      mensagem: SCAN_CANCEL_SEM_CONFIRMACAO_NOTE,
    });
  });

  test("as frases não prometem o terminal nem inventam o que não se sabe", () => {
    for (const nota of [SCAN_CANCEL_RECUSADO_NOTE, SCAN_CANCEL_SEM_CONFIRMACAO_NOTE, SCAN_CANCEL_REQUESTED_NOTE]) {
      assert.ok(!/cancelado$/i.test(nota));
      assert.ok(
        !/Service client|disconnected|Cannot read|TypeError/i.test(nota),
        `texto interno no ecrã: ${nota}`,
      );
    }
    assert.match(SCAN_CANCEL_REQUESTED_NOTE, /só termina quando o motor confirmar/);
    // O serviço pode responder `false` porque a sessão JÁ está terminal: a nota
    // não pode afirmar que a análise continua.
    assert.match(SCAN_CANCEL_RECUSADO_NOTE, /não aceitou o cancelamento/);
    assert.ok(!/continua em curso|nada mudou/i.test(SCAN_CANCEL_RECUSADO_NOTE), "sem asserção sobre continuar");
    assert.match(SCAN_CANCEL_RECUSADO_NOTE, /o que o serviço confirma/);
  });
});

describe("verificação estrutural do Scanner (não simula cliques)", () => {
  test("a resposta do cancelamento é lida e decidida pela função testada", () => {
    assert.match(fontePagina, /const resposta = await api\.cancelScan\(id\)/);
    assert.match(fontePagina, /const outcome = decideCancelamento\(resposta\)/);
  });

  test("só existe um caminho que assume cancelamento pedido, e é o da aceitação", () => {
    const assuncoes = fontePagina.match(/setCancelRequested\(true\)/g) ?? [];
    assert.equal(assuncoes.length, 1, "um único sítio promete o pedido");
    assert.match(
      fontePagina,
      /if \(outcome === "pedido"\) \{[\s\S]{0,160}setCancelRequested\(true\)/,
      "a promessa está atrás da confirmação do serviço",
    );
  });

  test("resposta e exceção são ambas guardadas pela IDENTIDADE do scan, além de montagem", () => {
    // Uma resposta tardia de um cancelamento antigo não pode escrever na sessão
    // nova: `mounted` sozinho não chega, porque entre o `await` e o regresso pode
    // nascer outro scan.
    const guards = fontePagina.match(/activeScanIdRef\.current !== id/g) ?? [];
    assert.equal(guards.length, 2, "resposta e exceção com o mesmo guard de identidade");
    // Ordem, não contagem de linhas: o guard tem de estar ENTRE o `await` e a
    // decisão, senão uma resposta de um scan antigo já escreveu na sessão nova.
    const aposAwait = fontePagina.indexOf("const resposta = await api.cancelScan(id)");
    const guardPos = fontePagina.indexOf("if (!mountedRef.current || activeScanIdRef.current !== id)", aposAwait);
    const decidePos = fontePagina.indexOf("decideCancelamento(resposta)", aposAwait);
    assert.ok(aposAwait > 0, "o pedido existe");
    assert.ok(guardPos > aposAwait && guardPos < decidePos, "o guard está logo depois do `await`, não no fim do `try`");
    assert.match(
      fontePagina,
      /devLog\("cancel request threw", err\)\s*\n\s*if \(!mountedRef\.current \|\| activeScanIdRef\.current !== id\) return/,
      "o `catch` não escreve numa sessão que já mudou",
    );
  });

  test("recusa e ausência de resposta vão para um aviso próprio, não para o erro da sessão", () => {
    // MEDIDO NO ELECTRON REAL: no `error` da página o aviso durava menos de um
    // segundo, porque `applyScanState` limpa o erro em cada evento do motor.
    assert.doesNotMatch(
      fontePagina,
      /setError\(\s*(SCAN_CANCEL_RECUSADO_NOTE|SCAN_CANCEL_SEM_CONFIRMACAO_NOTE|outcome === "recusado")/,
      "o resultado da ação não pode viver no erro da sessão",
    );
    assert.match(fontePagina, /setAvisoCancelar\(decideAvisoCancelamento\(outcome\)\)/);
    assert.match(fontePagina, /setAvisoCancelar\(decideAvisoCancelamento\("sem_confirmacao"\)\)/, "a exceção também avisa");
    assert.match(fontePagina, /\{avisoCancelar && \([\s\S]{0,60}<p role="alert" aria-live="assertive"/, "o aviso é alert, não status");
    assert.doesNotMatch(fontePagina, /"Erro ao cancelar: "/, "o texto do runtime deixou de ir para o ecrã");
    assert.match(fontePagina, /devLog\("cancel request threw", err\)/, "a razão técnica fica no diagnóstico");
  });

  test("o aviso é limpo pela sessão, não pelos eventos", () => {
    const limpezas = fontePagina.match(/setAvisoCancelar\(null\)/g) ?? [];
    assert.equal(
      limpezas.length,
      4,
      "quatro sítios: mudança de sessão em applyScanState, lançamento, aceitação do cancelamento e limpeza manual",
    );
    assert.ok(!/setScanProgress\(merged\)[\s\S]{0,120}setAvisoCancelar\(null\)/.test(fontePagina), "um evento do motor não apaga o aviso");
  });

  test("o botão continua utilizável para repetir quando não houve aceitação", () => {
    // `cancelButtonState` só desliga o botão com `cancelRequested`; não marcar
    // o pedido numa recusa é o que deixa repetir o gesto.
    assert.match(fontePagina, /const cancel = cancelButtonState\(uiStatus, !!activeScanId, cancelRequested\)/);
  });
});
