import * as hardwareQuery from '../dist/hardware-query.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as gpu from '../dist/gpu-selection.js';
import * as disk from '../dist/disk.js';
import * as battery from '../dist/battery-health.js';
import * as hardwareNormalize from '../dist/hardware-normalize.js';

function load(name, deps) {
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: key => {
    if (key === './hardware-query.js') return hardwareQuery;
    if (!(key in deps)) throw Error(`Unexpected dependency ${key}`);
    return deps[key];
  }, console, AbortController, Date, setTimeout, clearTimeout, process }, { filename: name });
  return exports;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

/**
 * `win-kernel.js` é a alça nativa do kernel32 (`koffi` + `GlobalMemoryStatusEx`
 * / `GetSystemPowerStatus`). Num sandbox é OBRIGATÓRIO stubá-lo: uma suite que
 * abrisse a alça real mediria a máquina de quem corre os testes e deixaria de
 * ser determinística. O stub falha sempre — por isso os campos que dependem do
 * kernel ficam `unavailable`/`null`, nunca um número inventado.
 *
 * `hardware-normalize.js` é puro: entra real porque é exatamente o contrato
 * de normalização que se quer ver exercido.
 */
function kernelStub() {
  const stats = { memory: 0, power: 0 };
  return {
    stats,
    deps: {
      './win-kernel.js': {
        readMemoryStatus: () => { stats.memory++; return { status: 'error', reason: 'sandbox' }; },
        readPowerStatus: () => { stats.power++; return { status: 'error', reason: 'sandbox' }; },
      },
      './hardware-normalize.js': hardwareNormalize,
      // PDH é a alça nativa dos contadores de disco: no sandbox indisponível,
      // para que a atividade de disco seja um estado honesto e não um número.
      './win-pdh.js': {
        PdhDiskProbe: class {
          poll() { return { status: 'unavailable', reason: 'sandbox' }; }
          close() {}
        },
      },
    },
  };
}

/**
 * ADL é um provider real em produção; aqui é representado como INDISPONÍVEL e
 * contado. Isto não é um detalhe de conveniência: o `readAdlSensors` verdadeiro
 * abre um processo worker com `koffi` + `atiadlxx.dll`. Deixá-lo entrar na suite
 * faria exatamente o que estes testes existem para provar que não acontece —
 * subprocessos de polling térmico multiplicados por consumidor.
 * O stub devolve todos os campos a `null` (nunca 0 °C) e não contribui campos,
 * por isso as garantias antigas de contagem de SI/ACPI mantêm-se intactas.
 */
function unavailableAdl() {
  const stats = { reads: 0, bridgeCalls: 0 };
  const AdlSensorProvider = class {
    name = 'AMD ADL';
    constructor(reader) { this.reader = reader; }
    async isAvailable() { return false; }
    async read() {
      stats.reads++;
      return {
        cpuPackageC: null, cpuCoreMaxC: null, cpuSensor: null,
        gpuCoreC: null, gpuHotspotC: null, gpuMemoryJunctionC: null,
        gpuCoreSensor: null, gpuHotspotSensor: null, gpuMemorySensor: null,
        nvme: [], motherboard: [], fans: [],
        source: 'AMD ADL', timestamp: new Date().toISOString(),
      };
    }
  };
  // O bridge nunca deve ser alcançado a partir do provider stub: se for, alguém
  // contorna o provider e está a abrir um worker em plena suite.
  const readAdlSensors = async () => { stats.bridgeCalls++; throw Error('ADL bridge chamado no sandbox'); };
  return { stats, deps: { './adl-provider.js': { AdlSensorProvider }, './adl-bridge.js': { readAdlSensors } } };
}

function temperature(si, exec) {
  const adl = unavailableAdl();
  const api = load('temperature', { systeminformation: si, child_process: { exec }, util: { promisify: () => exec }, './gpu-selection.js': gpu, ...adl.deps });
  return { api, adl: adl.stats };
}

