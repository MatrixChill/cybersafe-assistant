import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificationPassed } from '../linux-lite/package-linux.mjs';

test('verification requires an inspected artifact of each requested format', () => {
  assert.equal(verificationPassed([], []), false);
  assert.equal(verificationPassed([{ format: 'deb', ok: true }], ['deb', 'AppImage']), false);
  assert.equal(verificationPassed([{ format: 'deb', ok: false }], []), false);
  assert.equal(verificationPassed([{ format: 'deb', ok: true }], ['deb']), true);
  assert.equal(verificationPassed([{ format: 'deb', ok: true }, { format: 'AppImage', ok: false }], ['deb']), false);
});
