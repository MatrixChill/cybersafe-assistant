/**
 * TP-MATRIX-P0-ORIGIN-ROUTING-20261022 — o contrato do lado da API que permite à
 * UI dizer «IA online» sem mentir.
 *
 * A origem de cada resposta é decidida no renderer (`matrixConversation.ts`), mas
 * só é honesta porque o servidor tem estas garantias, provadas aqui sem rede e sem
 * chave de provider:
 *  1. uma falha do provider NUNCA chega como sucesso: 429/401/403/404/timeout/rede
 *     têm `kind` estável, e a rota responde com código — o cliente não pode
 *     interpretar um erro como resposta generativa;
 *  2. a FORMA do pedido é verificada antes de qualquer ida ao provider;
 *  3. texto com forma de credencial é recusado sem ser ecoado nem registado;
 *  4. o contexto de processo só entra no pedido com `processConsent === true` e só
 *     com a allowlist validada — um campo a mais (ex.: `commandLine`) inviabiliza o
 *     payload em vez de passar.
 *
 * Importa `../src/*.ts` (código desta lane) e NÃO `../dist/*.js`: o `dist` não faz
 * parte do snapshot e um teste verde contra compilação alheia não provava nada.
 * Sem chamadas externas, sem .env, sem chaves.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyError,
  findShapeViolation,
  assertRequestShape,
  findOutboundViolation,
  buildMessages,
  INVALID_REQUEST_CODE,
  CREDENTIAL_BLOCKED_CODE,
} from "../src/ai.ts";
import {
  processContextForChat,
  hasProcessConsent,
  validateProcessIntelligencePayload,
} from "../src/process-intelligence.ts";

// ── Fixtures determinísticas ───────────────────────────────────────────────────

const STAMP = "2026-10-22T20:00:00.000Z";

const entrada = (extra = {}) => ({
  pid: 4712,
  name: "MsMpEng.exe",
  startedAt: STAMP,
  cpuPercent: 9.1,
  workingSetMb: 1780,
  ...extra,
});

const contexto = (extra = {}) => ({
  version: 1,
  measuredAt: STAMP,
  ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 },
  cpuPercent: 37.5,
  topProcesses: [entrada()],
  selectedProcess: entrada(),
  trends: [],
  limitations: [],
  ...extra,
});

describe("1) falha do provider nunca é sucesso: os códigos que a UI conhece", () => {
  // Tabela LIGADA ao `classifyError` real (é este o contrato que o renderer usa
  // para decidir retry/fallback). Escrevê-la a partir do código, e não do que se
  // supõe, é o ponto: um mapeamento em falta seria uma origem mentida na UI.
  const casos = [
    [{ status: 429 }, "rate_limited"],
    [{ status: 401 }, "auth"],
    [{ status: 403 }, "auth"],
    [{ status: 404 }, "model_unavailable"],
    [{ name: "AbortError" }, "timeout"],
    [{ code: "ECONNABORTED" }, "timeout"],
    [{ name: "APIConnectionTimeoutError" }, "timeout"],
    [{ message: "socket hang up" }, "network"],
    // Revisão R2 (decisão do integrador): um 5xx é o fornecedor a RESPONDER, não a
    // ligação a falhar. `network` fica reservado ao que não tem estado HTTP — o caso
    // acima, sem `status`. Antes da R1 este mesmo 503 era lido como `network`.
    [{ status: 503, message: "upstream unavailable" }, "provider_unavailable"],
    [{}, "unknown"],
  ];
  for (const [erro, esperado] of casos) {
    test(`${JSON.stringify(erro)} → kind ${esperado}`, () => {
      assert.equal(classifyError(erro).kind, esperado);
    });
  }

  test("cancelamento do utilizador distingue-se de timeout", () => {
    assert.equal(classifyError(new Error("AbortError"), true).kind, "aborted");
  });

  test("nenhum destes códigos chega como resposta concluída", () => {
    // O cliente só declara «IA online» com `ok:true` e conteúdo concluído. Todos os
    // caminhos acima devolvem código/mensagem de erro, portanto a origem fica local.
    for (const [erro] of casos) {
      const classificado = classifyError(erro);
      assert.notEqual(classificado.kind, undefined);
      assert.notEqual(typeof classificado.kind, "undefined");
      assert.ok(!["credential_blocked", "invalid_request"].includes(classificado.kind));
    }
  });

  test("sem estado HTTP não há 5xx: o que sobra é rede ou desconhecido", () => {
    assert.equal(classifyError({ message: "socket hang up" }).kind, "network");
    assert.equal(classifyError({}).kind, "unknown");
    assert.equal(classifyError({ status: 503 }).kind, "provider_unavailable");
  });
});

describe("2) forma do pedido antes do provider", () => {
  test("pedido válido passa a verificação de forma", () => {
    assert.equal(findShapeViolation({ messages: [{ role: "user", content: "oi" }], context: "", page: "dashboard" }), null);
    assert.doesNotThrow(() => assertRequestShape({ messages: [{ role: "user", content: "oi" }], context: "", page: "dashboard" }));
  });

  test("histórico acima do limite é recusado com o código estável", () => {
    const mensagens = Array.from({ length: 501 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `m${i}` }));
    assert.ok(findShapeViolation({ messages: mensagens, context: "", page: "" }));
    const erro = (() => {
      try {
        assertRequestShape({ messages: mensagens, context: "", page: "" });
        return null;
      } catch (e) {
        return e;
      }
    })();
    assert.ok(erro, "sem exceção, o limite seria decorativo");
    assert.equal(erro.kind, "invalid_request");
    assert.equal(INVALID_REQUEST_CODE, "invalid_request");
  });

  test("entradas malformadas são recusadas pela razão, sem ecoar o conteúdo", () => {
    assert.match(String(findShapeViolation({ messages: "oi", context: "", page: "" })), /lista/);
    assert.match(String(findShapeViolation({ messages: [null], context: "", page: "" })), /entrada inválida/);
    assert.match(String(findShapeViolation({ messages: [{ role: "user", content: 7 }], context: "", page: "" })), /não é texto/);
    assert.match(String(findShapeViolation({ messages: [{ role: "user", content: "X".repeat(100_001) }], context: "", page: "" })), /tamanho máximo/);
    assert.match(String(findShapeViolation({ messages: [{ role: "user", content: "oi" }], context: 12, page: "" })), /context não é texto/);
    // O que faz falta aqui é o conteúdo não sair na razão da recusa: é essa a
    // garantia de que um pedido recusado não fica registado em lado nenhum.
    const segredo = "conteudo-que-nao-pode-aparecer";
    const razao = findShapeViolation({ messages: [{ role: "user", content: segredo.repeat(9000) }], context: "", page: "" });
    assert.ok(razao && !razao.includes(segredo), `a razão ecoou o conteúdo recusado: ${razao}`);
  });
});

describe("3) credencial nunca sai e nunca é ecoada", () => {
  /** FALSA, mas com a forma real que o detetor conhece (`sk-` + 20+). */
  const SEGRED = "sk-FAKE-NAO-REAL-0123456789abcdef";

  test("texto com forma de chave é detido em messages, context e page", () => {
    const detetado = findOutboundViolation({ messages: [{ role: "user", content: `a minha chave é ${SEGRED}` }], context: "", page: "" });
    assert.ok(detetado, "a guarda central não apanhou o segredo em message");
    assert.equal(detetado.field, "message");
    assert.equal(detetado.pattern, "openai-key");
    assert.ok(findOutboundViolation({ messages: [{ role: "user", content: "oi" }], context: SEGRED, page: "" }), "contexto passou ao lado da guarda");
    assert.ok(findOutboundViolation({ messages: [{ role: "user", content: "oi" }], context: "", page: SEGRED }), "a página passou ao lado da guarda");
  });

  test("o segredo partido em vários campos também é apanhado", () => {
    const parte1 = "sk-FAKE-NAO-";
    const parte2 = "REAL-0123456789abcdef";
    const viola = findOutboundViolation({ messages: [{ role: "user", content: parte2 }], context: parte1, page: "" });
    assert.ok(viola, "fragmentos adjacentes somados não podem escapar à inspeção");
  });

  test("o motivo da recusa não transcreve o segredo recusado", () => {
    const viola = findOutboundViolation({ messages: [{ role: "user", content: `chave ${SEGRED}` }], context: "", page: "" });
    const texto = JSON.stringify(viola ?? {});
    assert.ok(!texto.includes(SEGRED), `a deteção ecoou o segredo: ${texto}`);
    assert.equal(CREDENTIAL_BLOCKED_CODE, "credential_blocked");
  });

  test("conteúdo normal não é confundido com credencial", () => {
    assert.equal(findOutboundViolation({ messages: [{ role: "user", content: "Quanta memória o Chrome está a usar?" }], context: "RAM 12 GB", page: "tasks" }), null);
  });
});

