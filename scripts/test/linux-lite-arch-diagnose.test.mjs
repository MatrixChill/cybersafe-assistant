import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../linux-lite/arch/diagnose.mjs';

test('diagnostics separates missing commands from engine health', () => {
  const result = diagnose({ platform: 'linux', uid: 1000, session: 'wayland',
    hasCommand: (name) => name === 'clamscan' || name === 'yara' });
  assert.equal(result.launchable, true);
  assert.equal(result.clamav.commandsPresent, true);
  assert.equal(result.clamav.health, 'unknown');
  assert.equal(result.yara.commandsPresent, false);
  assert.equal(result.yara.health, 'unknown');
});

test('root and non-Linux sessions cannot pass the launcher prerequisites', () => {
  for (const [platform, uid, session] of [['linux', 0, 'x11'], ['win32', 1000, 'x11'], ['linux', 1000, null]]) {
    assert.equal(diagnose({ platform, uid, session, hasCommand: () => true }).launchable, false);
  }
});
