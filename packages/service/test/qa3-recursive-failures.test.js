import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { ScanManager } from '../dist/scan-manager.js';

// Caminho relativo ao FICHEIRO: os testes correm da raiz ou de packages/service.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const uiSource = await fs.readFile(new URL('../../app/src/lib/scanSession.ts', import.meta.url), 'utf8');
const uiJs = ts.transpileModule(uiSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const ui = {};
vm.runInNewContext(uiJs, { exports: ui });
const { showNoThreatsReassurance, terminalResultLabels } = ui;

async function waitForTerminal(manager, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = manager.getScan(id);
    if (state && ['completed', 'failed', 'cancelled'].includes(state.status)) {
      await manager.currentScanPromise;
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Fixture scan did not terminate');
}

// Run actual manager source with only filesystem boundary overridden. No ACL/OS changes.
async function controlledManager(overrides) {
  const source = await fs.readFile(new URL('../src/scan-manager.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const errors = await import('../dist/scan-error.js');
  const fixtureGate = await import('../dist/dev-fixture-gate.js');
  // O scan-manager importa pinFixture de ./fixture-pin.js; sem esta chave o
  // whitelist em baixo rebentava com «Unexpected dependency ./fixture-pin.js»
  // em TODOS os casos desta ficha (5 falhas medidas no log service-full-39f096d)
  // e deixava para trás o diretório fixture, porque o throw acontecia antes do
  // t.after estar registado. Entrega-se o módulo real — este teste só substitui
  // a fronteira do sistema de ficheiros.
  const fixturePin = await import('../dist/fixture-pin.js');
  // O scan-manager tambem importa readBoundedArchiveEntry de @cybersafe/core
  // (src/scan-manager.ts:6). Entrega-se o pacote real: o workspace esta construido
  // antes da suíte e a fronteira substituida aqui e so node:fs/promises.
  const core = await import('@cybersafe/core');
  const deps = { 'node:fs/promises': { ...fs, ...overrides }, 'node:path': path, 'node:os': {}, 'node:crypto': await import('node:crypto'), '@cybersafe/core': core, './scan-error.js': errors, './dev-fixture-gate.js': fixtureGate, './fixture-pin.js': fixturePin };
  const exports = {};
  vm.runInNewContext(js, { exports, require: key => { if (!(key in deps)) throw Error(`Unexpected dependency ${key}`); return deps[key]; }, process, console, Date, Buffer, setInterval, clearInterval, setTimeout, clearTimeout, structuredClone });
  return exports.ScanManager;
}

for (const type of ['quick', 'full']) {
  for (const operation of ['readdir', 'stat']) {
    test(`${type}: nested ${operation} access failure reaches terminal counters and partial UI`, async t => {
      const dir = await fs.mkdtemp(path.join(TEST_DIR, 'qa3-recursive-'));
      await fs.mkdir(path.join(dir, 'blocked'));
      await fs.writeFile(path.join(dir, 'ok.exe'), 'Benign fixture, not executable.');
      await fs.writeFile(path.join(dir, 'skip.js'), 'Benign excluded fixture.');
      const blocked = path.join(dir, 'blocked');
      const Manager = await controlledManager({ [operation]: async (p, ...args) => {
        if (p === blocked) throw Object.assign(Error('Controlled access failure'), { code: 'EACCES' });
        return fs[operation](p, ...args);
      } });
      const calls = [], records = [];
      const engine = { emitScanProgress() {}, isExcluded: p => p.endsWith('skip.js'), exclusionCategory: () => ({ reason: 'extension', detail: '.js' }),
        clearClamavPrefetch() {}, markScanAborted() {}, abortEngineWork() {},
        async scanArtifact(p) { calls.push(p); return { results: [{ analysisState: 'completed', verdict: 'safe' }], highRiskCount: 0, overallSeverity: 'low' }; } };
      const manager = new Manager(engine, { record: async state => records.push(structuredClone(state)) });
      manager.resolvePathsForScan = async () => [dir];
      const id = await manager.startScan(type);
      t.after(async () => { manager.cancelScan(id); await manager.currentScanPromise; await fs.rm(dir, { recursive: true, force: true }); });
      const state = await waitForTerminal(manager, id);
      assert.equal(state.filesFailed, 1, 'one inaccessible subtree, never an invented count of its contents');
      assert.equal(state.failedByReason.permissions_denied, 1);
      assert.equal(state.filesDiscovered, 2, 'only enumerated files, not unknown subtree contents');
      assert.equal(state.filesAnalyzed, 1);
      assert.equal(state.filesExcluded, 1);
      assert.equal(state.filesScanned, 3);
      assert.equal(state.filesTotal, 3);
      assert.equal(calls.length, 1);
      assert.equal(records.at(-1).filesFailed, 1);
      assert.equal(showNoThreatsReassurance('completed', state), false);
      assert.equal(terminalResultLabels('completed', state).chip, 'Parcial');
      assert.equal(state.filesScanned, state.filesAnalyzed + state.filesExcluded + state.filesFailed);
    });
  }
}

test('quick: unreadable file metadata is a failure, not silently omitted', async t => {
  const dir = await fs.mkdtemp(path.join(TEST_DIR, 'qa3-stat-'));
  const file = path.join(dir, 'unknown.txt'); await fs.writeFile(file, 'Benign fixture.');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const Manager = await controlledManager({ stat: async (p, ...args) => { if (p === file) throw Object.assign(Error('Controlled disappearance'), { code: 'ENOENT' }); return fs.stat(p, ...args); } });
  const manager = new Manager({}); const files = [], stats = { failed: 0, failedByReason: {} };
  await manager.gatherFilesQuick(dir, files, 'fixture', 0, 2, 800, stats);
  assert.equal(stats.failed, 1);
  assert.equal(stats.failedByReason.not_found, 1);
  assert.equal(files.length, 0);
});

test('cancelled gather does not walk descendants or count unobserved errors', async () => {
  const manager = new ScanManager({}); manager.isCancelled.add('cancelled');
  const files = [], stats = { failed: 0, failedByReason: {} };
  await manager.gatherFiles('nonexistent-fixture', files, 'cancelled', 50000, stats);
  assert.equal(stats.failed, 0); assert.equal(files.length, 0);
});
