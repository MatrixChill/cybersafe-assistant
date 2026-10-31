import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';

async function guard() {
  const m = await import('../dist/upload-limits.js').catch(() => ({}));
  assert.equal(typeof m.createBoundedUpload, 'function');
  return m.createBoundedUpload;
}
async function serverFor(fn) {
  const app = express(); app.post('/', fn, (req, res) => res.json({ size: req.file?.size ?? 0 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}
test('small benign upload preserved', async () => {
  const make = await guard(); const s = await serverFor(make());
  try {
    const form = new FormData(); form.append('file', new Blob(['hello']), 'hello.txt');
    const r = await fetch(s.url, { method: 'POST', body: form });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { size: 5 });
  } finally { await s.close(); }
});
test('invalid and oversized Content-Length refused before reading a stream', async () => {
  const make = await guard();
  for (const length of ['-1', 'invalid', String(25 * 1024 * 1024 + 64 * 1024 + 1)]) {
    let status, body;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; } };
    make()({ headers: { 'content-length': length } }, res, () => assert.fail('must not parse'));
    assert.equal(status, 413);
    assert.match(body.message, /limite/);
  }
});
test('one upload in flight; finish, close and parser error release the slot', async () => {
  const make = await guard();
  for (const event of ['finish', 'close']) {
    const middleware = make();
    const response = () => Object.assign(new EventEmitter(), {
      statusCode: 200, headersSent: false, destroyed: false,
      status(code) { this.statusCode = code; return this; }, json() {},
    });
    const first = response(); let accepted = 0;
    // Non-multipart requests pass through the real parser synchronously.
    middleware({ headers: {} }, first, () => { accepted++; });
    const busy = response(); middleware({ headers: {} }, busy, () => assert.fail('concurrent request'));
    assert.equal(busy.statusCode, 429);
    first.emit(event);
    const next = response(); middleware({ headers: {} }, next, () => { accepted++; });
    assert.equal(accepted, 2); next.emit('finish');
  }
  const middleware = make(); const s = await serverFor(middleware);
  try {
    const invalid = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'multipart/form-data' }, body: 'malformed' });
    assert.equal(invalid.status, 413);
    const form = new FormData(); form.append('file', new Blob(['ok']), 'ok.txt');
    const recovered = await fetch(s.url, { method: 'POST', body: form });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { size: 2 });
  } finally { await s.close(); }
});
test('non-file fields and multiple files are refused without uncaught parser errors', async () => {
  const make = await guard(); const s = await serverFor(make());
  try {
    for (const multiple of [false, true]) {
      const form = new FormData(); form.append('file', new Blob(['x']), 'x.txt');
      if (multiple) form.append('file', new Blob(['y']), 'y.txt'); else form.append('deep[a][b]', 'x');
      const r = await fetch(s.url, { method: 'POST', body: form });
      assert.equal(r.status, 413);
    }
  } finally { await s.close(); }
});
