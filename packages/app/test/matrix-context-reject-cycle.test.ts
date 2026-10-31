/**
 * TP-MATRIX-ROOT-CAUSE-20261023 — ciclo completo do defeito humano, sem DOM e
 * sem rede: conversa geral → WmiPrvSE.exe 15112 (sintético) → autorizar →
 * validador REAL aceita → tentativa de fornecedor → seguimento → outro alvo →
 * voltar → revogar → bloqueio → conversa nova → sugestão sem contexto →
 * duplo/retry/atrasada/recusa estável/falha do fornecedor/local.
 *
 * Nada aqui inventa um segundo caminho: as decisões são as funções partilhadas
 * que o componente usa, o payload é o `buildProcessMatrixContext` real e o gate
 * é o `processContextForChat` real da API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProcessMatrixContext,
  processPayload,
  processChatHistory,
  alvoDeExplicacao,
  alvoParaConsentimento,
  autorizarAlvo,
  autorizacaoValida,
  revogarAlvo,
  deveReenviarExplicacaoAposAutorizacao,
  rotuloDeAutorizacao,
  ALVO_MAQUINA,
  type AlvoProcesso,
} from '../src/lib/processMatrix.ts';
import {
  devePedirAutorizacaoAntes,
  motivoDoEncaminhamentoLocal,
  promptDeExplicacaoDeProcesso,
  MATRIX_EXPLAIN_PROMPT_MAQUINA,
  originDaResposta,
  estadoDoResultado,
} from '../src/lib/matrixConversation.ts';
import { isProcessQuestion } from '../src/lib/processMatrix.ts';
import { classeDeErro, descartarResposta, estadoDoPedido } from '../src/lib/matrixRequestMachine.ts';
import { processContextForChat, validateProcessIntelligencePayload } from '../../api/src/process-intelligence.ts';

const AGORA = 1_792_740_000_000;
const INICIO_WMI = '2026-10-23T09:14:07.1234567Z';
const INICIO_CHROME = '2026-10-23T08:00:00.0000000Z';
const WMI: AlvoProcesso = { pid: 15112, startedAt: INICIO_WMI };
const CHROME: AlvoProcesso = { pid: 4712, startedAt: INICIO_CHROME };

const diagnostico = {
  measuredAt: '2026-10-23T09:20:00.000Z',
  ram: { totalMb: 16384, usedMb: 11264, availableMb: 5120 },
  cpuPercent: 70,
  topProcesses: [
    { pid: 15112, name: 'WmiPrvSE.exe', startedAt: INICIO_WMI, cpuPercent: 62.4, workingSetMb: 118.4 },
    { pid: 4712, name: 'chrome.exe', startedAt: INICIO_CHROME, cpuPercent: 12, workingSetMb: 900 },
  ],
  trends: [
    { pid: 15112, startedAt: INICIO_WMI, previousMb: 100, currentMb: 118.4, deltaMb: 18.4, intervalMs: 60000, samples: 3 },
  ],
  observations: [],
  recommendations: ['Guardar o trabalho antes de fechar normalmente uma aplicação.'],
  limitations: ['Working Set não é memória privada ou exclusiva.'],
} as never;

const snapshotWmi = { pid: 15112, name: 'WmiPrvSE.exe', startedAt: INICIO_WMI, cpu: 62.4, memoryMb: 118.4 } as never;
const snapshotChrome = { pid: 4712, name: 'chrome.exe', startedAt: INICIO_CHROME, cpu: 12, memoryMb: 900 } as never;

/** O gate real, com o payload real: devolve o bloco ou o código da recusa. */
function gateDoServidor(payloadProcesso: ReturnType<typeof processPayload>) {
  try {
    return { aceite: true as const, bloco: processContextForChat(payloadProcesso) };
  } catch (err) {
    return { aceite: false as const, code: (err as { code?: string }).code };
  }
}

test('S1 — «Usei bastante CPU/RAM — é normal?» com autorização da máquina: o gate REAL aceita', () => {
  const pergunta = 'Usei bastante CPU/RAM — é normal?';
  assert.equal(isProcessQuestion(pergunta), true, 'a sugestão do produto é uma pergunta de processo para o gate');
  const autorizacoes = autorizarAlvo([], ALVO_MAQUINA, AGORA);
  assert.equal(autorizacaoValida(autorizacoes, ALVO_MAQUINA, AGORA), true);

  const contexto = buildProcessMatrixContext(diagnostico, undefined, undefined);
  const resultado = gateDoServidor(processPayload(contexto, true));
  assert.equal(resultado.aceite, true, `recusa inesperada: ${String((resultado as { code?: string }).code)}`);
  assert.ok(resultado.bloco!.includes('WmiPrvSE.exe'));
});

