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
  assert.deepEqual(decoded.messages, []);
});

test('a single oversized frame is refused by name', () => {
  const decoded = decodeMessagesBounded(`${JSON.stringify({ a: 'y'.repeat(80) })}\n`, limits);
  assert.equal(decoded.error, 'frame-too-large');
  assert.deepEqual(decoded.messages, []);
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
  const payload = Buffer.from(`${encodeMessage({ name: 'Proteção' })}`, 'utf8');
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
  assert.deepEqual(messages, [{ name: 'Proteção' }]);
  assert.equal(buffer, '');
});

test('the legacy decoder keeps its original throwing contract', () => {
  assert.deepEqual(decodeMessages(encodeMessage({ a: 1 })).messages, [{ a: 1 }]);
  assert.throws(() => decodeMessages('{broken}\n'), SyntaxError);
});
