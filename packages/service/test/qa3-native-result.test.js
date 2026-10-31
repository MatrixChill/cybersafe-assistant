import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtectionEngineService } from '../dist/engine.js';
import { NativeEngineBridge } from '../dist/native-engine-bridge.js';

// Caminho relativo ao FICHEIRO: os testes correm da raiz ou de packages/service.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function fixture(t, outcome, verdict = 'safe') {
  const dir = await fs.mkdtemp(path.join(TEST_DIR, 'qa3-native-'));
  const file = path.join(dir, 'benign.txt');
  await fs.writeFile(file, 'Benign QA3 coverage fixture.');
  const engine = new ProtectionEngineService(dir);
  engine.vt.isEnabled = () => false;
  engine.prefetchClamav = async () => ({ spawned: false });
  engine.logHistory = async () => {};
  engine.actionsLog.write = async () => {};
  engine.analyzer.analyze = async () => ({ fileName: 'benign.txt', size: 26, sha256: 'a'.repeat(64), verdict,
    severity: verdict === 'malicious' ? 'critical' : 'low', riskScore: verdict === 'malicious' ? 100 : 0,
    confidence: 0.9, rulesTriggered: [], factors: [], recommendedAction: verdict === 'malicious' ? 'quarantined' : 'allowed', scanTimestamp: new Date().toISOString() });
  const original = NativeEngineBridge.scan;
  NativeEngineBridge.scan = async () => outcome;
  const events = [];
  engine.eventBus.on('event', event => events.push(event));
  t.after(async () => { NativeEngineBridge.scan = original; await engine.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  return { engine, file, events };
}

for (const failure of ['unavailable', 'timeout', 'spawn', 'exit', 'output', 'cancelled']) {
  test(`native ${failure} is explicit in result and event, never safe/completed`, async t => {
    const { engine, file, events } = await fixture(t, { ok: false, result: null, failure, error: 'private arbitrary bridge diagnostic' });
    const response = await engine.scanArtifact(file, 'system-scanner', { skipVirusTotal: true, readOnly: true });
    const result = response.results[0];
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.analysisState, failure === 'unavailable' ? 'engine-unavailable' : failure === 'cancelled' ? 'inconclusive' : 'failed');
    assert.ok(result.nativeEngine, 'per-file native outcome must be present');
    assert.equal(result.nativeEngine.status, failure === 'unavailable' ? 'unavailable' : failure === 'cancelled' ? 'cancelled' : 'error');
    assert.equal(result.nativeEngine.failure, failure);
    assert.match(result.detail, /nativo/i);
    assert.ok(!result.detail.includes('private arbitrary'));
    const event = events.find(e => e.type === 'artifact.analyzed');
    assert.equal(event.data.verdict, 'inconclusive');
    assert.equal(event.data.nativeEngine.status, result.nativeEngine.status);
    assert.equal(events.some(e => e.type === 'threat.detected'), false);
  });
}

test('real bridge with binary absent propagates unavailable without spawning', async t => {
  const realScan = NativeEngineBridge.scan.bind(NativeEngineBridge);
  const { engine, file } = await fixture(t, null);
  NativeEngineBridge.scan = realScan;
  const exists = syncFs.existsSync;
  syncFs.existsSync = p => String(p).endsWith('scan-engine.exe') ? false : exists(p);
  syncBuiltinESMExports();
  t.after(() => { syncFs.existsSync = exists; syncBuiltinESMExports(); });
  const result = (await engine.scanArtifact(file, 'system-scanner', { skipVirusTotal: true, readOnly: true })).results[0];
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.analysisState, 'engine-unavailable');
  assert.equal(result.nativeEngine.status, 'unavailable');
  assert.equal(NativeEngineBridge.pendingChildren, 0);
});

test('successful native execution preserves benign completed result', async t => {
  const { engine, file } = await fixture(t, { ok: true, result: { score: 0, reasons: [] } });
  const result = (await engine.scanArtifact(file, 'system-scanner', { skipVirusTotal: true, readOnly: true })).results[0];
  assert.equal(result.verdict, 'safe');
  assert.equal(result.analysisState, 'completed');
  assert.ok(result.nativeEngine, 'per-file native outcome must be present');
  assert.equal(result.nativeEngine.status, 'completed');
});

test('native unavailable flows through ScanManager as inconclusive coverage', async t => {
  const { engine, file } = await fixture(t, { ok: false, result: null, failure: 'unavailable' });
  let terminal;
  engine.emitScanProgress = state => { if (['completed', 'failed', 'cancelled'].includes(state.status)) terminal = structuredClone(state); };
  engine.scanManager.resolvePathsForScan = async () => [file];
  await engine.scanManager.startScan('custom', file, { readOnly: true });
  await engine.scanManager.currentScanPromise;
  assert.equal(terminal.filesAnalyzed, 1, 'file reached available analyzer engines');
  assert.equal(terminal.filesInconclusive, 1, 'native coverage gap is not a completed negative');
  assert.equal(terminal.filesFailed, 0, 'engine unavailable is not a filesystem failure');
  assert.equal(terminal.threatsFound, 0);
});

test('native success does not erase another engine inconclusive result', async t => {
  const { engine, file } = await fixture(t, { ok: true, result: { score: 0, reasons: [] } }, 'inconclusive');
  const result = (await engine.scanArtifact(file, 'system-scanner', { skipVirusTotal: true, readOnly: true })).results[0];
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.analysisState, 'inconclusive');
});

test('native success with a positive detection cannot erase an upstream engine coverage gap', async t => {
  const { engine, file, events } = await fixture(t, { ok: true, result: { score: 0, reasons: [] } }, 'malicious');
  const analyze = engine.analyzer.analyze;
  engine.analyzer.analyze = async (...args) => {
    const result = await analyze(...args);
    result.rulesTriggered.push('scan_inconclusive');
    result.factors.push({ id: 'clamav-inconclusive', label: 'ClamAV unavailable', weight: 0, category: 'heuristic' });
    return result;
  };
  const result = (await engine.scanArtifact(file, 'system-scanner', { skipVirusTotal: true, readOnly: true })).results[0];
  assert.equal(result.verdict, 'malicious', 'positive evidence is retained');
  assert.equal(result.nativeEngine.status, 'completed');
  assert.equal(result.analysisState, 'inconclusive', 'coverage is separate from detection and native success');
  assert.match(result.detail, /motor/i);
  assert.equal(events.find(e => e.type === 'artifact.analyzed').data.analysisState, 'inconclusive');
});

test('native gap never erases positive evidence from other engines', async t => {
  const { engine, file, events } = await fixture(t, { ok: false, result: null, failure: 'unavailable' }, 'malicious');
  const result = (await engine.scanArtifact(file, 'system-scanner', { skipVirusTotal: true, readOnly: true })).results[0];
  assert.equal(result.verdict, 'malicious');
  assert.equal(result.analysisState, 'engine-unavailable');
  assert.equal(result.nativeEngine.status, 'unavailable');
  assert.equal(events.some(e => e.type === 'threat.detected'), true);
  assert.ok(await fs.stat(file));
});
