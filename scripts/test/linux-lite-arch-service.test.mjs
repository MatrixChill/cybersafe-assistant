import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToken } from '../linux-lite/arch/run-service.mjs';

test('service accepts only its private, existing pipe credential', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'cs-service-'));
  try {
    const dir = join(root, 'secrets');
    mkdirSync(dir, { mode: 0o755 });
    const file = join(dir, 'pipe-credential');
    assert.throws(() => readToken(root, process.getuid()));
    writeFileSync(file, 'a'.repeat(64), { mode: 0o600 });
    assert.equal(readToken(root, process.getuid()), 'a'.repeat(64));
    chmodSync(file, 0o644);
    assert.throws(() => readToken(root, process.getuid()));
    rmSync(file);
    symlinkSync(join(root, 'absent'), file);
    assert.throws(() => readToken(root, process.getuid()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