describe("4) contexto de processo: consentimento específico e allowlist", () => {
  test("sem `processIntelligence` no corpo, nada é acrescentado ao pedido", () => {
    assert.equal(processContextForChat({ messages: [] }), null);
    assert.equal(hasProcessConsent({ messages: [] }), false);
  });

  test("contexto presente SEM consentimento → recusa (o route devolve 400)", () => {
    assert.equal(hasProcessConsent({ processIntelligence: contexto(), processConsent: false }), false);
    assert.throws(() => processContextForChat({ processIntelligence: contexto() }), /./);
    assert.throws(() => processContextForChat({ processIntelligence: contexto(), processConsent: "true" }), /./, "consentimento tem de ser o literal true");
  });

  test("payload fora da allowlist é recusado mesmo com consentimento", () => {
    assert.equal(validateProcessIntelligencePayload(contexto({ cmdline: "powershell -Command ..." })), false);
    assert.equal(validateProcessIntelligencePayload(contexto({ topProcesses: [entrada({ commandLine: "C:\\x\\y.exe" })] })), false);
    assert.equal(validateProcessIntelligencePayload(contexto({ topProcesses: [entrada({ name: "C:\\Windows\\MsMpEng.exe" })] })), false, "um nome com caminho não passa na allowlist");
    assert.throws(() => processContextForChat({ processIntelligence: contexto({ cmdline: "x" }), processConsent: true }), /./);
  });

  test("com consentimento, o bloco vai validado e sem caminhos", () => {
    const bloco = processContextForChat({ processIntelligence: contexto(), processConsent: true });
    assert.equal(typeof bloco, "string");
    assert.match(bloco, /\[FACTO MEDIDO - PROCESS INTELLIGENCE\]/);
    assert.ok(bloco.includes("MsMpEng.exe"));
    assert.ok(!bloco.includes("\\"), "o bloco não pode levar caminhos do host");
    assert.ok(!bloco.toLowerCase().includes("commandline"));
  });
});

describe("5) o pedido ao provider é constituído só pelo que foi autorizado", () => {
  test("buildMessages produz apenas pares role/content", () => {
    const mensagens = buildMessages([{ role: "user", content: "oi" }], "RAM 12 GB", "tasks");
    assert.ok(Array.isArray(mensagens) && mensagens.length > 0);
    for (const m of mensagens) {
      assert.deepEqual(Object.keys(m).sort(), ["content", "role"], `campo extra no pedido: ${JSON.stringify(Object.keys(m))}`);
    }
  });
});
