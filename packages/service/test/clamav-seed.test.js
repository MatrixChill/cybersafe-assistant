import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedClamavDatabase, CLAMAV_SEED_PINS } from '../dist/clamav-seed.js';
import { EXPECTED_CLAMAV_SEED } from '../../../scripts/clamav-seed-bundle.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-readonly-seed-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
test('runtime and packaging pins are exactly identical', () => assert.deepEqual(CLAMAV_SEED_PINS, EXPECTED_CLAMAV_SEED));
test('no seed means no I/O or invented availability', async () => {
  assert.equal((await seedClamavDatabase({ definitionsDir: path.join(root, 'never-created') })).status, 'not-provided');
  assert.equal(fs.existsSync(path.join(root, 'never-created')), false);
});
test('invalid resource never touches mutable destination and logs no private path', async () => {
  const result = await seedClamavDatabase({ seedDir: path.join(root, 'missing'), get definitionsDir() { throw new Error('must not read mutable location'); } });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason.includes(root), false);
});
test('junction resources are refused before content access; destination remains intact', async () => {
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'main.cvd'), 'USER');
  const link = path.join(root, 'linked');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await seedClamavDatabase({ seedDir: link, definitionsDir: outside })).status, 'invalid');
  assert.equal(fs.readFileSync(path.join(outside, 'main.cvd'), 'utf8'), 'USER');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});
test('empty and unpinned self-declared resources cannot authorize offline coverage', async () => {
  const dir = path.join(root, 'fake');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SEED-MANIFEST.json'), '{}');
  assert.equal((await seedClamavDatabase({ seedDir: dir, definitionsDir: root })).status, 'invalid');
});
