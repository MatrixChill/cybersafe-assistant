import test from 'node:test';
import assert from 'node:assert/strict';
import { SafeProcessTermination, modoTerminacaoPedido, modosTerminacao } from '../dist/safe-process-termination.js';

const start = '2026-10-30T08:00:00.0000000Z';
const criacao = ((BigInt(Date.parse(start)) + 11644473600000n) * 10000n).toString();

/**
 * O mesmo bilhete de sempre, mas a registar COM QUE MODO o lease foi aberto.
 * Um teste que não distingue `open(pid)` de `open(pid, 'sigkill')` não prova
 * nada sobre a escalada — é exatamente a distinção que este protocolo é.
 */
function fixture(opcoes = {}) {
  const aberturas = [];
  const eventos = [];
  let kills = 0;
  let closed = 0;
  let exited = false;
  const lease = {
    read: () => ({ pid: 900, name: 'benigno', path: '/usr/bin/benigno', startedAt: start, creation: criacao, eligible: true }),
    exited: () => exited,
    terminate: () => { kills++; exited = true; },
    close: () => closed++,
    ...(opcoes.confirmation ? { confirmation: opcoes.confirmation } : {}),
  };
  const controller = new SafeProcessTermination({
    open: (pid, mode) => { aberturas.push({ pid, mode }); return lease; },
    blocked: () => null,
    audit: (evento) => eventos.push(evento),
    ...(opcoes.modes ? { modes: opcoes.modes } : {}),
  });
  return {
    controller, aberturas, eventos, lease,
    get kills() { return kills; },
    get closed() { return closed; },
    /** Processo que ignora o sinal: é o único caso que justifica a escalada. */
    nuncaSai() { lease.terminate = () => { kills++; }; },
  };
}
const AMBOS = ['sigterm', 'sigkill'];

test('o modo do pedido é uma lista fechada; undefined é o pedido normal', () => {
  assert.equal(modoTerminacaoPedido(undefined), 'sigterm');
  assert.equal(modoTerminacaoPedido('sigterm'), 'sigterm');
  assert.equal(modoTerminacaoPedido('sigkill'), 'sigkill');
  // Suavizar qualquer outro valor para SIGTERM faria a UI anunciar uma
  // operação e o serviço entregar outra.
  for (const inválido of ['SIGKILL', 'sigkill ', '', null, true, 0, {}, ['sigkill']])
    assert.equal(modoTerminacaoPedido(inválido), null, `aceitou ${JSON.stringify(inválido)}`);
});

test('a plataforma diz o que pode cumprir: Windows não tem SIGKILL', () => {
  assert.deepEqual(modosTerminacao('win32'), ['sigterm']);
  assert.deepEqual(modosTerminacao('linux'), AMBOS);
  assert.deepEqual(modosTerminacao('darwin'), AMBOS);
});

test('sem declaração de modos só existe o pedido normal', async () => {
  const f = fixture();
  assert.equal(f.controller.prepare({ pid: 900, startedAt: start }).mode, 'sigterm');
  assert.equal(f.aberturas.at(-1).mode, 'sigterm');
  const recusado = f.controller.prepare({ pid: 900, startedAt: start, mode: 'sigkill' });
  assert.equal(recusado.ok, false);
  assert.equal(recusado.status, 'failed');
  // Ausência de efeitos: nenhum lease aberto depois da recusa, nenhum sinal.
  assert.equal(f.aberturas.length, 1);
  assert.equal(f.kills, 0);
  assert.match(recusado.error, /SIGKILL/);
  assert.match(recusado.error, /nenhum sinal foi enviado/);
});

test('modo não reconhecido é recusado antes de abrir seja o que for', () => {
  const f = fixture({ modes: AMBOS });
  const r = f.controller.prepare({ pid: 900, startedAt: start, mode: 'SIGKILL' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Modo de terminação não reconhecido/);
  assert.equal(f.aberturas.length, 0);
  assert.equal(f.kills, 0);
  assert.equal(f.closed, 0);
});

test('bilhete pinado a SIGKILL abre o lease com esse modo e devolve o sinal', async () => {
  const f = fixture({ modes: AMBOS, confirmation: 'identity-reconfirmed' });
  const p = f.controller.prepare({ pid: 900, startedAt: start, mode: 'sigkill' });
  assert.equal(p.ok, true);
  assert.equal(p.mode, 'sigkill');
  assert.deepEqual(p.modes, AMBOS);
  assert.deepEqual(f.aberturas, [{ pid: 900, mode: 'sigkill' }]);
  const r = await f.controller.confirm(p.ticket);
  assert.equal(r.status, 'killed');
  assert.equal(r.signal, 'sigkill');
  assert.equal(r.confirmation, 'identity-reconfirmed');
  assert.equal(r.scope, 'single-process');
  assert.equal(f.eventos.at(-1).signal, 'sigkill');
  assert.equal(f.eventos.at(-1).status, 'killed');
});

test('um bilhete SIGTERM não pode ser promovido: o modo é do prepare', async () => {
  const f = fixture({ modes: AMBOS });
  const p = f.controller.prepare({ pid: 900, startedAt: start });
  assert.equal(p.mode, 'sigterm');
  // `confirm` não recebe modo nenhum — não há parameter por onde trocar.
  assert.equal(f.controller.confirm.length, 1);
  const r = await f.controller.confirm(p.ticket);
  assert.equal(r.signal, 'sigterm');
  assert.equal(f.aberturas.at(-1).mode, 'sigterm');
});

test('SIGKILL que não produz saída é timeout nomeado, nunca sucesso', async () => {
  const f = fixture({ modes: AMBOS });
  f.nuncaSai();
  f.controller.waitMs = 1;
  const p = f.controller.prepare({ pid: 900, startedAt: start, mode: 'sigkill' });
  const r = await f.controller.confirm(p.ticket);
  assert.equal(r.success, false);
  assert.equal(r.status, 'timeout');
  assert.equal(r.signal, 'sigkill');
  assert.equal(f.eventos.at(-1).status, 'timeout');
});

test('recusa de modo não consome bilhetes nem deixa handles abertos', () => {
  const f = fixture({ modes: ['sigterm'] });
  for (let i = 0; i < 9; i += 1)
    assert.equal(f.controller.prepare({ pid: 900, startedAt: start, mode: 'sigkill' }).ok, false);
  assert.equal(f.aberturas.length, 0);
  // O nono bilhete legítimo continua disponível: a recusa não conta como pendente.
  assert.equal(f.controller.prepare({ pid: 900, startedAt: start }).ok, true);
});
