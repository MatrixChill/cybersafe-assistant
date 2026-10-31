import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcRequestQueue } from '../dist/rpc-request-queue.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('R7: the queue refuses work beyond its outstanding ceiling instead of growing', () => {
  const q = new RpcRequestQueue(1, 2);
  const blocked = new Promise(() => {});
  assert.equal(q.enqueue(true, () => blocked), true);
  assert.equal(q.enqueue(true, async () => {}), true);
  assert.equal(q.enqueue(true, async () => {}), false, 'terceiro pedido excede o tecto de 2 em voo');
  assert.equal(q.outstandingCount, 2);
});

test('R7: a refused request is never executed later', async () => {
  const q = new RpcRequestQueue(1, 1);
  let ranRefused = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  q.enqueue(true, () => gate);
  assert.equal(q.enqueue(true, async () => { ranRefused = true; }), false);
  release();
  await wait(10);
  assert.equal(ranRefused, false);
});

test('R7: reads stay concurrent up to maxReads and a mutation remains a barrier', async () => {
  const q = new RpcRequestQueue(2, 8);
  let active = 0;
  let peak = 0;
  const order = [];
  const read = (n) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(5);
    active -= 1;
    order.push(n);
  };
  q.enqueue(true, read(1));
  q.enqueue(true, read(2));
  q.enqueue(true, read(3));
  q.enqueue(false, async () => {
    assert.equal(active, 0, 'mutação nunca corre com leitura activa');
    order.push('write');
  });
  q.enqueue(true, async () => { order.push('after'); });
  await wait(60);
  assert.equal(peak, 2);
  assert.ok(order.indexOf('write') > order.indexOf(3));
  assert.ok(order.indexOf('after') > order.indexOf('write'));
});

test('R7: closing refuses new work and discards what was waiting', async () => {
  const q = new RpcRequestQueue(1, 4);
  let ran = 0;
  q.enqueue(true, async () => { ran += 1; await wait(20); });
  await wait(5); // o primeiro já arrancou; o segundo ainda espera
  assert.equal(q.enqueue(true, async () => { ran += 1; }), true);
  q.close();
  assert.equal(q.enqueue(true, async () => { ran += 1; }), false);
  await wait(35);
  assert.equal(ran, 1);
  assert.equal(q.pendingCount, 0);
});
