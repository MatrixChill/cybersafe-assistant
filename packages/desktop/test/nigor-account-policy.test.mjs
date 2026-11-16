import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveAccountPolicy, NIGOR_RESOURCES } from '../src/nigor-account-policy.ts';

const supported = { platform: 'linux', packaged: true, resourcesPath: NIGOR_RESOURCES };
const marker = JSON.parse(readFileSync(new URL('../../../integrations/nigor/packaging/edition.json', import.meta.url), 'utf8'));

test('only the installed Nigor edition with the complete provisioned identity allows local entry', () => {
  assert.equal(resolveAccountPolicy(supported, () => marker), 'local-optional');
  for (const value of [null, {...marker, package: 'cybersafe-assistant-linux-lite'}, {...marker, accountMode: 'open'}, {...marker, schema:2}]) {
    assert.equal(resolveAccountPolicy(supported, () => value), 'required');
  }
  assert.equal(resolveAccountPolicy(supported, () => { throw Error('untrusted marker'); }), 'required');
});

test('Windows, shared Arch and development cannot opt in through an edition marker', () => {
  for (const options of [
    {...supported, platform: 'win32'}, {...supported, packaged: false},
    {...supported, resourcesPath:'/opt/cybersafe-assistant-linux-lite/resources'},
  ]) {
    assert.equal(resolveAccountPolicy(options, () => { assert.fail('should not probe the marker'); }), 'required');
  }
});
