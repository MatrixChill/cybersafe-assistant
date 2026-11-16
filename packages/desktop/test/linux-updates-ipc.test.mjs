import test from 'node:test';
import assert from 'node:assert/strict';
import { runLinuxUpdate, LINUX_UPDATE_BINARY } from '../src/linux-updates.ts';

const fakeExec = (stdout, error = null, seen = []) => (file, args, opts, cb) => { seen.push({ file, args, opts }); cb(error, stdout, ''); };

test('fora de Linux não executa nada', async () => {
  const seen = [];
  const r = await runLinuxUpdate('check', false, 'win32', fakeExec('{}', null, seen));
  assert.equal(r.error, 'not-linux');
  assert.equal(seen.length, 0);
});

test('check usa o binário fixo, sem shell, e devolve o JSON', async () => {
  const seen = [];
  const r = await runLinuxUpdate('check', false, 'linux', fakeExec('{"schema":1,"state":"up-to-date"}\n', null, seen));
  assert.equal(r.ok, true);
  assert.equal(r.result.state, 'up-to-date');
  assert.equal(seen[0].file, LINUX_UPDATE_BINARY);
  assert.deepEqual(seen[0].args, ['check']);
  assert.equal(seen[0].opts.shell, undefined);
});

test('install exige consentimento e liga o pedido gráfico ao SHA-256 autorizado', async () => {
  const seen = [];
  assert.equal((await runLinuxUpdate('install', false, 'linux', fakeExec('{}', null, seen))).error, 'consent-required');
  assert.equal(seen.length, 0);
  const sha = 'a'.repeat(64);
  assert.equal((await runLinuxUpdate('install', true, 'linux',fakeExec('{}',null,seen),'--unsafe')).error,'invalid-response');
  assert.equal(seen.length,0);
  await runLinuxUpdate('install', true, 'linux', fakeExec('{"schema":1,"install":{"state":"terminal-requested"}}', null, seen),sha);
  assert.deepEqual(seen[0].args, ['install', '--consent','--graphical',`--sha256=${sha}`]);
});

test('binário ausente, timeout e resposta inválida são distinguidos', async () => {
  assert.equal((await runLinuxUpdate('check', false, 'linux', fakeExec('', Object.assign(new Error('x'), { code: 'ENOENT' })))).error, 'not-installed');
  assert.equal((await runLinuxUpdate('check', false, 'linux', fakeExec('', Object.assign(new Error('x'), { killed: true })))).error, 'timeout');
  assert.equal((await runLinuxUpdate('check', false, 'linux', fakeExec('lixo'))).error, 'invalid-response');
  const failed = await runLinuxUpdate('check', false, 'linux', fakeExec('{"schema":1,"state":"error"}', Object.assign(new Error('exit 1'), { code: 1 })));
  assert.equal(failed.ok, false);
  assert.equal(failed.result.state, 'error');
});
