import test from 'node:test';
import assert from 'node:assert/strict';
import { startNigorScan } from '../dist/nigor-client.js';

test('Nigor scan rejects missing consent or relative paths before connecting', async () => {
  for (const [path, consent] of [['/tmp/fixture', false], ['relative', true], ['/tmp/fixture', 'true']]) {
    await assert.rejects(startNigorScan(undefined, 'a'.repeat(64), path, consent));
  }
});
