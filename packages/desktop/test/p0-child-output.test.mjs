import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('embedded service drains both output streams without accumulating logs in the parent', () => {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /serviceProcess\.stdout\?\.resume\(\)/);
  assert.match(source, /serviceProcess\.stderr\?\.resume\(\)/);
});

test('local API drains unused stdout; stderr retains its existing log handler', () => {
  const source = fs.readFileSync(new URL('../src/api-lifecycle.ts', import.meta.url), 'utf8');
  assert.match(source, /child\.stdout\?\.resume\(\)/);
  assert.match(source, /child\.stderr\?\.on\("data"/);
});
