import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectionEngineService } from '../../service/dist/engine.js';
import { ServiceClient } from '../src/service-client.ts';
import { readNigorStatus } from '../src/nigor-client.ts';

test('Nigor v1 reads the real service over authenticated Unix IPC', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-nigor-'));
  const token = randomBytes(32).toString('hex');
  const previous = process.env.CYBERSAFE_PIPE_TOKEN;
  let engine;
  try {
    process.env.CYBERSAFE_PIPE_TOKEN = token;
    engine = new ProtectionEngineService(dir);
  } finally {
    if (previous === undefined) delete process.env.CYBERSAFE_PIPE_TOKEN;
    else process.env.CYBERSAFE_PIPE_TOKEN = previous;
  }
  try {
    const socket = join(dir, 'engine.sock');
    await engine.startPipeServer(socket);
    await assert.rejects(readNigorStatus(new ServiceClient(socket, randomBytes(32).toString('hex'))));
    const snapshot = await readNigorStatus(new ServiceClient(socket, token));
    assert.equal(snapshot.version, 1);
    assert.equal(typeof snapshot.serviceRunning, 'boolean');
    assert.equal(snapshot.protection.enabled, false);
    assert.ok(Array.isArray(snapshot.history));
    assert.doesNotMatch(JSON.stringify(snapshot), /engine.sock/);
  } finally {
    await engine.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
