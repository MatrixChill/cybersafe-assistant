import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as n from '../dist/hardware-normalize.js';

const MEM = {
  totalPhysBytes: 32 * 2 ** 30, availPhysBytes: 6 * 2 ** 30,
  commitLimitBytes: 48 * 2 ** 30, commitAvailBytes: 9 * 2 ** 30,
  memoryLoadPercent: 81, totalVirtualBytes: 1 << 40,
  acquiredAt: '2026-10-26T12:00:00.000Z',
};
const POWER = {
  acLine: 'on', hasBattery: false, isCharging: null, batteryPercent: null,
  remainingMinutes: null, batteryLow: false, systemStatus: 0,
  acquiredAt: '2026-10-26T12:00:00.000Z',
};

test('per-core: aceita apenas leitura válida por índice e não inventa núcleos a 0', () => {
  const lidos = n.perCoreReading([{ load: 12.5 }, { load: 0 }, { load: 88 }]);
  assert.equal(lidos.length, 3);
  assert.deepEqual(lidos.map((c) => c.index), [0, 1, 2]);
  assert.equal(lidos[1].percent, 0, '0 é uma leitura real de núcleo ocioso');
  assert.equal(lidos[1].status, 'available');
});

test('per-core: estrutura ausente, vazia ou toda inválida fica null (nunca tabela de zeros)', () => {
  assert.equal(n.perCoreReading(undefined), null);
  assert.equal(n.perCoreReading([]), null);
  assert.equal(n.perCoreReading([{ load: 'muita' }, {}]), null);
  // Uma tabela em que só um núcleo tem leitura mantém os outros como unavailable.
  const parcial = n.perCoreReading([{ load: 42 }, { load: null }]);
  assert.equal(parcial[0].status, 'available');
  assert.equal(parcial[1].percent, null);
  assert.equal(parcial[1].status, 'unavailable');
});

test('frequência: 4700 MHz é preservado e GHz é convertido, sem o percent clamp', () => {
  const r = n.frequencyReading({ osSpeedMHz: 4700, referenceMHz: 4.7 });
  assert.equal(r.currentMHz, 4700);
  assert.equal(r.referenceMHz, 4700);
  assert.equal(r.status, 'available');
});

test('frequência: quando o OS só sabe o nominal, measuredAsCurrent é falso e isso fica dito', () => {
  // Medido nesta máquina a 26/10: os.cpus().speed = 4700 e Win32 MaxClockSpeed
  // = 4,7 GHz para um 7900X que faz boost aos ~5,6 GHz. Publicar isto como
  // "frequência atual" sem bandeira seria afirmar uma medição que não existe.
  const r = n.frequencyReading({ osSpeedMHz: 4700, referenceMHz: 4700 });
  assert.equal(r.measuredAsCurrent, false);
  // Se os dois diferem, há realmente uma contagem distinta do OS.
  assert.equal(n.frequencyReading({ osSpeedMHz: 5123, referenceMHz: 4700 }).measuredAsCurrent, true);
});

test('frequência: valores implausíveis ou ausentes ficam indisponíveis', () => {
  assert.equal(n.frequencyReading({ osSpeedMHz: null, referenceMHz: null }).status, 'unavailable');
  assert.equal(n.frequencyReading({ osSpeedMHz: 0, referenceMHz: -5 }).status, 'unavailable');
  // 90 GHz não é um relógio de CPU: é um erro de fonte, e um erro de fonte não
  // se publica como frequência. (3 → 3 GHz é plausível e continua a ser lido.)
  assert.equal(n.frequencyReading({ osSpeedMHz: null, referenceMHz: 90000 }).status, 'unavailable');
  assert.equal(n.frequencyReading({ osSpeedMHz: 3, referenceMHz: null }).currentMHz, 3000);
});

