import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MalwareAnalyzer } from '@cybersafe/core';
import { canAutoQuarantine } from '../dist/quarantine-policy.js';

// v0.2.2: deteção → isolamento automático só quando a política o autoriza e a
// prova é um hash exato verificado. Fixture benigna; nenhum EICAR em disco.
async function realtimeKnownHash(t, clamav) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-aq-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.txt'); const content = 'fixture benigna auto-quarentena';
  await fs.writeFile(file, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const a = new MalwareAnalyzer({
    signatures: { match: (h) => (h === sha256 ? { sha256, family: 'Fixture', severity: 'critical', source: 'fixture' } : undefined) },
    trust: { evaluate: () => ({ decision: 'unknown' }) }, yara: { scanFile: async () => [] }, clamav,
  });
  return a;
  }

test('tempo real com hash exato: elegível só com automatic-high-confidence', async (t) => {
  const a = await realtimeKnownHash(t, { scanFile: async () => { throw new Error('não devia ser chamado'); } });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-aq2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const r = await a.analyze(path.join(os.tmpdir(), path.basename(dir), '..', path.basename(dir)) && (await fs.readdir(os.tmpdir())).length >= 0 ? await (async () => { const f = path.join(dir, 'x.txt'); await fs.writeFile(f, 'fixture benigna auto-quarentena'); return f; })() : '', undefined, undefined, { priority: 'realtime' });
  assert.equal(canAutoQuarantine('automatic-high-confidence', r), true);
  assert.equal(canAutoQuarantine('warn', r), false);
  assert.equal(canAutoQuarantine('ask', r), false);
});

test('ClamAV a falhar sob carga já não bloqueia o isolamento por hash exato (análise manual)', async (t) => {
  const a = await realtimeKnownHash(t, { scanFile: async () => ({ verdict: 'error', detected: false, detail: 'timeout' }) });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-aq3-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'x.txt'); await fs.writeFile(f, 'fixture benigna auto-quarentena');
  const r = await a.analyze(f);
  assert.equal(canAutoQuarantine('automatic-high-confidence', r), true);
});

test('deteção só por ClamAV (ex.: EICAR em ZIP) nunca é isolada automaticamente', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-aq4-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'arquivo.zip'); await fs.writeFile(f, 'conteudo benigno');
  const a = new MalwareAnalyzer({ signatures: { match: () => undefined }, trust: { evaluate: () => ({ decision: 'unknown' }) },
    yara: { scanFile: async () => [] }, clamav: { scanFile: async () => ({ verdict: 'detected', detected: true, detail: 'Fixture.Sig' }) } });
  const r = await a.analyze(f, undefined, undefined, { priority: 'realtime' });
  assert.ok(r.rulesTriggered.includes('known_malware'));
  assert.equal(canAutoQuarantine('automatic-high-confidence', r), false);
});
