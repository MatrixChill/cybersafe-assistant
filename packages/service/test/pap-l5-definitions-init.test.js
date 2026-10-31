import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProtectionEngineService } from '../dist/engine.js';

test('o arranque não apresenta a sua hora como atualização de definições', () => {
  const source = readFileSync(new URL('../src/engine.ts', import.meta.url), 'utf8');
  const init = source.slice(source.indexOf('private async initInternal()'), source.indexOf('async updateDefinitions()'));
  assert.ok(init.length > 0);
  assert.doesNotMatch(init, /this\.definitionsUpdatedAt\s*=/);
});

test('atualização falhada sem data anterior não inventa data', async () => {
  const context = { definitionsUpdatedAt: '', updater: { checkAndUpdate: async () => ({ yaraUpdated: false, clamUpdated: false, hashesUpdated: false, errors: ['falha'], warnings: [] }) }, eventBus: { publish() {} } };
  const result = await ProtectionEngineService.prototype.updateDefinitions.call(context);
  assert.equal(context.definitionsUpdatedAt, '');
  assert.equal(result.updatedAt, null);
});

test('atualização de um conjunto marca somente a sessão corrente', async () => {
  const context = { definitionsUpdatedAt: '', updater: { checkAndUpdate: async () => ({ yaraUpdated: true, clamUpdated: false, hashesUpdated: false, errors: [], warnings: [] }) }, eventBus: { publish() {} } };
  const result = await ProtectionEngineService.prototype.updateDefinitions.call(context);
  assert.ok(context.definitionsUpdatedAt);
  assert.equal(context.definitionsUpdatedAt, result.checkedAt);
});
