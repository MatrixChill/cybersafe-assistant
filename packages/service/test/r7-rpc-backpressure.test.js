import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProtectionEngineService } from '../dist/engine.js';
import { encodeMessage } from '@cybersafe/core';

const OUTBOUND_CAP = 2 * 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSocket(overrides = {}) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket.writableEnded = false;
  socket.writableLength = 0;
  socket.paused = false;
  socket.writes = [];
  Object.assign(socket, overrides);
  socket.write = (payload, cb) => {
    socket.writes.push(String(payload));
    if (cb) queueMicrotask(() => cb(null));
    return true;
  };
  socket.pause = () => { socket.paused = true; };
  socket.end = () => { socket.writable = false; socket.writableEnded = true; };
  socket.destroy = () => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    socket.emit('close');
  };
  return socket;
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r7-backpressure-'));
  return { engine: new ProtectionEngineService(base), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('R7: safeWrite recusa e fecha quando o buffer de saída passou o tecto', () => {
  const { engine, cleanup } = fixture();
  try {
    const socket = fakeSocket({ writableLength: OUTBOUND_CAP + 1 });
    engine.clients.add(socket);

    assert.equal(engine.safeWrite(socket, encodeMessage({ type: 'event' })), false);
    assert.equal(socket.writes.length, 0, 'nada é escrito por cima do tecto');
    assert.equal(socket.destroyed, true, 'o peer que não lê é fechado');
    assert.equal(engine.clients.has(socket), false, 'sai da contabilidade de clientes');
  } finally {
    cleanup();
  }
});

test('R7: safeWrite escreve normalmente abaixo do tecto (controlo positivo)', () => {
  const { engine, cleanup } = fixture();
  try {
    const socket = fakeSocket();
    engine.clients.add(socket);

    assert.equal(engine.safeWrite(socket, encodeMessage({ type: 'event' })), true);
    assert.equal(socket.writes.length, 1);
    assert.equal(socket.destroyed, false);
  } finally {
    cleanup();
  }
});

test('R7: fila cheia recusa com busy uma vez por pedido, sem desaparecer', async () => {
  const { engine, cleanup } = fixture();
  try {
    const socket = fakeSocket();
    engine.attachClientSocket(socket);
    const total = 120;
    const chunk = Array.from({ length: total }, (_, i) => encodeMessage({
      id: `req-${i + 1}`,
      type: 'request',
      method: 'scan.getActive',
      payload: undefined,
    })).join('');
    socket.emit('data', Buffer.from(chunk));

    await wait(50);
    const frames = socket.writes.map((line) => JSON.parse(line.trim()));
    const busy = frames.filter((frame) => frame.ok === false && /ocupado/i.test(frame.error));
    assert.ok(busy.length > 0, 'a fila limitada produz recusas explícitas');
    for (const frame of busy) assert.match(frame.id, /^req-\d+$/);
    assert.equal(new Set(busy.map((frame) => frame.id)).size, busy.length, 'sem recusa duplicada do mesmo id');
    const answered = new Set(frames.filter((frame) => frame.type === 'response').map((frame) => frame.id));
    assert.ok(answered.size > 0, 'pedidos aceites continuam a ser respondidos');
  } finally {
    cleanup();
  }
});

test('R7: com o socket saturado a recusa busy fecha a ligação em vez de empurrar mais bytes', () => {
  const { engine, cleanup } = fixture();
  try {
    const socket = fakeSocket({ writableLength: OUTBOUND_CAP + 1 });
    engine.attachClientSocket(socket);
    const total = 120;
    socket.emit('data', Buffer.from(Array.from({ length: total }, (_, i) => encodeMessage({
      id: `req-${i + 1}`,
      type: 'request',
      method: 'scan.getActive',
      payload: undefined,
    })).join('')));

    assert.equal(socket.writes.length, 0, 'nenhuma resposta busy é serializada para o socket saturado');
    assert.equal(socket.paused, true);
    assert.equal(engine.clients.has(socket), false);
  } finally {
    cleanup();
  }
});
