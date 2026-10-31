import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProtectionEngineService } from '../dist/engine.js';

async function stoppedFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-stop-retry-'));
  const e = new ProtectionEngineService(dir);
  for (const key of ['watcher', 'processMonitor', 'etwConsumer', 'wfpFilter', 'amsiProvider']) e[key].stop = async () => {};
  e.protectionState = true;
  t.after(async () => { e.watcher.stop = async () => {}; await e.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  return e;
}

test('unconfirmed teardown remains a failed stop on retry and blocks activation until confirmed', async t => {
  const e = await stoppedFixture(t);
  let attempts = 0;
  e.watcher.stop = async () => { attempts++; throw new Error('synthetic refusal'); };
  assert.equal((await e.stopProtection()).ok, false);
  assert.equal((await e.stopProtection()).ok, false);
  assert.equal(attempts, 2, 'retry must not use the already-stopped shortcut');
  assert.equal((await e.startProtection()).ok, false, 'must not activate while previous watcher death is unconfirmed');
  e.watcher.stop = async () => {};
  assert.equal((await e.stopProtection()).ok, true);
});

test('a synchronous stop exception cannot skip the other module stops', async t => {
  const e = await stoppedFixture(t);
  let otherStopped = false;
  e.watcher.stop = () => { throw new Error('synthetic synchronous refusal'); };
  e.processMonitor.stop = async () => { otherStopped = true; };
  const result = await e.stopProtection();
  assert.equal(result.ok, false);
  assert.equal(otherStopped, true);
});

test('a stop that never resolves is reported unconfirmed within its own budget', { timeout: 2000 }, async t => {
  const e = await stoppedFixture(t);
  e.watcher.stop = () => new Promise(() => {});
  const started = Date.now();
  const result = await e.stopProtection();
  assert.equal(result.ok, false);
  assert.equal(result.protectionEnabled, false);
  assert.ok(Date.now() - started < 1600);
});

test('TP engine proposal: stop must not acknowledge success when watcher teardown rejects', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-rt-stop-proof-'));
  const e = new ProtectionEngineService(dir);
  for (const part of ['watcher', 'processMonitor', 'etwConsumer', 'wfpFilter', 'amsiProvider']) {
    e[part].start = async () => {}; e[part].stop = async () => {};
  }
  e.updater.startScheduler = () => {}; e.processMonitor.list = async () => [];
  e.hardware.getSnapshot = async () => ({}); e.refreshConnections = async () => {};
  t.after(async () => { e.watcher.stop = async () => {}; await e.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  await e.startProtection();
  e.watcher.stop = async () => { throw Error('synthetic watcher teardown refusal'); };
  const result = await e.stopProtection();
  assert.equal(e.getProtectionState().protectionEnabled, false, 'Admission must stop even when teardown fails');
  assert.equal(result.ok, false, 'A failed teardown must not be acknowledged as success');
});