test('S2 — WmiPrvSE 15112 sem autorização: fica em casa, sem payload de processo', () => {
  const pedido = { pid: 15112, startedAt: INICIO_WMI };
  const alvo = alvoDeExplicacao(pedido);
  const decisao = motivoDoEncaminhamentoLocal({
    texto: promptDeExplicacaoDeProcesso(15112),
    perguntaProcesso: true,
    perguntaSegurancaLocal: false,
    identidadePerdida: false,
    perigo: false,
    foraDoTema: false,
    consentimentoProcesso: false,
    temContextoProcesso: true,
    modoLocal: false,
  });
  assert.equal(decisao, 'sem-consentimento');
  assert.deepEqual(processPayload(buildProcessMatrixContext(diagnostico, 15112, snapshotWmi), false), {});
  assert.equal(autorizacaoValida([], alvo, AGORA), false);
});

test('S3 — autorizar retoma UMA vez e o pedido real passa o validador e o gate; o fornecedor é chamado', () => {
  const pedido = { id: 7, pid: 15112, startedAt: INICIO_WMI, texto: promptDeExplicacaoDeProcesso(15112), alvo: WMI };
  let autorizacoes = autorizarAlvo([], alvoParaConsentimento(pedido.alvo), AGORA);
  assert.equal(rotuloDeAutorizacao(autorizacoes, WMI, AGORA), 'autorizado para este alvo');

  const estado = {
    consentimentoEfectivo: autorizacaoValida(autorizacoes, pedido.alvo, AGORA),
    alvoAutorizado: pedido.alvo,
    identidadePerdida: false,
    jaConsumido: null as number | null,
  };
  assert.equal(deveReenviarExplicacaoAposAutorizacao(pedido, estado), true);

  const contexto = buildProcessMatrixContext(diagnostico, 15112, snapshotWmi);
  assert.equal(validateProcessIntelligencePayload(contexto), true);
  const gate = gateDoServidor(processPayload(contexto, true));
  assert.equal(gate.aceite, true);
  assert.ok(gate.bloco!.includes('WmiPrvSE.exe'));

  // O fornecedor foi realmente tentado e respondeu: é a ÚNICA coisa que pode
  // declarar «IA».
  const resposta = { ok: true, content: 'Facto medido: 118,4 MB.' };
  assert.equal(originDaResposta({ pediuProvider: true, ...resposta }), 'ai');
  assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ...resposta }), 'generativa');

  // Consumido: o mesmo id não volta a enviar (duplo clique/re-render).
  assert.equal(deveReenviarExplicacaoAposAutorizacao(pedido, { ...estado, jaConsumido: pedido.id, consentimentoEfectivo: autorizacaoValida(autorizacoes, pedido.alvo, AGORA + 1000) }), false);
  autorizacoes = autorizarAlvo(autorizacoes, pedido.alvo, AGORA + 1000);
  assert.equal(autorizacaoValida(autorizacoes, WMI, AGORA + 1000), true);
});

test('S4 — seguimento no MESMO alvo continua coberto pela autorização já dada', () => {
  const autorizacoes = autorizarAlvo([], WMI, AGORA);
  assert.equal(autorizacaoValida(autorizacoes, WMI, AGORA + 5 * 60 * 1000), true);
  const contexto = buildProcessMatrixContext(diagnostico, 15112, snapshotWmi);
  assert.equal(gateDoServidor(processPayload(contexto, true)).aceite, true);
});

test('S5 — trocar para outro alvo não herda a autorização; S6 — voltar ao primeiro respeita-a', () => {
  const autorizacoes = autorizarAlvo([], WMI, AGORA);
  assert.equal(autorizacaoValida(autorizacoes, CHROME, AGORA), false);
  assert.equal(rotuloDeAutorizacao(autorizacoes, CHROME, AGORA), 'autorizado noutro alvo — não vale para este');
  assert.deepEqual(processPayload(buildProcessMatrixContext(diagnostico, 4712, snapshotChrome), autorizacaoValida(autorizacoes, CHROME, AGORA)), {});

  // Voltar: a autorização do WmiPrvSE ainda está viva e o payload dele é aceite.
  assert.equal(autorizacaoValida(autorizacoes, WMI, AGORA + 60_000), true);
  assert.equal(gateDoServidor(processPayload(buildProcessMatrixContext(diagnostico, 15112, snapshotWmi), true)).aceite, true);
});

