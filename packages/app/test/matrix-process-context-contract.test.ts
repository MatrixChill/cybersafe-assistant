/**
 * TP-MATRIX-ROOT-CAUSE-20261023 — contrato REAL de ponta a ponta, sem rede.
 *
 * O que este ficheiro prova, e porque nao basta um mock: o payload e construido
 * pelo MESMO `buildProcessMatrixContext` que o frontend usa e e entregue ao
 * MESMO `validateProcessIntelligencePayload` / `processContextForChat` que a API
 * usa. Um `fetch` simulado que aceita tudo escondia exactamente o defeito que o
 * gate humano encontrou: o 400 antes do fornecedor.
 *
 * Dados SINTETICOS. Os instantes seguem o formato da fonte real: `CreationDate`
 * do CIM convertido com `.ToUniversalTime().ToString('o')`, que traz SETE casas
 * decimais (100 ns). E esse o valor que `ProcessSnapshot.startedAt` transporta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProcessMatrixContext, processPayload } from '../src/lib/processMatrix.ts';
import { validateProcessIntelligencePayload, processContextForChat } from '../../api/src/process-intelligence.ts';
import { classeDeErro, estadoDoPedido, matrixStateLabel } from '../src/lib/matrixRequestMachine.ts';

/** Instante no formato da fonte (7 casas), instante canonico do contrato (3). */
const INICIO_7 = '2026-10-23T09:14:07.1234567Z';
const INICIO_3 = '2026-10-23T09:14:07.123Z';
const INICIO_OUTRO_7 = '2026-10-23T08:00:00.0000000Z';

const snapshot = {
  pid: 15112,
  name: 'WmiPrvSE.exe',
  startedAt: INICIO_7,
  cpu: 62.4,
  memoryMb: 118.4,
} as never;

function diagnostico() {
  return {
    measuredAt: '2026-10-23T09:20:00.000Z',
    ram: { totalMb: 16384, usedMb: 11264, availableMb: 5120 },
    cpuPercent: 70,
    topProcesses: [
      { pid: 15112, name: 'WmiPrvSE.exe', startedAt: INICIO_7, cpuPercent: 62.4, workingSetMb: 118.4 },
      { pid: 4712, name: 'chrome.exe', startedAt: INICIO_OUTRO_7, cpuPercent: 12, workingSetMb: 900 },
    ],
    trends: [
      { pid: 15112, startedAt: INICIO_7, previousMb: 100, currentMb: 118.4, deltaMb: 18.4, intervalMs: 60000, samples: 3 },
    ],
    observations: ['Maior Working Set observado: chrome.exe, 900 MB.'],
    recommendations: ['Guardar o trabalho antes de fechar normalmente uma aplicação.'],
    limitations: ['Working Set não é memória privada ou exclusiva.'],
  } as never;
}

const canonico = (v: string) => new Date(Date.parse(v)).toISOString();

test('RED-01: contexto de processo construido pelo frontend REAL e aceite pelo validador REAL (WmiPrvSE 15112)', () => {
  const contexto = buildProcessMatrixContext(diagnostico(), 15112, snapshot);
  assert.equal(validateProcessIntelligencePayload(contexto), true,
    `o builder emite instantes que o validador recusa: ${JSON.stringify(contexto.selectedProcess)}`);
  assert.equal(contexto.selectedProcess?.pid, 15112);
  assert.equal(contexto.selectedProcess?.startedAt, INICIO_3, 'o contrato transporta o instante canonico, nao 100 ns');
});

test('RED-02: pergunta geral da maquina (sem processo escolhido) tambem passa o validador REAL', () => {
  const contexto = buildProcessMatrixContext(diagnostico(), undefined, undefined);
  assert.equal(contexto.selectedProcess, null);
  assert.equal(validateProcessIntelligencePayload(contexto), true,
    `topProcesses com instante da fonte real: ${JSON.stringify(contexto.topProcesses)}`);
});

test('RED-03: o gate do chat (processContextForChat) aceita o payload real com consentimento', () => {
  const contexto = buildProcessMatrixContext(diagnostico(), 15112, snapshot);
  const bloco = processContextForChat({ processIntelligence: contexto, processConsent: true });
  assert.ok(bloco && bloco.startsWith('[FACTO MEDIDO - PROCESS INTELLIGENCE]'),
    'com consentimento e contexto valido, o bloco tem de seguir para o fornecedor');
  assert.ok(bloco!.includes(INICIO_3), 'o bloco leva o instante canonico, nao o valor bruto da fonte');
});

