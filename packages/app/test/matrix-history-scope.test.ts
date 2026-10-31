/**
 * TP-RETOMA23-MATRIX-HISTORY-SCOPE — privacidade por alvo no histórico.
 *
 * O consentimento é por instância (PID + início). Uma autorização para B não
 * pode levar ao fornecedor o diagnóstico privado de A, mesmo que A e B tenham
 * o mesmo PID em instantes diferentes. Mensagens gerais (sem medições) ficam
 * sempre; sem alvo autorizado, `null`/sem metadata/instante ilegível não
 * autorizam nada.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  processChatHistory,
  processChatHistoryParaAlvo,
  mesmoAlvoCanonico,
  autorizarAlvo,
  autorizacaoValida,
  revogarAlvo,
  AMBITO_CONSENTIMENTO,
  type AlvoProcesso,
} from "../src/lib/processMatrix.ts";

const A: AlvoProcesso = { pid: 900, startedAt: "2026-10-23T08:00:00.0000000Z" };
const A_CANONICO: AlvoProcesso = { pid: 900, startedAt: "2026-10-23T08:00:00.000Z" };
const B: AlvoProcesso = { pid: 900, startedAt: "2026-10-23T08:05:00.0000000Z" };
const C: AlvoProcesso = { pid: 901, startedAt: "2026-10-23T08:00:00.0000000Z" };
const MAQUINA: AlvoProcesso = { pid: null, startedAt: null };
const SEM_INICIO: AlvoProcesso = { pid: 1234, startedAt: null };

type Mensagem = {
  role: "user" | "assistant";
  content: string;
  privateProcessData?: boolean;
  privateTarget?: AlvoProcesso | null;
};

const historico = (): Mensagem[] => [
  { role: "user", content: "O que é phishing?" },
  { role: "assistant", content: "DIAG A", privateProcessData: true, privateTarget: A },
  { role: "assistant", content: "DIAG A canónico", privateProcessData: true, privateTarget: A_CANONICO },
  { role: "assistant", content: "DIAG B", privateProcessData: true, privateTarget: B },
  { role: "assistant", content: "DIAG C", privateProcessData: true, privateTarget: C },
  { role: "assistant", content: "DIAG sem alvo", privateProcessData: true },
  { role: "assistant", content: "DIAG alvo null", privateProcessData: true, privateTarget: null },
  { role: "assistant", content: "DIAG máquina", privateProcessData: true, privateTarget: MAQUINA },
  { role: "assistant", content: "DIAG início null", privateProcessData: true, privateTarget: SEM_INICIO },
  { role: "user", content: "Pergunta geral 2" },
];

const conteudos = (msgs: Array<{ content: string }>) => msgs.map((m) => m.content);
const apenasGerais = ["O que é phishing?", "Pergunta geral 2"];

test("H1 — autorizar B não leva A, C, sem alvo, null nem máquina", () => {
  const enviado = processChatHistoryParaAlvo(historico(), B);
  assert.deepEqual(conteudos(enviado), ["O que é phishing?", "DIAG B", "Pergunta geral 2"]);
  assert.deepEqual(Object.keys(enviado[0]).sort(), ["content", "role"], "metadata local não pode sair no payload");
});

test("H2 — a mesma instância em 7 ou 3 casas é o MESMO alvo (A)", () => {
  const enviado = processChatHistoryParaAlvo(historico(), A);
  assert.deepEqual(conteudos(enviado), [
    "O que é phishing?",
    "DIAG A",
    "DIAG A canónico",
    "Pergunta geral 2",
  ]);
});

test("H3 — sem alvo autorizado, null/undefined não levam NENHUM privado", () => {
  assert.deepEqual(conteudos(processChatHistoryParaAlvo(historico(), null)), apenasGerais);
  assert.deepEqual(conteudos(processChatHistoryParaAlvo(historico(), undefined)), apenasGerais);
});

test("H4 — revogar e expirar não levam privados; o histórico geral fica", () => {
  const agora = 1_000_000;
  const autorizacoes = autorizarAlvo([], A, agora);
  assert.equal(autorizacaoValida(autorizacoes, A, agora), true);

  const expirada = autorizacaoValida(autorizacoes, A, agora + AMBITO_CONSENTIMENTO.duracaoMs);
  assert.equal(expirada, false);
  assert.deepEqual(
    conteudos(processChatHistoryParaAlvo(historico(), expirada ? A : null)),
    apenasGerais,
  );

  const revogadas = revogarAlvo(autorizacoes, A);
  assert.equal(autorizacaoValida(revogadas, A, agora), false);
  assert.deepEqual(
    conteudos(processChatHistoryParaAlvo(historico(), autorizacaoValida(revogadas, A, agora) ? A : null)),
    apenasGerais,
  );
});

test("H5 — identidade canónica: mesmo PID com outro início é outro alvo; null não prova", () => {
  assert.equal(mesmoAlvoCanonico(A, A_CANONICO), true);
  assert.equal(mesmoAlvoCanonico(A, B), false, "mesmo PID, instante diferente");
  assert.equal(mesmoAlvoCanonico(A, C), false, "PID diferente");
  assert.equal(mesmoAlvoCanonico(SEM_INICIO, SEM_INICIO), false, "início null não prova identidade");
  assert.equal(mesmoAlvoCanonico(null, null), false, "alvo ausente não autoriza");
  assert.equal(mesmoAlvoCanonico(MAQUINA, MAQUINA), true, "«esta máquina» é um alvo explícito");
});

test("H6 — máquina autoriza só o diagnóstico da máquina; processos não", () => {
  assert.deepEqual(
    conteudos(processChatHistoryParaAlvo(historico(), MAQUINA)),
    ["O que é phishing?", "DIAG máquina", "Pergunta geral 2"],
  );
});

test("H8 — o caminho real de 3 argumentos aplica o mesmo filtro por alvo", () => {
  assert.deepEqual(
    conteudos(processChatHistory(historico(), true, B)),
    ["O que é phishing?", "DIAG B", "Pergunta geral 2"],
  );
  assert.deepEqual(conteudos(processChatHistory(historico(), true, MAQUINA)), ["O que é phishing?", "DIAG máquina", "Pergunta geral 2"]);
  assert.deepEqual(conteudos(processChatHistory(historico(), true, null)), apenasGerais);
  assert.deepEqual(conteudos(processChatHistory(historico(), false, null)), apenasGerais);
});

test("H7 — cablagem: o envio usa o filtro por alvo e passa o alvo do pedido", () => {
  const fonte = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  assert.match(fonte, /processChatHistory\(history,\s*consentimentoDoPedido,\s*consentimentoDoPedido\s*\?\s*alvoDoEnvio\s*:\s*null\)/);
  assert.doesNotMatch(fonte, /messages:\s*processChatHistory\(history,\s*consentimento\)/);
});