test('commit: usa os bytes do kernel e nunca apresenta indisponível como 0', () => {
  const r = n.commitReading(MEM);
  assert.equal(r.usedBytes, MEM.commitLimitBytes - MEM.commitAvailBytes);
  assert.equal(r.limitBytes, MEM.commitLimitBytes);
  assert.equal(r.availableBytes, MEM.commitAvailBytes);
  assert.equal(r.status, 'available');
  const falha = n.commitReading(null, 'ffi-indisponivel');
  assert.equal(falha.usedBytes, null);
  assert.equal(falha.limitBytes, null);
  assert.equal(falha.status, 'unavailable');
  assert.equal(falha.reason, 'ffi-indisponivel');
});

test('pagefile: o total derivado vai marcado como derivado', () => {
  const r = n.pagefileReading({ memory: MEM, swapUsedBytes: 120 * 2 ** 20, updatedAt: MEM.acquiredAt });
  assert.equal(r.totalBytes, 16 * 2 ** 30, 'limite − RAM física');
  assert.equal(r.totalIsDerived, true, 'o kernel não mede o pagefile.sys: deriva');
  assert.equal(r.usedBytes, 120 * 2 ** 20);
  assert.equal(r.status, 'available');
  const semMem = n.pagefileReading({ memory: null, swapUsedBytes: null });
  assert.equal(semMem.totalBytes, null);
  assert.equal(semMem.usedBytes, null, 'sem leitura não é 0 % de página');
  assert.equal(semMem.totalIsDerived, false);
  assert.equal(semMem.status, 'unavailable');
});

test('energia: secretária sem bateria é not-applicable, não unavailable nem 0 %', () => {
  const r = n.powerReading(POWER);
  assert.equal(r.hasBattery, false);
  assert.equal(r.status, 'not-applicable');
  assert.equal(r.acLine, 'on');
  assert.equal(r.batteryPercent, null);
});

test('energia: portátil com bateria fica available e preserva carga/autonomia', () => {
  const r = n.powerReading({ ...POWER, hasBattery: true, acLine: 'off', batteryPercent: 58, remainingMinutes: 143, isCharging: false });
  assert.equal(r.status, 'available');
  assert.equal(r.batteryPercent, 58);
  assert.equal(r.remainingMinutes, 143);
});

test('energia: sem leitura do kernel é unavailable com motivo legível', () => {
  const r = n.powerReading(null, 'plataforma-nao-suportada');
  assert.equal(r.status, 'unavailable');
  assert.equal(r.reason, 'plataforma-nao-suportada');
  assert.equal(r.acLine, 'unknown');
  assert.equal(r.hasBattery, null, 'sem leitura não se pode afirmar que não há bateria');
});

test('módulos de RAM: conta apenas slots com capacidade e não declara slots totais', () => {
  const r = n.ramLayoutReading([
    { size: 16 * 2 ** 30, bank: 'P0 CHANNEL A', type: 'DDR5', clockSpeed: 6000, manufacturer: 'Kingston', partNum: 'UD5-6400' },
    { size: 16 * 2 ** 30, bank: 'P1 CHANNEL B', type: 'DDR5', clockSpeed: 6000 },
    { size: 0, bank: 'P2 CHANNEL A', type: 'Empty' },
  ]);
  assert.equal(r.slotsOccupied, 2);
  assert.equal(r.modules.length, 3, 'as entradas vazias continuam visíveis como módulos sem capacidade');
  assert.equal(r.status, 'available');
  assert.equal(r.slotsTotal, null, 'o total de slots não é reportado pela fonte: não se inventa');
  assert.equal(r.modules[0].capacityBytes, 16 * 2 ** 30);
  assert.equal(r.modules[0].speedMHz, 6000);
});

test('módulos de RAM: fonte ausente é unsupported, nunca "0 módulos = saudável"', () => {
  for (const entrada of [undefined, null, 'lixo']) {
    assert.equal(n.ramLayoutReading(entrada).status, 'unsupported');
  }
  assert.equal(n.ramLayoutReading([{ size: 0 }]).status, 'unsupported');
});