test('RED-04: todo o instante emitido e canonico e as tendencias apontam para a MESMA instancia', () => {
  const contexto = buildProcessMatrixContext(diagnostico(), 15112, snapshot);
  const instantes = [
    ...contexto.topProcesses.map((p) => p.startedAt),
    contexto.selectedProcess?.startedAt ?? null,
    ...contexto.trends.map((t) => t.startedAt),
  ].filter((v): v is string => typeof v === 'string');
  assert.ok(instantes.length > 0);
  for (const i of instantes) assert.equal(canonico(i), i, `instante nao canonico no payload: ${i}`);
  assert.equal(contexto.trends[0].startedAt, contexto.selectedProcess!.startedAt);
});

test('RED-05: instante ilegivel (placeholder da fonte) nao vira lixo no payload', () => {
  const diag = diagnostico() as never as { topProcesses: Array<Record<string, unknown>>; trends: unknown[] };
  diag.topProcesses[0] = { ...diag.topProcesses[0], startedAt: '1792746847123' };
  diag.trends = [];
  const contexto = buildProcessMatrixContext(diag as never, 15112, { ...snapshot, startedAt: '1792746847123' } as never);
  assert.equal(contexto.selectedProcess?.startedAt, null, 'sem instante legivel nao ha identidade: null, nao texto arbitrario');
  assert.equal(validateProcessIntelligencePayload(contexto), true);
});

test('RED-06: CPU do processo escolhido segue a MESMA regra do diagnóstico (sem percentagens impossíveis)', () => {
  const contexto = buildProcessMatrixContext(diagnostico(), 15112, { ...(snapshot as object), cpu: 100.4 } as never);
  assert.equal(contexto.selectedProcess?.cpuPercent, null,
    'a janela de amostragem pode exceder 100%: o diagnóstico já trata isso como «sem leitura» e o payload tem de dizer o mesmo');
  assert.equal(validateProcessIntelligencePayload(contexto), true);
});

test('RED-07: a instancia continua a distinguir-se pelo instante (identidade não colapsa)', () => {
  const a = buildProcessMatrixContext(diagnostico(), 15112, snapshot);
  const b = buildProcessMatrixContext(diagnostico(), 15112, { ...(snapshot as object), startedAt: '2026-10-23T09:14:07.1244567Z' } as never);
  assert.notEqual(a.selectedProcess?.startedAt, b.selectedProcess?.startedAt);
  assert.equal(validateProcessIntelligencePayload(b), true);
});

test('RED-08: sem consentimento o gate recusa com código PRÓPRIO (não «contexto inválido»)', () => {
  const contexto = buildProcessMatrixContext(diagnostico(), 15112, snapshot);
  assert.throws(
    () => processContextForChat({ processIntelligence: contexto }),
    (err: { code?: string }) => err.code === 'process_consent_missing',
    'falta de consentimento tem de ser distinguível de contexto inválido',
  );
});

test('RED-09: contexto inválido com consentimento tem código próprio', () => {
  const contexto = { ...buildProcessMatrixContext(diagnostico(), 15112, snapshot), version: 2 } as never;
  assert.throws(
    () => processContextForChat({ processIntelligence: contexto, processConsent: true }),
    (err: { code?: string }) => err.code === 'process_context_invalid',
  );
});

test('RED-10: a recusa estável do nosso serviço não é «erro temporário»', () => {
  for (const code of ['invalid_request', 'process_context_invalid', 'process_consent_missing', 'credential_blocked']) {
    assert.equal(classeDeErro(code), 'recusado', `${code} não é falha de rede`);
    const estado = estadoDoPedido({ motivo: null, pediuProvider: true, ok: false, code });
    assert.equal(estado, 'pedido-recusado', `${code} foi classificado como ${estado}`);
    assert.doesNotMatch(matrixStateLabel(estado) ?? '', /temporári|tenta/i);
  }
  // Os erros de rede continuam recuperáveis: a correcção não pode engolir o retry.
  assert.equal(classeDeErro('timeout'), 'recuperavel');
  assert.equal(estadoDoPedido({ motivo: null, pediuProvider: true, ok: false, code: 'timeout' }), 'erro-recuperavel');
});

test('RED-11: payload de processos só sai com consentimento, e sem ele nada de telemetria', () => {
  const contexto = buildProcessMatrixContext(diagnostico(), 15112, snapshot);
  assert.deepEqual(processPayload(contexto, false), {});
  assert.deepEqual(processPayload(contexto, true), { processIntelligence: contexto, processConsent: true });
});
