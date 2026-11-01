import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canAutoQuarantine, loadQuarantinePolicy, saveQuarantinePolicy } from '../dist/quarantine-policy.js';

const fixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-policy-'));
  return { dir, file: path.join(dir, 'protection-policy.json') };
};
const analysis = (over = {}) => ({ severity: 'critical', verdict: 'malicious', confidence: 0.99, rulesTriggered: ['known_bad_hash'], ...over });

test('omissao segura: sem ficheiro a politica e warn', async () => {
  const { dir, file } = await fixture();
  try { assert.equal(await loadQuarantinePolicy(file), 'warn'); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('automatico exige consentimento literal e nao escreve nada sem ele', async () => {
  const { dir, file } = await fixture();
  try {
    for (const consent of [undefined, false, 'true', 1]) {
      const r = await saveQuarantinePolicy(file, 'automatic-high-confidence', consent);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'consent_required');
      assert.equal(r.policy, 'warn');
    }
    await assert.rejects(fs.access(file), 'o ficheiro nao pode existir');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('consentimento verdadeiro persiste e e relido pelo loader', async () => {
  const { dir, file } = await fixture();
  try {
    const r = await saveQuarantinePolicy(file, 'automatic-high-confidence', true);
    assert.deepEqual(r, { ok: true, policy: 'automatic-high-confidence' });
    assert.equal(await loadQuarantinePolicy(file), 'automatic-high-confidence');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(raw, { quarantinePolicy: 'automatic-high-confidence' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('desativar e explicito e nao perde a preferencia anterior em caso invalido', async () => {
  const { dir, file } = await fixture();
  try {
    await saveQuarantinePolicy(file, 'automatic-high-confidence', true);
    const invalido = await saveQuarantinePolicy(file, 'automatic', true);
    assert.equal(invalido.ok, false);
    assert.equal(invalido.error, 'policy_invalid');
    assert.equal(await loadQuarantinePolicy(file), 'automatic-high-confidence');
    const ask = await saveQuarantinePolicy(file, 'ask');
    assert.deepEqual(ask, { ok: true, policy: 'ask' });
    assert.equal(await loadQuarantinePolicy(file), 'ask');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('criterios de elevada confianca continuam fechados', () => {
  assert.equal(canAutoQuarantine('automatic-high-confidence', analysis()), true);
  for (const over of [{ severity: 'high' }, { verdict: 'suspicious' }, { confidence: 0.98 }, { rulesTriggered: [] }])
    assert.equal(canAutoQuarantine('automatic-high-confidence', analysis(over)), false);
  assert.equal(canAutoQuarantine('warn', analysis()), false);
  assert.equal(canAutoQuarantine('automatic-high-confidence', analysis({ verdict: 'inconclusive' })), false);
});
