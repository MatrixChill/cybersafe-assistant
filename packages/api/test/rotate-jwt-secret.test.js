import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/rotate-jwt-secret.mjs', import.meta.url));
const oldSecret = 'old-test-secret-that-must-never-appear-in-output';
function fixture(t, content = `JWT_SECRET=${oldSecret}\n`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  if (content !== null) fs.writeFileSync(file, content);
  return { dir, file };
}
function run(file, ...args) {
  return spawnSync(process.execPath, [cli, '--file', file, ...args], { encoding: 'utf8' });
}
function secret(file) {
  return fs.readFileSync(file, 'utf8').match(/^JWT_SECRET=([^\r\n]+)/m)[1].replace(/^['"]|['"]$/g, '');
}
test('rotation preserves bytes, quotes, comments, permissions and produces a private backup', t => {
  const before = `\uFEFF# configuração\r\nPORT=4000\r\nJWT_SECRET="${oldSecret}" # keep this\r\nLAST=á`;
  const { file } = fixture(t, before);
  fs.chmodSync(file, 0o600);
  const mode = fs.statSync(file).mode & 0o777;
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(file, 'utf8');
  const value = after.match(/JWT_SECRET="([^"]+)"/)[1];
  assert.ok(value.length >= 32);
  assert.notEqual(value, oldSecret);
  assert.equal(after.replace(value, oldSecret), before);
  for (const stream of [result.stdout, result.stderr]) {
    assert.ok(!stream.includes(value));
    assert.ok(!stream.includes(oldSecret));
  }
  const backup = result.stdout.match(/^BACKUP=(.+)$/m)[1].trim();
  assert.deepEqual(fs.readFileSync(backup), Buffer.from(before));
  assert.equal(fs.statSync(file).mode & 0o777, mode);
  assert.equal(fs.statSync(backup).mode & 0o777, mode);
  assert.ok(result.stdout.includes(`FINGERPRINT=sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`));
  assert.match(result.stdout, /ACTION=ROTATE_JWT_SECRET/);
});
test('dry-run neither modifies target nor creates backups', t => {
  const { dir, file } = fixture(t);
  const before = fs.readFileSync(file);
  const result = run(file, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(dir), ['.env']);
  assert.match(result.stdout, /DRY-RUN/);
});
test('missing target fails without creating any file', t => {
  const { dir, file } = fixture(t, null);
  const result = run(file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ficheiro alvo.*existe/i);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('missing key is appended, preserving original bytes and newline style', t => {
  const before = '# comment\r\nPORT=4000';
  const { file } = fixture(t, before);
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(file, 'utf8'), /^# comment\r\nPORT=4000\r\nJWT_SECRET=[A-Za-z0-9_-]{64}\r\n$/);
});
test('successive rotations change secret twice without duplicating keys or backups', t => {
  const { dir, file } = fixture(t);
  assert.equal(run(file).status, 0);
  const first = secret(file);
  assert.equal(run(file).status, 0);
  const second = secret(file);
  assert.notEqual(first, oldSecret);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(file, 'utf8').match(/^JWT_SECRET=/gm).length, 1);
  assert.equal(fs.readdirSync(dir).filter(name => name.includes('.backup-')).length, 2);
});
test('duplicate active keys are rejected without writes', t => {
  const before = `JWT_SECRET=${oldSecret}\nexport JWT_SECRET="another-value"\n`;
  const { dir, file } = fixture(t, before);
  const result = run(file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicada/i);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['.env']);
});
