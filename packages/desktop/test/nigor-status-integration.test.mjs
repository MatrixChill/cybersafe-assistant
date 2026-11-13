import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectionEngineService } from '../../service/dist/engine.js';


test('Nigor v1 reads the real service over authenticated Unix IPC', { skip: process.platform !== 'linux' }, async () => {
  const { readNigorStatus, startNigorScan, cancelNigorScan } = await import("../dist/nigor-client.js");
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
    await assert.rejects(readNigorStatus(socket, randomBytes(32).toString('hex')));
    const snapshot = await readNigorStatus(socket, token);
    assert.equal(snapshot.version, 1);
    assert.equal(typeof snapshot.serviceRunning, 'boolean');
    assert.equal(snapshot.protection.enabled, false);
    assert.ok(Array.isArray(snapshot.history));
    assert.doesNotMatch(JSON.stringify(snapshot), /engine.sock/);
    const file = join(dir, "benign.txt");
    await writeFile(file, "CyberSafe consented Nigor scan fixture");
    await assert.rejects(startNigorScan(socket, token, file, false));
    await assert.rejects(startNigorScan(socket, randomBytes(32).toString("hex"), file, true));
    const start = await startNigorScan(socket, token, file, true);
    assert.equal(start.accepted, true);
    assert.equal(start.version, 1);
    assert.doesNotMatch(JSON.stringify(start), /benign|engine.sock/);
    const cancelled = await cancelNigorScan(socket, token, start.scanId, true);
    assert.equal(cancelled.version, 1);
    for (let i = 0; i < 120; i++) {
      const history = await engine.dispatch("scan.history", { limit: 5 });
      if (history.entries.some(entry => entry.id === start.scanId)) break;
      if (i === 119) assert.fail("No terminal scan history after consented scan/cancel");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    await engine.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
