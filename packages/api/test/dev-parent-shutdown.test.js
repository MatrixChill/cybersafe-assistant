import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installDevParentShutdown } from '../dist/dev-parent-shutdown.js';

test('only an isolated owned child accepts parent shutdown, once', async () => {
  const parent = new EventEmitter();
  parent.connected = true;
  let calls = 0;
  const done = installDevParentShutdown(parent, { CYBERSAFE_DEV_ISOLATION: '1', CYBERSAFE_DEV_OWNED_CHILD: '1' }, async () => { calls++; });
  parent.emit('message', { type: 'unrelated' });
  assert.equal(calls, 0);
  parent.emit('message', { type: 'cybersafe:dev:shutdown' });
  parent.emit('disconnect');
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  done();
  assert.equal(parent.listenerCount('message'), 0);
});

test('production and an unowned process expose no parent shutdown listener', () => {
  for (const env of [{}, { NODE_ENV: 'production', CYBERSAFE_DEV_ISOLATION: '1', CYBERSAFE_DEV_OWNED_CHILD: '1' }, { CYBERSAFE_DEV_ISOLATION: '1' }]) {
    const parent = new EventEmitter();
    parent.connected = true;
    installDevParentShutdown(parent, env, async () => { assert.fail('must not close'); });
    assert.equal(parent.listenerCount('message'), 0);
  }
});
