/**
 * TP-MATRIX-FINAL-UI — histórico para o fornecedor.
 *
 * O booleano de consentimento é a primeira porta: `false` exclui TODO o privado,
 * mesmo que um alvo seja passado. Uma autorização de B nunca leva A/C/sem alvo/
 * `null`, e a mesma instância só conta por PID + início canónico. A troca de
 * conta aborta o pedido em voo e limpa o estado privado local — não há caminho
 * para o histórico da conta A sair sob a conta B.
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

test("H1 — consent=false exclui TODO o privado mesmo com alvo B fornecido", () => {
  assert.deepEqual(conteudos(processChatHistory(historico(), false, B)), apenasGerais);
  assert.deepEqual(conteudos(processChatHistory(historico(), false, MAQUINA)), apenasGerais);
  assert.deepEqual(conteudos(processChatHistory(historico(), false, null)), apenasGerais);
  assert.deepEqual(conteudos(processChatHistoryParaAlvo(historico(), B)), ["O que é phishing?", "DIAG B", "Pergunta geral 2"]);
});

test("H2 — consent=true leva só o alvo autorizado; A/B/C não se misturam", () => {
  assert.deepEqual(
    conteudos(processChatHistory(historico(), true, A)),
    ["O que é phishing?", "DIAG A", "DIAG A canónico", "Pergunta geral 2"],
  );
  assert.deepEqual(
    conteudos(processChatHistory(historico(), true, B)),
    ["O que é phishing?", "DIAG B", "Pergunta geral 2"],
  );
  assert.deepEqual(
    conteudos(processChatHistory(historico(), true, C)),
    ["O que é phishing?", "DIAG C", "Pergunta geral 2"],
  );
});

test("H3 — null/undefined, sem metadata e início null nunca autorizam", () => {
  for (const alvo of [null, undefined] as const) {
    assert.deepEqual(conteudos(processChatHistory(historico(), true, alvo)), apenasGerais);
  }
  assert.deepEqual(conteudos(processChatHistoryParaAlvo(historico(), null)), apenasGerais);
  assert.deepEqual(conteudos(processChatHistoryParaAlvo(historico(), SEM_INICIO)), apenasGerais);
});

test("H4 — identidade canónica: mesmo PID com outro início é outro alvo; null não prova", () => {
  assert.equal(mesmoAlvoCanonico(A, A_CANONICO), true);
  assert.equal(mesmoAlvoCanonico(A, B), false, "mesmo PID, instante diferente");
  assert.equal(mesmoAlvoCanonico(A, C), false, "PID diferente");
  assert.equal(mesmoAlvoCanonico(SEM_INICIO, SEM_INICIO), false, "início null não prova identidade");
  assert.equal(mesmoAlvoCanonico(null, null), false, "alvo ausente não autoriza");
  assert.equal(mesmoAlvoCanonico(MAQUINA, MAQUINA), true, "«esta máquina» é um alvo explícito");
});

test("H5 — o caminho de envio continua a usar o filtro por alvo", () => {
  const fonte = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  assert.match(fonte, /processChatHistory\(history,\s*consentimentoDoPedido,\s*consentimentoDoPedido\s*\?\s*alvoDoEnvio\s*:\s*null\)/);
  assert.doesNotMatch(fonte, /messages:\s*processChatHistory\(history,\s*consentimento\)/);
});

test("H7 — trocar de fornecedor depois da autorização invalida o envio", () => {
  const agora = 1_000_000;
  const autorizacoes = autorizarAlvo([], A, agora, "provider-a");
  assert.equal(autorizacaoValida(autorizacoes, A, agora, "provider-a"), true);
  assert.equal(autorizacaoValida(autorizacoes, A, agora, "provider-b"), false);
  assert.equal(autorizacaoValida(autorizacoes, A, agora, null), false);
  assert.equal(autorizacaoValida(autorizacoes, A, agora), true, "chamada antiga sem identidade continua legível");
});

test("H6 — troca de conta aborta o pedido em voo e limpa o estado privado local", () => {
  const fonte = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  assert.match(fonte, /import \{ useAuth \} from "@\/contexts\/AuthContext"/);
  assert.match(fonte, /const contaAnteriorRef = useRef<string \| null>\(contaId\)/);
  assert.match(fonte, /contaAnteriorRef\.current === contaId/);
  assert.match(fonte, /contaAnteriorRef\.current = contaId[\s\S]*resetConversation\(\)/);
  assert.match(fonte, /abortRef\.current\?\.abort\(\)/);
  assert.match(fonte, /setAutorizacoes\(\[\]\)/);
  assert.match(fonte, /setExplicacaoPendente\(null\)/);
  assert.match(fonte, /setOfertaIa\(null\)/);
  assert.doesNotMatch(fonte, /setInterval\([^)]*status|setInterval\([^)]*consent/i, "sem polling de estado/consentimento");
});