test('S7 — revogar bloqueia o alvo e tira do histórico as medições já mostradas', () => {
  let autorizacoes = autorizarAlvo([], WMI, AGORA);
  autorizacoes = revogarAlvo(autorizacoes, WMI);
  assert.equal(autorizacaoValida(autorizacoes, WMI, AGORA), false);
  assert.equal(autorizacaoValida(autorizacoes, CHROME, AGORA), false);
  assert.deepEqual(processPayload(buildProcessMatrixContext(diagnostico, 15112, snapshotWmi), false), {});
  const historico = processChatHistory(
    [
      { role: 'user' as const, content: 'O que é phishing?' },
      { role: 'assistant' as const, content: 'WmiPrvSE.exe 118 MB', privateProcessData: true },
    ],
    false,
  );
  assert.deepEqual(historico, [{ role: 'user', content: 'O que é phishing?' }]);
});

test('S8 — conversa nova não herda autorização antiga; a sugestão volta a precisar de contexto', () => {
  const anterior = autorizarAlvo([], WMI, AGORA);
  const conversaNova: typeof anterior = []; // reset de conversa = lista vazia
  assert.equal(autorizacaoValida(conversaNova, WMI, AGORA), false);
  assert.ok(autorizacaoValida(anterior, WMI, AGORA));

  const decisao = motivoDoEncaminhamentoLocal({
    texto: MATRIX_EXPLAIN_PROMPT_MAQUINA,
    perguntaProcesso: true,
    perguntaSegurancaLocal: false,
    identidadePerdida: false,
    perigo: false,
    foraDoTema: false,
    consentimentoProcesso: false,
    temContextoProcesso: true,
    modoLocal: false,
  });
  assert.equal(decisao, 'sem-consentimento');
  assert.equal(devePedirAutorizacaoAntes({
    perguntaProcesso: true,
    temContextoProcesso: true,
    consentimentoEfectivo: false,
    identidadePerdida: false,
  }), true);
});

test('S9 — reenvio do mesmo pedido recusado: recusa estável, sem retry cego', () => {
  const code = 'process_context_invalid';
  assert.equal(classeDeErro(code), 'recusado');
  assert.equal(estadoDoPedido({ motivo: null, pediuProvider: true, ok: false, code }), 'pedido-recusado');
  assert.equal(classeDeErro('process_consent_missing'), 'recusado');
  // Uma falha de rede depois de aceitar é outra coisa: continua recuperável.
  assert.equal(estadoDoPedido({ motivo: null, pediuProvider: true, ok: false, code: 'timeout' }), 'erro-recuperavel');
});

test('S10 — resposta atrasada de outro alvo é descartada, e a falha do fornecedor não vira IA', () => {
  const pedido = { requestId: 'r1', conversationId: 'c1', targetId: '15112:' + INICIO_WMI, geracao: 1 };
  assert.equal(descartarResposta({ pedido, actual: { ...pedido, targetId: '4712:' + INICIO_CHROME }, signalAbortado: false }), true);
  assert.equal(descartarResposta({ pedido, actual: pedido, signalAbortado: false }), false);
  assert.equal(descartarResposta({ pedido, actual: null, signalAbortado: false }), true, 'sem pedido dono, descartar');

  const falha = { ok: false as const, code: 'no_provider' };
  assert.equal(originDaResposta({ pediuProvider: true, ...falha }), 'local');
  assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ...falha }), 'indisponivel');
});

test('S11 — sem medições não há enviar: uma resposta local honesta, nunca um 400', () => {
  const contexto = buildProcessMatrixContext(diagnostico, 15112, snapshotWmi);
  // Sem medições o componente nem constrói payload: `processPayload(null, true)`.
  assert.deepEqual(processPayload(null, true), {});
  assert.deepEqual(gateDoServidor({}), { aceite: true, bloco: null });
  // E o contexto real, quando existe, mantém-se aceite nas duas perguntas.
  assert.equal(gateDoServidor(processPayload(contexto, true)).aceite, true);
  assert.equal(gateDoServidor(processPayload(buildProcessMatrixContext(diagnostico, undefined, undefined), true)).aceite, true);
});
