import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MalwareAnalyzer } from '../dist/analysis.js';

/**
 * v0.2.2 — latência da deteção por hash conhecido (caso EICAR simples).
 *
 * O SHA-256 do ficheiro inteiro é calculado no início, mas o HashDB só era
 * consultado DEPOIS do ClamAV — que corre como `clamscan` por análise, espera
 * pela vaga global e recarrega a base (~15 s medidos). Uma prova definitiva
 * ficava à espera de um motor que não a podia mudar. E se o ClamAV expirava sob
 * carga, a confiança caía para 0,3 e a quarentena automática ficava bloqueada
 * numa deteção por hash exato.
 *
 * Fixture BENIGNA: texto inofensivo cujo hash a base falsa declara conhecido.
 * Nenhum EICAR é escrito em disco (política do projeto: o Defender interceta).
 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-known-hash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture-benigna.txt');
  const content = 'fixture benigna do CyberSafe para hash conhecido';
  await fs.writeFile(file, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { file, sha256 };
}
function analyzer(sha256, clamav) {
  return new MalwareAnalyzer({
    signatures: { match: (h) => (h === sha256 ? { sha256, family: 'Fixture-Known', severity: 'critical', source: 'fixture' } : undefined) },
    trust: { evaluate: () => ({ decision: 'unknown' }) },
    yara: { scanFile: async () => [] },
    clamav,
  });
}

test('tempo real: hash exato conhecido decide sem esperar pelo ClamAV', async (t) => {
  const { file, sha256 } = await fixture(t);
  let calls = 0;
  const a = analyzer(sha256, { scanFile: async () => { calls++; return { verdict: 'clean', detected: false }; } });
  const r = await a.analyze(file, undefined, undefined, { priority: 'realtime' });
  assert.equal(calls, 0, 'ClamAV não é chamado quando o hash completo já é prova');
  assert.equal(r.verdict, 'malicious');
  assert.ok(r.rulesTriggered.includes('known_bad_hash'));
  assert.ok(!r.rulesTriggered.includes('scan_inconclusive'), 'não é lacuna: a prova existe');
  assert.ok(r.confidence >= 0.99);
  assert.equal(r.severity, 'critical');
  assert.ok(r.factors.some((f) => /ClamAV não consultado/i.test(f.label + ' ' + (f.detail ?? ''))), 'o resultado diz que o ClamAV não analisou');
});

test('análise manual continua a correr o ClamAV mesmo com hash conhecido', async (t) => {
  const { file, sha256 } = await fixture(t);
  let calls = 0;
  const a = analyzer(sha256, { scanFile: async () => { calls++; return { verdict: 'detected', detected: true, detail: 'Fixture' }; } });
  await a.analyze(file);
  assert.equal(calls, 1);
});

test('ClamAV falhado não rebaixa uma deteção por hash exato', async (t) => {
  const { file, sha256 } = await fixture(t);
  const a = analyzer(sha256, { scanFile: async () => ({ verdict: 'error', detected: false, detail: 'timeout' }) });
  const r = await a.analyze(file);
  assert.ok(r.rulesTriggered.includes('scan_inconclusive'), 'a lacuna do ClamAV continua dita');
  assert.ok(r.confidence >= 0.99, 'mas a prova por hash não perde força');
});

test('sem hash conhecido, tempo real continua a usar o ClamAV', async (t) => {
  const { file } = await fixture(t);
  let calls = 0;
  const a = analyzer('outro', { scanFile: async () => { calls++; return { verdict: 'clean', detected: false }; } });
  await a.analyze(file, undefined, undefined, { priority: 'realtime' });
  assert.equal(calls, 1);
});
