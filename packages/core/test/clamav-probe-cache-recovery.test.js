import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClamavBridge, probeDatabaseDir } from '../dist/clamav.js';
import { makeLoadProofHandle } from './fixtures/clamav-load-proof.js';

// Só o subprocesso de carga é simulado. Versão, classificação, seleção,
// semáforo e ciclo de vida da prova são reais; nenhuma base pessoal é lida.
async function scenario(t) {
  const root = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-cache-'));
  const database = path.join(root, 'database');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let collections = 0;
  let proofs = 0;
  const bridge = new ClamavBridge({
    datadir: database,
    spawn: () => { proofs++; return makeLoadProofHandle(); },
  });
  bridge.collectDatabaseCandidates = async () => {
    collections++;
    return [await probeDatabaseDir(database, 'explicit')];
  };
  t.after(async () => { await bridge.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return {
    bridge, database,
    advance: ms => { now += ms; },
    counts: () => ({ collections, proofs }),
    ready: async () => {
      await fs.mkdir(database, { recursive: true });
      await fs.writeFile(path.join(database, 'main.cvd'), 'fixture, não uma base de produção');
      await fs.writeFile(path.join(database, 'daily.cld'), 'fixture diária, prova pelo seam do subprocesso');
    },
  };
}

test('falha inicial não fica em cache para sempre quando as bases chegam; revalida uma vez após cooldown', async t => {
  const s = await scenario(t);
  assert.equal(await s.bridge.isAvailable(), false);
  await s.ready();
  assert.equal(await s.bridge.isAvailable(), false, 'não repete a sonda a cada leitura');
  assert.equal(s.counts().collections, 1);
  s.advance(30_001);
  assert.deepEqual(await Promise.all([s.bridge.isAvailable(), s.bridge.isAvailable(), s.bridge.isAvailable()]), [true, true, true]);
  assert.equal(s.bridge.health.status, 'active', 'só recupera depois da prova de carga');
  assert.deepEqual(s.counts(), { collections: 2, proofs: 1 });
});

test('cache positiva também expira: remover a base não deixa o estado active indefinidamente', async t => {
  const s = await scenario(t);
  await s.ready();
  assert.equal(await s.bridge.isAvailable(), true);
  await fs.rm(s.database, { recursive: true });
  s.advance(60_000);
  assert.equal(await s.bridge.isAvailable(), true, 'cache positiva evita recarregar a base a cada scan');
  s.advance(240_001);
  assert.equal(await s.bridge.isAvailable(), false);
  assert.equal(s.bridge.health.status, 'degraded');
  assert.deepEqual(s.counts(), { collections: 2, proofs: 1 });
});

test('force ignora cooldown mas continua single-flight; dispose impede novos probes', async t => {
  const s = await scenario(t);
  assert.equal(await s.bridge.isAvailable(), false);
  await s.ready();
  assert.deepEqual(await Promise.all([s.bridge.isAvailable(true), s.bridge.isAvailable(true)]), [true, true]);
  assert.deepEqual(s.counts(), { collections: 2, proofs: 1 });
  await s.bridge.dispose();
  assert.equal(await s.bridge.isAvailable(true), false);
  assert.deepEqual(s.counts(), { collections: 2, proofs: 1 }, 'shutdown não ressuscita o subprocesso');
});

test('binário ClamAV real recupera quando chega uma base local benigna, sem force e sem bases pessoais', async t => {
  const root = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-real-'));
  const database = path.join(root, 'base com espaços');
  const target = path.join(root, 'benigno.txt');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const bridge = new ClamavBridge({ datadir: database });
  bridge.collectDatabaseCandidates = async () => [await probeDatabaseDir(database, 'explicit')];
  t.after(async () => { await bridge.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(await bridge.isAvailable(), false);
  await fs.mkdir(database, { recursive: true });
  await fs.writeFile(path.join(database, 'fixture.ndb'), 'CyberSafe.Test.BenignMarker:0:*:4359424552534146455f42454e49474e5f4d41524b4552\n');
  await fs.writeFile(target, 'Texto benigno, sem o marcador de teste.\n');
  now += 30_001;
  assert.equal(await bridge.isAvailable(), true);
  assert.equal(bridge.health.status, 'degraded', 'base local não é cobertura oficial de produção');
  const outcome = await bridge.scanFiles([target]);
  assert.equal(outcome.files[0].verdict, 'clean');
  await fs.writeFile(target, 'prefixo CYBERSAFE_BENIGN_MARKER sufixo\n');
  const positive = await bridge.scanFiles([target]);
  assert.equal(positive.files[0].verdict, 'detected');
  assert.match(positive.files[0].signature, /CyberSafe\.Test\.BenignMarker/);
});
