import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as kernel from '../dist/win-kernel.js';

// Costura um `Kernel32Bindings` que escreve o buffer como o Windows o escreveria.
// O objetivo não é imitar a API: é provar que a normalização REJEITA o que é
// impossível em vez de o publicar como se fosse uma medição.
const fakeMemory = (fields) => ({
  GlobalMemoryStatusEx: (buffer) => {
    if (fields === false) return false;
    if (fields instanceof Error) throw fields;
    buffer.writeUInt32LE(64, 0);
    buffer.writeUInt32LE(fields.memoryLoad ?? 0, 4);
    buffer.writeBigUInt64LE(BigInt(fields.totalPhys), 8);
    buffer.writeBigUInt64LE(BigInt(fields.availPhys), 16);
    buffer.writeBigUInt64LE(BigInt(fields.commitLimit), 24);
    buffer.writeBigUInt64LE(BigInt(fields.commitAvail), 32);
    buffer.writeBigUInt64LE(BigInt(fields.totalVirtual ?? 1 << 30), 40);
    if (fields.corruptLength) buffer.writeUInt32LE(0, 0);
    return true;
  },
  GetSystemPowerStatus: () => false,
});
const GOOD = { totalPhys: 32 * 2 ** 30, availPhys: 6 * 2 ** 30, commitLimit: 48 * 2 ** 30, commitAvail: 10 * 2 ** 30, memoryLoad: 81 };
const fakePower = (bytesWritten) => ({
  GlobalMemoryStatusEx: () => false,
  GetSystemPowerStatus: (buffer) => {
    if (bytesWritten === false) return false;
    if (bytesWritten instanceof Error) throw bytesWritten;
    buffer.writeUInt8(bytesWritten.ac, 0);
    buffer.writeUInt8(bytesWritten.flag, 1);
    buffer.writeUInt8(bytesWritten.percent, 2);
    buffer.writeUInt8(bytesWritten.systemStatus ?? 0, 3);
    buffer.writeInt32LE(bytesWritten.lifeTime, 4);
    buffer.writeInt32LE(bytesWritten.fullLifeTime ?? -1, 8);
    return true;
  },
});
const now = () => new Date('2026-10-26T12:00:00.000Z');

test('kernel32: memória coerente passa com todos os campos e timestamp de aquisição', () => {
  const r = kernel.readMemoryStatus({ bindings: fakeMemory(GOOD), now });
  assert.equal(r.status, 'ok');
  assert.equal(r.value.totalPhysBytes, GOOD.totalPhys);
  assert.equal(r.value.commitLimitBytes, GOOD.commitLimit);
  assert.equal(r.value.memoryLoadPercent, 81);
  assert.equal(r.value.acquiredAt, '2026-10-26T12:00:00.000Z');
});

test('kernel32: falha da API ou exceção viram indisponível, nunca zeros', () => {
  assert.equal(kernel.readMemoryStatus({ bindings: fakeMemory(false), now }).status, 'unavailable');
  const lancou = kernel.readMemoryStatus({ bindings: fakeMemory(Error('boom')), now });
  assert.equal(lancou.status, 'unavailable');
  assert.match(lancou.reason, /lançou/);
  // Um reading indisponível não tem campos numéricos para a UI usar como 0.
  assert.ok(!('value' in lancou));
});

test('kernel32: dwLength não confirmado pela API é recusado', () => {
  const r = kernel.readMemoryStatus({ bindings: fakeMemory({ ...GOOD, corruptLength: true }), now });
  assert.equal(r.status, 'unavailable');
  assert.match(r.reason, /dwLength/);
});

test('kernel32: combinações fisicamente impossíveis são recusadas, não corrigidas', () => {
  const casos = {
    'limite de compromisso abaixo da RAM': { ...GOOD, commitLimit: 8 * 2 ** 30 },
    'RAM disponível acima da total': { ...GOOD, availPhys: 40 * 2 ** 30 },
    'compromisso disponível acima do limite': { ...GOOD, commitAvail: 60 * 2 ** 30 },
    'carga de memória acima de 100 %': { ...GOOD, memoryLoad: 118 },
    'RAM total zero': { ...GOOD, totalPhys: 0 },
  };
  for (const [nome, campos] of Object.entries(casos)) {
    const r = kernel.readMemoryStatus({ bindings: fakeMemory(campos), now });
    assert.equal(r.status, 'unavailable', `${nome} não pode ser publicado como leitura`);
  }
});

test('kernel32: secretária sem bateria — 255 % e flag 0x80 não viram 0 % nem "a carregar"', () => {
  // Exatamente o que esta máquina devolveu a 26/10 (evidence/SONDA-KERNEL32).
  const r = kernel.readPowerStatus({ bindings: fakePower({ ac: 1, flag: 0x80, percent: 255, lifeTime: -1 }), now });
  assert.equal(r.status, 'ok');
  assert.equal(r.value.hasBattery, false);
  assert.equal(r.value.batteryPercent, null, '255 = sem informação, não 0 %');
  assert.equal(r.value.remainingMinutes, null);
  assert.equal(r.value.isCharging, null, 'sem bateria não há estado de carga');
  assert.equal(r.value.acLine, 'on');
});

test('kernel32: portátil com bateria traduz percentagem, carga e autonomia', () => {
  const a = kernel.readPowerStatus({ bindings: fakePower({ ac: 0, flag: 0x01 | 0x08, percent: 62, lifeTime: 154 }), now });
  assert.equal(a.value.hasBattery, true);
  assert.equal(a.value.batteryPercent, 62);
  assert.equal(a.value.acLine, 'off');
  assert.equal(a.value.isCharging, true);
  assert.equal(a.value.remainingMinutes, 154);
  assert.equal(a.value.batteryLow, true);
});

test('kernel32: alimentação desconhecida fica desconhecida', () => {
  const r = kernel.readPowerStatus({ bindings: fakePower({ ac: 255, flag: 0x00, percent: 255, lifeTime: -1 }), now });
  assert.equal(r.value.acLine, 'unknown');
  assert.equal(r.value.batteryPercent, null);
});

test('kernel32: falha de energia é indisponível com motivo', () => {
  assert.equal(kernel.readPowerStatus({ bindings: fakePower(false), now }).status, 'unavailable');
  const e = kernel.readPowerStatus({ bindings: fakePower(Error('powrprof indisponível')), now });
  assert.equal(e.status, 'unavailable');
  assert.match(e.reason, /GetSystemPowerStatus/);
});

test('runtime real: kernel32 responde nesta máquina sem subprocessos', (t) => {
  const m = kernel.readMemoryStatus();
  const p = kernel.readPowerStatus();
  if (m.status === 'unavailable') {
    // koffi é dependência opcional; ausência é um estado legítimo, não falha.
    t.skip(`kernel32 indisponível neste ambiente: ${m.reason}`);
    return;
  }
  assert.equal(m.value.totalPhysBytes > 0, true);
  assert.ok(m.value.commitLimitBytes >= m.value.totalPhysBytes, 'limite de compromisso ≥ RAM física');
  assert.equal(p.status, 'ok');
  assert.ok(['on', 'off', 'unknown'].includes(p.value.acLine));
});
