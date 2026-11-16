import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefinitionUpdater } from '../dist/updater.js';
import { ClamDatabaseGate } from '../dist/clam-database-gate.js';

async function run(output, channel = 'stdout') {
  const root = await mkdtemp(join(tmpdir(), 'cs-cooldown-'));
  const gate = new ClamDatabaseGate();
  const updater = new DefinitionUpdater(root, {
    gate,
    spawnFreshclam() {
      const child = new EventEmitter();
      child.pid = 5150;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child[channel].emit('data', Buffer.from(output));
        child.emit('close', 0);
      });
      return child;
    },
  });
  try {
    await updater.updateClamAV();
  } finally {
    assert.equal(gate.state.updateActive, false, 'closed child must release the database lease');
    await rm(root, { recursive: true, force: true });
  }
}

test('FreshClam cooldown with exit zero cannot report definitions checked', async () => {
  for (const channel of ['stdout', 'stderr']) {
    await assert.rejects(run('WARNING: You are still on cool-down until after: 2026-11-14 02:16:40\n', channel), /CDN/);
  }
});

test('a past CDN warning does not reject a subsequently successful check', async () => {
  await run('WARNING: FreshClam previously received error code 429 or 403\ndaily.cvd database is up-to-date\n');
});
