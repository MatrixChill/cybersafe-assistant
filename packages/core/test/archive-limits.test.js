import { test } from 'node:test';
import assert from 'node:assert/strict';

// Small fake entries: never inflate attacker-sized buffers, even in RED.
async function boundedRead() {
  const m = await import(new URL('../dist/archive-limits.js', import.meta.url).href).catch(() => ({}));
  assert.equal(typeof m.readBoundedArchiveEntry, 'function', 'bounded archive reader must exist');
  return m.readBoundedArchiveEntry;
}
function entry(name = 'benign.txt', size = 5, compressedSize = 5, getData = () => Buffer.from('hello')) {
  return { entryName: name, header: { size, compressedSize }, getData };
}
test('rejects oversized header before decompression', async () => {
  const read = await boundedRead(); let calls = 0;
  assert.throws(() => read(entry('x', 1025, 20, () => { calls++; return Buffer.alloc(0); }), 1024));
  assert.equal(calls, 0);
});
test('rejects traversal, absolute, duplicate Windows aliases before decompression', async () => {
  const read = await boundedRead();
  for (const name of ['../x', '/x', 'C:/x', 'a:stream', 'a/../x', 'a\\..\\x', 'x\u0000y']) {
    let calls = 0;
    assert.throws(() => read(entry(name, 5, 5, () => { calls++; return Buffer.from('hello'); }), 1024));
    assert.equal(calls, 0);
  }
});
test('rejects implausible compression ratios and zero declared size', async () => {
  const read = await boundedRead();
  assert.throws(() => read(entry('x', 2001, 1), 4096));
  assert.throws(() => read(entry('x', 0, 5), 1024));
});
test('accepts bounded content exactly once; verifies actual length', async () => {
  const read = await boundedRead(); let calls = 0;
  assert.equal(read(entry('a/benign.txt', 5, 5, () => { calls++; return Buffer.from('hello'); }), 1024).toString(), 'hello');
  assert.equal(calls, 1);
  assert.throws(() => read(entry('x', 1, 5), 1024));
});