test('temperature consumers share pending work and availability does not read every sensor twice', async () => {
  const gate = deferred();
  let graphics = 0, cpu = 0, acpi = 0;
  const { api, adl } = temperature({ graphics: async () => { graphics++; await gate.promise; return { controllers: [{ model: 'GPU', temperatureGpu: 53 }] }; }, cpuTemperature: async () => { cpu++; return { main: null }; } }, async () => { acpi++; return { stdout: '40', stderr: '' }; });
  const reads = Array.from({ length: 5 }, () => api.readTemperature());
  await flush();
  gate.resolve();
  const results = await Promise.all(reads);
  assert.equal(graphics, 1);
  assert.equal(cpu, 1);
  assert.equal(acpi, 1);
  assert.equal(adl.reads, 1, 'a leitura ADL partilhada também não é relançada por cada consumidor');
  assert.equal(adl.bridgeCalls, 0, 'nada no sandbox pode abrir o worker ADL');
  assert.ok(results.every(r => r === results[0]));
  assert.equal(results[0].gpuCoreC, 53);
  assert.equal(results[0].cpuPackageC, null, 'ACPI zone is not CPU Package');
  assert.equal(results[0].motherboard[0].tempC, 40);
  assert.equal(await api.readTemperature(), results[0], 'completion cache is reused');
});

test('hardware slow ticks do not relaunch blocked GPU or temperature work and snapshots remain responsive', async () => {
  const gpuGate = deferred(), tempGate = deferred();
  let gpuCalls = 0, tempCalls = 0;
  const { HardwareHealthEngine } = load('hardware', {
    systeminformation: {}, os: { uptime: () => 10, cpus: () => [] }, child_process: {}, util: { promisify: () => () => {} },
    './temperature.js': { readTemperature: () => { tempCalls++; return tempGate.promise; } },
    './battery-health.js': battery, './storage-health.js': { readStorageHealth: async () => ({ disks: [] }) },
    './gpu-selection.js': gpu, './disk.js': disk, ...kernelStub().deps,
  });
  const e = new HardwareHealthEngine();
  e.initialized = true; e.diskReadAttempted = true;
  e.detectGpu = async () => { gpuCalls++; return gpuGate.promise; };
  e.refreshNetwork = e.refreshBattery = e.refreshStorageHealth = async () => {};
  const tick = async () => {
    e.lastFastTick = e.lastMediumTick = Date.now(); e.lastSlowTick = 0;
    return e.getSnapshot([]);
  };
  const snapshots = [];
  for (let i = 0; i < 6; i++) snapshots.push(await tick());
  try {
    assert.equal(gpuCalls, 1);
    assert.equal(tempCalls, 1);
    assert.equal(snapshots.length, 6, 'pending sensors do not gate hardware replies');
  } finally {
    gpuGate.resolve({ available: false });
    tempGate.resolve({ cpuPackageC: null, cpuCoreMaxC: null, gpuCoreC: null, gpuHotspotC: null, gpuMemoryJunctionC: null });
    await flush();
  }
  await tick(); await flush();
  assert.equal(gpuCalls, 2, 'one new attempt on a later tick, not an immediate retry');
  assert.equal(tempCalls, 2);
});

test('GPU inventory and temperature share the same systeminformation graphics query', async () => {
  let graphics = 0;
  const gate = deferred();
  const { api } = temperature({ graphics: async () => { graphics++; await gate.promise; return { controllers: [] }; }, cpuTemperature: async () => ({ main: null }) }, async () => ({ stdout: '', stderr: '' }));
  const { HardwareHealthEngine } = load('hardware', {
    systeminformation: { graphics: async () => { graphics++; await gate.promise; return { controllers: [] }; } }, os: { cpus: () => [] }, child_process: {}, util: { promisify: () => () => {} },
    './temperature.js': api, './battery-health.js': battery, './storage-health.js': {}, './gpu-selection.js': gpu, './disk.js': disk, ...kernelStub().deps,
  });
  const e = new HardwareHealthEngine();
  const reads = [e.detectGpu(), api.readTemperature()];
  await flush(); gate.resolve(); await Promise.all(reads);
  assert.equal(graphics, 1);
});

test('failed temperature providers are cached as unavailable, with no immediate retry loop', async () => {
  let calls = 0;
  const fail = async () => { calls++; throw Error('sensor unavailable'); };
  const { api, adl } = temperature({ graphics: fail, cpuTemperature: fail }, fail);
  const results = await Promise.all(Array.from({ length: 8 }, () => api.readTemperature()));
  assert.equal(calls, 3);
  assert.equal(adl.reads, 1, 'a fonte ADL também é tentada uma única vez');
  assert.equal(adl.bridgeCalls, 0);
  assert.ok(results.every(r => r.source === 'unavailable' && r.cpuPackageC === null));
  await api.readTemperature();
  assert.equal(calls, 3);
  assert.equal(adl.reads, 1, 'indisponibilidade em cache não reabre o worker ADL');
});
