import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeFileQueue } from '../dist/realtime-file-queue.js';
const tick = () => new Promise(r => setImmediate(r));

test('TP queue: latest version reverting to running fingerprint replaces the pending version', async () => {
  const q = new RealtimeFileQueue(); const calls = []; let release;
  q.enqueue('file', 'A', async () => { calls.push('A-running'); await new Promise(r => release = r); });
  q.enqueue('file', 'B', async () => { calls.push('B-stale'); });
  const admission = q.enqueue('file', 'A', async () => { calls.push('A-latest'); });
  release(); await tick(); await tick();
  assert.equal(admission, 'queued');
  assert.deepEqual(calls, ['A-running', 'A-latest']);
  assert.equal(q.active, 0); assert.equal(q.size, 0);
});

test('TP queue: recent A cannot suppress A when a different B is running', async () => {
  const q = new RealtimeFileQueue(); const calls = []; let release;
  q.enqueue('file', 'A', async () => { calls.push('A-completed'); }); await tick();
  q.enqueue('file', 'B', async () => { calls.push('B-running'); await new Promise(r => release = r); });
  const admission = q.enqueue('file', 'A', async () => { calls.push('A-latest'); });
  release(); await tick(); await tick();
  assert.equal(admission, 'queued');
  assert.deepEqual(calls, ['A-completed', 'B-running', 'A-latest']);
});

test('TP queue: synchronous callback error releases the slot and permits a retry', async () => {
  const q = new RealtimeFileQueue(); let calls = 0;
  assert.doesNotThrow(() => q.enqueue('file', 'A', () => { throw Error('synthetic synchronous failure'); }));
  q.enqueue('other', 'B', async () => { calls++; });
  await tick(); await tick(); assert.equal(calls, 1); assert.equal(q.active, 0);
  assert.equal(q.enqueue('file', 'A', async () => { calls++; }), 'queued');
  await tick(); assert.equal(calls, 2);
});

test('TP queue: Downloads (high) passa a frente da fila normal sem perder versao', async () => {
  const q = new RealtimeFileQueue(8); const calls = []; let release;
  q.enqueue('a', 'v1', async () => { calls.push('a'); await new Promise(r => release = r); });
  q.enqueue('b', 'v1', async () => { calls.push('b'); });
  q.enqueue('c', 'v1', async () => { calls.push('c'); }, 'high');
  release(); await tick(); await tick(); await tick();
  assert.deepEqual(calls, ['a', 'c', 'b']);
});

test('TP queue: evento high sobe um caminho que ja esperava sem duplicar', async () => {
  const q = new RealtimeFileQueue(8); const calls = []; let release;
  q.enqueue('a', 'v1', async () => { calls.push('a'); await new Promise(r => release = r); });
  q.enqueue('b', 'v1', async () => { calls.push('b-old'); });
  assert.equal(q.enqueue('b', 'v1', async () => { calls.push('b-new'); }, 'high'), 'queued');
  release(); await tick(); await tick();
  assert.deepEqual(calls, ['a', 'b-new']);
});
