import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NativeEngineBridge } from '../dist/native-engine-bridge.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SELF = fileURLToPath(import.meta.url);

async function withStubs(stubs, run) {
  const saved = new Map();
  for (const [name, value] of Object.entries(stubs)) {
    saved.set(name, NativeEngineBridge[name]);
    NativeEngineBridge[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) NativeEngineBridge[name] = value;
  }
}

async function withNodeEnv(value, run) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV');
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await run();
  } finally {
    if (had) process.env.NODE_ENV = previous;
    else delete process.env.NODE_ENV;
  }
}

test('R7: em modo de teste o probe não spawna e diz porquê', async () => {
  assert.equal(NativeEngineBridge.probePermitida({ NODE_ENV: 'test' }), false);
  const before = NativeEngineBridge.pendingChildren;
  await withNodeEnv('test', async () => {
    const health = await NativeEngineBridge.probe();
    assert.equal(health.status, 'degraded');
    assert.match(health.detail, /desativado/i);
  });
  assert.equal(NativeEngineBridge.pendingChildren, before, 'nenhum processo nasce');
});

test('R7: probes concorrentes partilham UMA invocação (single-flight)', async () => {
  let calls = 0;
  await withNodeEnv('production', () => withStubs({
    checkAvailability: () => ({ status: 'degraded', detail: 'fixture: ainda não confirmado' }),
    scan: async () => {
      calls += 1;
      await wait(20);
      return { ok: false, result: null, failure: 'timeout', error: 'Native engine timeout' };
    },
  }, async () => {
    const [a, b, c] = await Promise.all([NativeEngineBridge.probe(), NativeEngineBridge.probe(), NativeEngineBridge.probe()]);
    assert.equal(calls, 1, 'três chamadas concorrentes custam uma invocação');
    assert.equal(a.status, 'degraded');
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  }));
});

test('R7: timeout fica registado como evidência (prontidão não volta a ativo sozinha)', async () => {
  await withNodeEnv('production', () => withStubs({
    // Ficheiro real: a prontidão é decidida pela EVIDÊNCIA, não pelo caminho.
    getBinaryPath: () => SELF,
    scan: async () => {
      await wait(5);
      return { ok: false, result: null, failure: 'timeout', error: 'Native engine timeout' };
    },
  }, async () => {
    const afterTimeout = await NativeEngineBridge.probe();
    assert.equal(afterTimeout.status, 'degraded');
    assert.match(afterTimeout.detail, /timeout/i);
    assert.equal(NativeEngineBridge.lastInvocation.ok, false);
    assert.equal(NativeEngineBridge.lastInvocation.failure, 'timeout');

    // Ler de novo não apaga a falha: continua degradado sem nova invocação.
    assert.equal(NativeEngineBridge.checkAvailability().status, 'degraded');
  }));
});

test('R7: uma invocação posterior bem-sucedida recupera para ativo', async () => {
  await withNodeEnv('production', () => withStubs({
    getBinaryPath: () => SELF,
    scan: async () => {
      await wait(5);
      NativeEngineBridge.record({ ok: true, detail: 'ok', at: Date.now() });
      return { ok: true, result: { sha256: 'f'.repeat(64), score: 0, level: 'safe' } };
    },
  }, async () => {
    const afterRecovery = await NativeEngineBridge.probe();
    assert.equal(afterRecovery.status, 'active');
    assert.equal(NativeEngineBridge.checkAvailability().status, 'active');
    assert.equal(NativeEngineBridge.lastInvocation.ok, true);
  }));
});
