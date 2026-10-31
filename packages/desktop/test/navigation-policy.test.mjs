import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

async function policy() {
  const m = await import('../src/navigation-policy.ts').catch(() => ({}));
  assert.equal(typeof m.installNavigationPolicy, 'function'); return m.installNavigationPolicy;
}
test('denies untrusted navigation and redirects, preserves exact main document/hash', async () => {
  const install = await policy(); const contents = new EventEmitter();
  let popup;
  contents.setWindowOpenHandler = fn => { popup = fn; };
  install(contents, () => 'file:///C:/app/index.html');
  for (const type of ['will-navigate', 'will-redirect']) {
    for (const [url, denied] of [['https://evil.invalid', true], ['file:///C:/app/other.html', true], ['javascript:alert(1)', true], ['file:///C:/app/index.html#scanner', false]]) {
      let prevented = false; contents.emit(type, { preventDefault() { prevented = true; } }, url);
      assert.equal(prevented, denied);
    }
  }
  assert.deepEqual(popup({ url: 'https://evil.invalid' }), { action: 'deny' });
  assert.deepEqual(popup({ url: 'file:///C:/app/index.html' }), { action: 'deny' });
});
test('development navigation permits only the actual Vite document', async () => {
  const install = await policy(); const contents = new EventEmitter(); contents.setWindowOpenHandler = () => {};
  install(contents, () => 'http://localhost:5173/');
  for (const [url, denied] of [['http://localhost:5173/', false], ['http://localhost:5173/evil', true], ['http://localhost:5174/', true], ['http://localhost:5173.evil.invalid/', true]]) {
    let prevented = false; contents.emit('will-navigate', { preventDefault() { prevented = true; } }, url); assert.equal(prevented, denied);
  }
});
