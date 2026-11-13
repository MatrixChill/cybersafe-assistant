import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificationPassed, selectLinuxTargets } from '../linux-lite/package-linux.mjs';

test('verification requires an inspected artifact of each requested format', () => {
  assert.equal(verificationPassed([], []), false);
  assert.equal(verificationPassed([{ format: 'deb', ok: true }], ['deb', 'AppImage']), false);
  assert.equal(verificationPassed([{ format: 'deb', ok: false }], []), false);
  assert.equal(verificationPassed([{ format: 'deb', ok: true }], ['deb']), true);
  assert.equal(verificationPassed([{ format: 'deb', ok: true }, { format: 'AppImage', ok: false }], ['deb']), false);
});
test('Arch staging selects the unpacked Linux target and rejects ambiguous options', () => {
  assert.deepEqual(selectLinuxTargets(['--arch-stage']), ['dir']);
  assert.deepEqual(selectLinuxTargets(['--deb-only']), ['deb']);
  assert.deepEqual(selectLinuxTargets([]), ['deb', 'AppImage']);
  assert.throws(() => selectLinuxTargets(['--arch-stage', '--deb-only']));
});
