import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProtectionEngineService } from '../dist/engine.js';
import { encodeMessage } from '@cybersafe/core';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket.writableEnded = false;
  socket.writableLength = 0;
  socket.paused = false;
  socket.written = [];
  socket.write = (payload, cb) => {
    socket.written.push(String(payload));
    if (cb) queueMicrotask(() => cb(null));
    return true;
  };
  socket.pause = () => { socket.paused = true; };
  socket.end = () => { socket.writable = false; socket.writableEnded = true; };
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  return socket;
}

function harness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r7-handler-'));
  const svc = new ProtectionEngineService(base);
  const socket = fakeSocket();
  svc.attachClientSocket(socket);
  return { svc, socket, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('R7/AUD-002: JSON inválido fecha uma vez e nenhum frame posterior é aceite', async () => {
  const { svc, socket, cleanup } = harness();
  try {
    socket.emit('data', Buffer.from('{broken-json}\n'));
    assert.equal(socket.paused, true, 'leitura nova é travada imediatamente');
    assert.equal(socket.written.length, 1, 'exactamente um frame de erro');
    assert.match(socket.written[0], /Protocolo RPC inválido/);
    assert.equal(svc.clients.has(socket), false, 'socket sai da contabilidade de clientes');

    // Chega um pedido VÁLIDO durante o fecho: não pode ser enfileirado nem respondido.
    socket.emit('data', Buffer.from(encodeMessage({ id: 'req-1', type: 'request', method: 'threats.list' })));
    assert.equal(socket.written.length, 1, 'nenhuma resposta depois do fecho');

    await wait(150);
    assert.equal(socket.destroyed, true, 'destroy determinístico após o prazo');
  } finally {
    cleanup();
  }
});

test('R7/AUD-002: violação repetida não escreve nem fecha duas vezes', async () => {
  const { socket, cleanup } = harness();
  try {
    socket.emit('data', Buffer.from('{broken}\n'));
    socket.emit('data', Buffer.from('{broken-again}\n'));
    assert.equal(socket.written.length, 1, 'o fecho é idempotente por ligação');
    await wait(150);
    assert.equal(socket.destroyed, true);
  } finally {
    cleanup();
  }
});

test('R7/AUD-002: envelope fora do contrato é recusado antes do dispatch', async () => {
  const { socket, cleanup } = harness();
  try {
    socket.emit('data', Buffer.from(encodeMessage({ id: 'x'.repeat(80), type: 'request', method: 'threats.list' })));
    assert.equal(socket.written.length, 1);
    assert.match(socket.written[0], /Protocolo RPC inválido/);
  } finally {
    cleanup();
  }
});

test('R7/AUD-002: um pedido válido antes da violação continua a ser respondido', async () => {
  const { socket, cleanup } = harness();
  try {
    socket.emit('data', Buffer.from(encodeMessage({ id: 'req-1', type: 'request', method: 'threats.list' })));
    await wait(30);
    assert.ok(socket.written.some((line) => line.includes('"ok":true')), 'resposta real ao pedido válido');
    socket.emit('data', Buffer.from('{broken}\n'));
    assert.equal(socket.written.filter((line) => line.includes('Protocolo RPC inválido')).length, 1);
  } finally {
    cleanup();
  }
});
