import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngineBridge } from '../dist/native-engine-bridge.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('Linux C++ engine scans a benign fixture and reports the exact digest', {
  skip: process.platform !== 'linux' || process.env.CYBERSAFE_TEST_LINUX_NATIVE !== '1',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-native-'));
  try {
    const file = join(dir, 'benign.txt');
    const content = 'CyberSafe benign native fixture\n';
    await writeFile(file, content);
    const outcome = await NativeEngineBridge.scan(file);
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.result.sha256, createHash('sha256').update(content).digest('hex'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
