import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClamavBridge, classifyClamavHealth } from '../dist/clamav.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-readonly-fallback-'));
after(() => fs.rm(root, { recursive: true, force: true }));
let sequence = 0;
async function setup() {
  const dir = path.join(root, String(sequence++));
  const definitionsDir = path.join(dir, 'definitions');
  const fallback = path.join(dir, 'packaged');
  await fs.mkdir(fallback, { recursive: true });
  await fs.writeFile(path.join(fallback, 'fixture.ndb'), 'Fixture:0:*:616263646566');
  let checks = 0;
  const bridge = new ClamavBridge({ definitionsDir, fallbackDatabaseDir: async () => { checks++; return fallback; } });
  // No binary/network/host DB: exercise the real candidate collector with isolated paths.
  bridge.clamconfDatabaseDirs = async () => [];
  const collect = async () => (await bridge.collectDatabaseCandidates()).filter(c => c.source !== 'platform-default');
  return { dir, definitionsDir, fallback, bridge, collect, checks: () => checks };
}

test('first run selects packaged DB read-only without creating a mutable database', async () => {
  const x = await setup();
  const candidates = await x.collect();
  assert.equal(candidates.at(-1).source, 'packaged-fallback');
  assert.equal(candidates.at(-1).dir, x.fallback);
  assert.equal(candidates.at(-1).state, 'ready');
  assert.equal(x.checks(), 1);
  assert.equal(candidates.at(-1).newestMtimeMs, 1, 'unknown daily publication age cannot become fresh');
  await assert.rejects(fs.stat(x.definitionsDir), { code: 'ENOENT' });
});

test('freshclam arrival switches to mutable DB on next collection without merging or deleting seed', async () => {
  const x = await setup();
  await x.collect();
  await fs.mkdir(path.join(x.definitionsDir, 'clamav'), { recursive: true });
  await fs.writeFile(path.join(x.definitionsDir, 'clamav', 'daily.cld'), 'UPDATER');
  const candidates = await x.collect();
  assert.equal(candidates.some(c => c.source === 'packaged-fallback'), false);
  assert.equal(x.checks(), 1);
  assert.equal(await fs.readFile(path.join(x.fallback, 'fixture.ndb'), 'utf8'), 'Fixture:0:*:616263646566');
  assert.equal(await fs.readFile(path.join(x.definitionsDir, 'clamav', 'daily.cld'), 'utf8'), 'UPDATER');
});

test('explicit empty database remains authoritative: no hidden fallback', async () => {
  const x = await setup();
  x.bridge.options.datadir = path.join(x.dir, 'explicit-empty');
  const candidates = await x.collect();
  assert.equal(candidates.some(c => c.source === 'packaged-fallback'), false);
  assert.equal(x.checks(), 0);
});

test('unreadable mutable database is not an empty first run', async () => {
  const x = await setup();
  await fs.mkdir(x.definitionsDir, { recursive: true });
  await fs.writeFile(path.join(x.definitionsDir, 'clamav'), 'NOT A DIRECTORY');
  const candidates = await x.collect();
  assert.equal(candidates.some(c => c.source === 'packaged-fallback'), false);
  assert.equal(x.checks(), 0);
});

test('daily header age, not install mtime, controls fallback freshness', async () => {
  const x = await setup();
  const epoch = Math.floor((Date.now() - 9 * 86400000) / 1000);
  await fs.writeFile(path.join(x.fallback, 'daily.cld'), `ClamAV-VDB:date:1:1:90:X:X:publisher:${epoch}`);
  const candidates = await x.collect();
  assert.equal(candidates.at(-1).newestMtimeMs, epoch * 1000);
  const health = classifyClamavHealth({ versionOutput: 'ClamAV 1.5.4', dbDir: null, dbFiles: null, candidates });
  assert.equal(health.available, false);
  assert.equal(health.health.status, 'degraded');
});

test('rejected fallback leaves truthful missing state and no side effects', async () => {
  const x = await setup();
  x.bridge.options.fallbackDatabaseDir = async () => null;
  assert.equal((await x.collect()).some(c => c.source === 'packaged-fallback'), false);
  await assert.rejects(fs.stat(x.definitionsDir), { code: 'ENOENT' });
});
