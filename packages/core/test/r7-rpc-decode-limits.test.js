import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StringDecoder } from 'node:string_decoder';
import { decodeMessagesBounded, decodeMessages, encodeMessage } from '../dist/ipc.js';

const limits = { maxFrameBytes: 64, maxRestBytes: 32, maxMessages: 2 };

test('well-formed frames decode and the incomplete tail is preserved', () => {
  const decoded = decodeMessagesBounded(`${encodeMessage({ a: 1 })}${encodeMessage({ b: 2 })}partial`, limits);
  assert.deepEqual(decoded.messages, [{ a: 1 }, { b: 2 }]);
  assert.equal(decoded.rest, 'partial');
  assert.equal(decoded.error, null);
});

test('an unterminated frame cannot grow the rest without bound', () => {
  const decoded = decodeMessagesBounded('x'.repeat(33), limits);
  assert.equal(decoded.error, 'rest-too-large');
  assert.equal(decoded.rest, '');
});

test('padding is counted BEFORE trim: spaces do not bypass the frame cap', () => {
  const padded = `${' '.repeat(60)}${JSON.stringify({ a: 1 })}`;
  assert.ok(padded.trim().length < 64, 'o JSON depois do trim cabe no tecto de caracteres');
  const decoded = decodeMessagesBounded(`${padded}\n`, limits);
  assert.equal(decoded.error, 'frame-too-large');
});

test('the frame cap is UTF-8 BYTES, not UTF-16 code units', () => {
  const multibyte = JSON.stringify({ v: 'ç'.repeat(35) });
  assert.ok(multibyte.length < 64, `caracteres abaixo do tecto: ${multibyte.length}`);
  assert.ok(Buffer.byteLength(multibyte, 'utf8') > 64, 'bytes acima do tecto');
  assert.equal(decodeMessagesBounded(`${multibyte}\n`, limits).error, 'frame-too-large');
  assert.equal(decodeMessagesBounded(`${JSON.stringify({ v: 'ç'.repeat(10) })}\n`, limits).error, null);
});

test('the aggregate buffer is bounded before any split', () => {
  assert.equal(decodeMessagesBounded('x'.repeat(200), { ...limits, maxBufferBytes: 64 }).error, 'rest-too-large');
});

test('a flood of empty lines is bounded by the scan budget', () => {
  assert.equal(decodeMessagesBounded(`${'\n'.repeat(40)}`, limits).error, 'too-many-messages');
});

test('too many frames in one chunk are refused, not partially executed', () => {
  const chunk = Array.from({ length: 3 }, (_, i) => encodeMessage({ i })).join('');
  const decoded = decodeMessagesBounded(chunk, limits);
  assert.equal(decoded.error, 'too-many-messages');
  assert.equal(decoded.messages.length, 2);
});

test('invalid JSON is contained as a decode error instead of throwing', () => {
  const decoded = decodeMessagesBounded(`${encodeMessage({ ok: 1 })}{not json}\n`, limits);
  assert.equal(decoded.error, 'invalid-json');
  assert.deepEqual(decoded.messages, [{ ok: 1 }]);
});

test('UTF-8 split across chunks is reassembled by the real framing', () => {
  const payload = Buffer.from(`${encodeMessage({ name: 'Proteção 🛡' })}`, 'utf8');
  const cut = payload.indexOf(Buffer.from('ç', 'utf8')) + 1; // dentro do caractere
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const messages = [];
  for (const part of [payload.subarray(0, cut), payload.subarray(cut)]) {
    buffer += decoder.write(part);
    const decoded = decodeMessagesBounded(buffer);
    buffer = decoded.rest;
    assert.equal(decoded.error, null);
    messages.push(...decoded.messages);
  }
  assert.deepEqual(messages, [{ name: 'Proteção 🛡' }]);
  assert.equal(buffer, '');
});

test('the legacy decoder keeps its original throwing contract', () => {
  assert.deepEqual(decodeMessages(encodeMessage({ a: 1 })).messages, [{ a: 1 }]);
  assert.throws(() => decodeMessages('{broken}\n'), SyntaxError);
});
