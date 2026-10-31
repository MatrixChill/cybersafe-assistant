import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProtectionEngineService } from '../dist/engine.js';

async function waitFor(fn, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('Prazo excedido a aguardar comportamento real');
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-rt-authorized-'));
  const root = path.join(dir, 'watched'); await fs.mkdir(root);
  const e = new ProtectionEngineService(path.join(dir, 'state'));
  await fs.mkdir(path.join(dir, 'state'), { recursive: true });
  // Keep the real file watcher/child. Never allow its default personal roots.
  e.watcher.getDefaultPaths = () => [root];
  e.watcher.captureRegistrySnapshot = async () => {};
  for (const part of ['processMonitor', 'etwConsumer', 'wfpFilter', 'amsiProvider']) {
    e[part].start = async () => {}; e[part].stop = async () => {};
  }
  e.updater.startScheduler = () => {}; e.updater.stopScheduler = () => {};
  e.processMonitor.list = async () => []; e.hardware.getSnapshot = async () => ({});
  e.refreshConnections = async () => {};
  e.bindEventBus(); e.bindWatchers();
  t.after(async () => { await e.stopProtection(); await e.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  return { e, dir, root };
}

test('TP realtime: real temporary watcher -> real Scanner -> detection/history -> OFF -> teardown', { timeout: 35000 }, async t => {
  const { e, dir, root } = await fixture(t);
  const content = 'Innocuous synthetic realtime fixture, registered only in this instance.\n';
  const sha256 = createHash('sha256').update(content).digest('hex');
  // Public in-memory registration; no production HashDB or engine source changes.
  e.signatures.add({ sha256, family: 'TP-SYNTHETIC-NOT-MALWARE', severity: 'critical', source: 'isolated-test' });
  const result = await e.startProtection();
  assert.equal(result.ok, true);
  assert.deepEqual(e.getProtectionState().engine.monitoredPaths, [root]);
  assert.equal(e.getProtectionState().protectionEnabled, true);
  for (const key of ['yara', 'clamav', 'nativeEngine']) assert.notEqual(e.getProtectionState().engine[key].status, 'active', `${key} must not be invented active`);
  const file = path.join(root, 'fixture.txt'); await fs.writeFile(file, content);
  const analysis = await waitFor(() => e.eventBus.getReplay().find(x => x.type === 'artifact.analyzed' && x.data.sha256 === sha256));
  assert.equal(analysis.data.verdict, 'malicious');
  assert.notEqual(analysis.data.analysisState, 'completed', 'Unavailable engines must remain explicit: ' + JSON.stringify({ result: analysis.data, engines: e.getProtectionState().engine }));
  assert.ok(e.eventBus.getReplay().some(x => x.type === 'file.created' && x.data.path === file));
  assert.ok(e.eventBus.getReplay().some(x => x.type === 'threat.detected' && x.data.sha256 === sha256));
  await waitFor(async () => (await fs.readFile(path.join(dir, 'state/history.jsonl'), 'utf8').catch(() => '')).includes(sha256));
  await waitFor(async () => (await fs.readFile(path.join(dir, 'state/logs/security-events.log'), 'utf8').catch(() => '')).includes('threat.detected'));
  const modified = 'Ordinary modified text without a registered signature.\n';
  const modifiedHash = createHash('sha256').update(modified).digest('hex'); await fs.writeFile(file, modified);
  const next = await waitFor(() => e.eventBus.getReplay().find(x => x.type === 'artifact.analyzed' && x.data.sha256 === modifiedHash));
  assert.equal(next.data.verdict, 'inconclusive');
  assert.ok(e.eventBus.getReplay().some(x => x.type === 'file.modified' && x.data.path === file));
  const watcherPid = e.watcher.watcher.pid;
  assert.ok(watcherPid > 0); process.kill(watcherPid, 0);
  const background = e.backgroundAbort.signal;
  assert.equal((await e.stopProtection()).protectionEnabled, false);
  assert.equal(background.aborted, true);
  assert.deepEqual(e.getProtectionState().engine.monitoredPaths, []);
  const count = e.eventBus.getReplay().filter(x => x.type === 'artifact.analyzed').length;
  await fs.writeFile(path.join(root, 'after-off.txt'), content);
  await new Promise(r => setTimeout(r, 3300));
  assert.equal(e.eventBus.getReplay().filter(x => x.type === 'artifact.analyzed').length, count);
  assert.equal(e.watcher.watcher, null, 'child watcher torn down');
  assert.throws(() => process.kill(watcherPid, 0), { code: 'ESRCH' }, 'OS confirms child exit');
  assert.equal(e.realtimeQueue.active, 0); assert.equal(e.realtimeQueue.size, 0);
  console.log(JSON.stringify({ root, realWatcher: true, realAnalyzer: true, detectionSha256: sha256, modifiedSha256: modifiedHash, engines: e.getProtectionState().engine, offConfirmed: true }));
});

test('TP realtime: OFF aborts analysis admitted by a real watcher and prevents late publication', { timeout: 20000 }, async t => {
  const { e, root } = await fixture(t);
  let receivedSignal; let entered = false;
  // Deliberate slow-engine boundary, not a claim that that engine completed.
  e.analyzer.analyze = async (_file, _signer, _status, options) => {
    receivedSignal = options.signal; entered = true;
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  await e.startProtection();
  const watcherPid = e.watcher.watcher.pid;
  await fs.writeFile(path.join(root, 'slow.txt'), 'Benign slow-engine cancellation fixture.');
  await waitFor(() => entered);
  assert.equal(receivedSignal.aborted, false);
  await e.stopProtection();
  assert.equal(receivedSignal.aborted, true);
  await waitFor(() => e.realtimeQueue.active === 0);
  assert.equal(e.eventBus.getReplay().some(x => ['artifact.analyzed', 'threat.detected'].includes(x.type)), false);
  assert.throws(() => process.kill(watcherPid, 0), { code: 'ESRCH' });
  assert.equal(e.realtimeQueue.size, 0);
});

test('TP realtime: inaccessible authorized root refuses activation and publishes OFF', async t => {
  const { e, root } = await fixture(t); await fs.rm(root, { recursive: true });
  const result = await e.startProtection();
  assert.equal(result.ok, false); assert.equal(result.protectionEnabled, false);
  assert.ok(result.failures.some(x => x.label === 'watcher'));
  assert.equal(e.getProtectionState().protectionEnabled, false);
  assert.equal(e.watcher.watcher, null);
  assert.ok(e.eventBus.getReplay().some(x => x.type === 'protection.changed' && x.data.protectionEnabled === false));
});
