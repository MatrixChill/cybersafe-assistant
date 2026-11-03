import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInconclusiveReason } from '../dist/scan-manager.js';

test('classifica apenas sinais que o detalhe do motor contem', () => {
  assert.equal(classifyInconclusiveReason('failed', 'scan timeout after 30000ms'), 'timeout');
  assert.equal(classifyInconclusiveReason('failed', 'ETIMEDOUT'), 'timeout');
  assert.equal(classifyInconclusiveReason('failed', 'invalid engine output'), 'invalid-output');
  assert.equal(classifyInconclusiveReason('failed', 'file changed during analysis'), 'file-changed');
  assert.equal(classifyInconclusiveReason('inconclusive', 'archive coverage incomplete'), 'archive-incomplete');
  assert.equal(classifyInconclusiveReason('inconclusive', 'cancelled by user'), 'cancelled');
});

test('mantem as causas genericas quando nao ha sinal especifico', () => {
  assert.equal(classifyInconclusiveReason('engine-unavailable', 'engine offline'), 'engine-unavailable');
  assert.equal(classifyInconclusiveReason('failed', 'unknown engine error'), 'engine-failed');
  assert.equal(classifyInconclusiveReason('inconclusive', 'coverage gap'), 'coverage-incomplete');
  assert.equal(classifyInconclusiveReason(undefined, undefined), 'no-verdict');
});
