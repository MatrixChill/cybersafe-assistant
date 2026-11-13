import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (file) => readFileSync(new URL('../../packages/desktop/src/' + file, import.meta.url), 'utf8');
test('Linux window opts into sandbox and passes its preload settings explicitly', () => {
  assert.match(read('main.ts'), /sandbox: process.platform === "linux"/);
  assert.match(read('main.ts'), /additionalArguments: preloadArguments/);
  assert.doesNotMatch(read('preload.ts'), /process\.env\./);
});
