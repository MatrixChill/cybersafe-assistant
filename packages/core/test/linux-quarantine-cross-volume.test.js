import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { QuarantineManager } from '../dist/response.js';

const linux = { skip: process.platform !== 'linux' };
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-volume-data-'));
  const other = await fs.mkdtemp('/dev/shm/cs-volume-source-');
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  });
  assert.notEqual((await fs.stat(base)).dev, (await fs.stat(other)).dev, 'requires two real filesystems');
  const source = path.join(other, 'benign.txt');
  const bytes = Buffer.from('Disposable benign cross-volume fixture\n');
  await fs.writeFile(source, bytes, { mode: 0o640 });
  const q = new QuarantineManager(base); await q.init();
  const analysis = { artifactPath: source, fileName: 'benign.txt', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), verdict: 'malicious', riskScore: 100, rulesTriggered: ['synthetic-test-only'] };
  return { q, source, bytes, base, analysis };
}

test('Linux: real EXDEV isolation and restore preserve bytes and mode', linux, async t => {
  const { q, source, bytes, analysis } = await fixture(t);
  const entry = await q.quarantine(analysis);
  assert.equal(entry?.isolationStatus, 'confirmed', 'cross-volume isolation must be confirmed');
  await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
  assert.equal((await fs.stat(entry.quarantinePath)).mode & 0o777, 0);
  const result = await q.restore(entry.id);
  assert.equal(result.success, true, result.error);
  assert.equal(result.error, undefined);
  assert.deepEqual(await fs.readFile(source), bytes);
  assert.equal((await fs.stat(source)).mode & 0o777, 0o640);
  assert.equal(q.list().length, 0);
});

test('Linux: quarantine directory is private and refuses symlink roots', linux, async t => {
  const { base } = await fixture(t);
  assert.equal((await fs.stat(path.join(base, 'quarantine'))).mode & 0o777, 0o700);
  const redirected = path.join(base, 'redirected'); await fs.mkdir(redirected);
  await fs.symlink(redirected, path.join(base, 'alias'));
  const q = new QuarantineManager(path.join(base, 'alias'));
  await assert.rejects(q.init());
});

for (const code of ['ENOSPC', 'EACCES', 'ENODEV']) {
  test(`Linux: copy failure ${code} retains original and never confirms`, linux, async t => {
    const { q, source, bytes, analysis } = await fixture(t);
    const copy = fs.copyFile;
    fs.copyFile = async (...args) => { if (args[0] === source) throw Object.assign(new Error('fixture fault'), { code }); return copy(...args); };
    try { assert.equal(await q.quarantine(analysis), null); } finally { fs.copyFile = copy; }
    assert.deepEqual(await fs.readFile(source), bytes);
    assert.equal(q.list().some(e => e.isolationStatus === 'confirmed'), false);
  });
}

test('Linux: concurrent source replacement during cross-volume copy is not deleted', linux, async t => {
  const { q, source, analysis } = await fixture(t);
  const copy = fs.copyFile;
  fs.copyFile = async (...args) => {
    const result = await copy(...args);
    if (args[0] === source) { await fs.unlink(source); await fs.writeFile(source, 'replacement must survive'); }
    return result;
  };
  try { assert.equal(await q.quarantine(analysis), null); } finally { fs.copyFile = copy; }
  assert.equal(await fs.readFile(source, 'utf8'), 'replacement must survive');
  assert.equal(q.list().some(e => e.isolationStatus === 'confirmed'), false);
});

test('Linux: restore to a filesystem without hard links uses exclusive verified copying',linux,async t=>{
 const {q,source,bytes,analysis}=await fixture(t);const entry=await q.quarantine(analysis);assert.ok(entry);
 const link=fs.link;fs.link=async(a,b)=>{if(b===source)throw Object.assign(new Error('no hard links'),{code:'EOPNOTSUPP'});return link(a,b);};
 let r;try{r=await q.restore(entry.id);}finally{fs.link=link;}
 assert.equal(r.success,true,r.error);assert.equal(r.error,undefined);assert.deepEqual(await fs.readFile(source),bytes);
});
