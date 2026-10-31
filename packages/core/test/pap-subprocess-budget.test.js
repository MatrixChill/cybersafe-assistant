// PAP-PC-CENTER-SUBPROCESS-BUDGET
//
// O que este teste mede e porque existe: a missão exige que o consumo de
// recursos seja «aceitável e medido». Medido quer dizer contador, não
// adjetivo. Cada chamada abaixo é um processo filho real do Windows quando o
// provider é o systeminformation/PowerShell — os números por chamada foram
// medidos nesta máquina a 26/10 (ver `evidence` no handoff):
//   si.currentLoad  → 0 subprocessos, 0,4 ms   (por isso corre a cada 1 s)
//   si.graphics     → 7 PowerShell, 462 ms
//   si.battery      → 3 PowerShell, 297 ms
//   si.fsSize       → 1 PowerShell, 236 ms
//   si.networkStats → 0,67 PowerShell, 568 ms
//   leitura SMART   → 1 PowerShell
// Um minuto de PC Center é 60 ticks rápidos, 12 médios e 6 lentos. O teste
// percorre esse minuto com o relógio dos ticks avançado à mão (sem esperar em
// tempo real) e conta as aquisições. Assim, reintroduzir uma recolha pesada no
// tick rápido, ou perder um dos throttles, falha aqui em vez de faltar no
// computador do utilizador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as hardwareQuery from '../dist/hardware-query.js';
import * as gpu from '../dist/gpu-selection.js';
import * as disk from '../dist/disk.js';
import * as batteryHealth from '../dist/battery-health.js';
import * as hardwareNormalize from '../dist/hardware-normalize.js';

function load(name, deps) {
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: key => {
    if (!(key in deps)) throw Error(`Unexpected dependency ${key}`);
    return deps[key];
  }, console, AbortController, Date, setTimeout, clearTimeout, process }, { filename: name });
  return exports;
}

const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/**
 * Sandbox com contadores. `win-kernel` e `win-pdh` são deliberadamente inertes:
 * medir a máquina de quem corre os testes não é o contrato deste teste, e um
 * stub que falha mantém os campos dependentes indisponíveis em vez de inventar.
 * `hasBattery` é parametrizável porque é essa afirmação do kernel que autoriza
 * deixar de perguntar ao WMI.
 */
function sandbox(options = {}) {
  const hasBattery = options.hasBattery ?? false;
  const counts = {
    currentLoad: 0, graphics: 0, battery: 0, fsSize: 0, networkStats: 0,
    memLayout: 0, temperature: 0, storageHealth: 0,
  };
  const si = {
    currentLoad: async () => { counts.currentLoad++; return { currentLoad: 12, cpus: [{ load: 10 }, { load: 14 }] }; },
    graphics: async () => { counts.graphics++; return { controllers: [] }; },
    battery: async () => { counts.battery++; return { hasBattery, percent: hasBattery ? 55 : 0, isCharging: false, timeRemaining: null }; },
    fsSize: async () => { counts.fsSize++; return []; },
    networkStats: async () => { counts.networkStats++; return []; },
    memLayout: async () => { counts.memLayout++; return []; },
    mem: async () => ({ total: 0, used: 0, active: 0, available: 0 }),
    cpu: async () => ({}),
    osInfo: async () => ({}),
    batteryStatus: async () => ({ hasBattery, percent: hasBattery ? 55 : 0, isCharging: false, timeRemaining: null }),
  };
  const temperatureModule = {
    readTemperature: async () => {
      counts.temperature++;
      return {
        cpuPackageC: null, cpuCoreMaxC: null, cpuSensor: null,
        gpuCoreC: null, gpuHotspotC: null, gpuMemoryJunctionC: null,
        gpuCoreSensor: null, gpuHotspotSensor: null, gpuMemorySensor: null,
        nvme: [], motherboard: [], fans: [], source: 'unavailable',
        timestamp: new Date().toISOString(),
      };
    },
    readGraphics: () => si.graphics(),
  };
  const storageModule = {
    readStorageHealth: async () => {
      counts.storageHealth++;
      return { disks: [], detail: 'sandbox' };
    },
  };
  const kernel = {
    readMemoryStatus: () => ({ status: 'error', reason: 'sandbox' }),
    readPowerStatus: () => ({
      status: 'ok',
      value: {
        acLine: 'on', hasBattery, batteryPercent: hasBattery ? 55 : null,
        remainingMinutes: null, isCharging: hasBattery ? false : null,
        systemStatus: 0, batteryLow: false, acquiredAt: new Date().toISOString(),
      },
    }),
  };
  const deps = {
    './hardware-query.js': hardwareQuery,
    systeminformation: si,
    os: { uptime: () => 10, cpus: () => [{ speed: 3000 }] },
    child_process: { exec: () => {} },
    util: { promisify: () => () => ({ stdout: '' }) },
    './temperature.js': temperatureModule,
    './battery-health.js': batteryHealth,
    './storage-health.js': storageModule,
    './gpu-selection.js': gpu,
    './disk.js': disk,
    './hardware-normalize.js': hardwareNormalize,
    './win-kernel.js': kernel,
    './win-pdh.js': {
      PdhDiskProbe: class { poll() { return { status: 'unavailable', reason: 'sandbox' }; } close() {} },
    },
  };
  return { engine: load('hardware', deps).HardwareHealthEngine, counts, si };
}

/** Avança o relógio dos ticks sem esperar em tempo real. */
function advance(engine, ms) {
  engine.lastFastTick -= ms;
  engine.lastMediumTick -= ms;
  engine.lastSlowTick -= ms;
  if (typeof engine.batteryState?.updatedAt === 'number') engine.batteryState.updatedAt -= ms;
}

async function runMinutes(engine, seconds) {
  for (let i = 0; i < seconds; i++) {
    advance(engine, 1_000);
    await engine.getSnapshot([]);
    await flush();
  }
}

test('um minuto de PC Center não volta a pedir ao Windows o que o kernel já afirmou', async () => {
  const { engine: Engine, counts } = sandbox({ hasBattery: false });
  const engine = new Engine();
  await engine.getSnapshot([]); // init: facts estáticos + primeira leitura
  await flush();
  const afterInit = { ...counts };

  await runMinutes(engine, 60);

  // O tick rápido é barato por contrato medido: 0 subprocessos por chamada.
  assert.ok(counts.currentLoad - afterInit.currentLoad >= 55,
    `o tick rápido deve alimentar o uso de CPU (foram ${counts.currentLoad - afterInit.currentLoad})`);
  // Bateria: o kernel afirma «sem bateria» e uma leitura boa já o confirmou.
  // Perguntar ao WMI em cada tick lento custava 3 PowerShell × 6 = 18/min.
  assert.equal(counts.battery - afterInit.battery, 0,
    'sem bateria comprovada, o minuto não pode voltar a chamar si.battery()');
  // Saúde física: 1 PowerShell por leitura; a 10 s seriam 6/min, a 60 s é 1.
  assert.ok(counts.storageHealth - afterInit.storageHealth <= 1,
    `a leitura SMART não pode correr mais do que uma vez por minuto (veio ${counts.storageHealth - afterInit.storageHealth})`);
  // Ocupação dos volumes continua no tick médio: é o que o utilizador vê a mudar.
  assert.ok(counts.fsSize - afterInit.fsSize >= 10,
    'o espaço dos volumes mantém-se a ser lido no tick médio');
});

test('com bateria presente a medição continua a cada 10 s (o corte é só para a ausência provada)', async () => {
  // Deliberado, e medido honestamente: num portátil a percentagem e o estado de
  // carga são o que o utilizador olha, e continuam no ritmo do tick lento.
  // O caminho barato (percent/isCharging do kernel32 a 1 s, WMI só para
  // capacidades e ciclos) fica por fazer — esta máquina não tem bateria, logo
  // não há como validar aqui essa mudança sem inventar um portátil. Fica no
  // handoff como follow-up, não como trabalho «acabado».
  const { engine: Engine, counts } = sandbox({ hasBattery: true });
  const engine = new Engine();
  await engine.getSnapshot([]);
  await flush();
  const afterInit = { ...counts };

  await runMinutes(engine, 60);

  const perguntas = counts.battery - afterInit.battery;
  assert.ok(perguntas >= 5, `com bateria, o WMI continua a medir (foram ${perguntas} perguntas em 60 s)`);
  assert.equal(engine.staticMetrics.hasBattery, true);
  assert.equal(engine.staticMetrics.batteryPercent, 55);
});

test('a temperatura e a identidade da GPU partilham a mesma aquisição cara', async () => {
  // `si.graphics()` custa 7 PowerShell. Se detectGpu() e a cadeia de temperatura
  // passassem cada uma a chamar o provider, um minuto de PC Center pagava o
  // dobro por exatamente a mesma resposta.
  const { engine: Engine, counts } = sandbox({ hasBattery: false });
  const engine = new Engine();
  await engine.getSnapshot([]);
  await flush();
  const afterInit = { ...counts };

  await runMinutes(engine, 60);

  const graphics = counts.graphics - afterInit.graphics;
  const temperatura = counts.temperature - afterInit.temperature;
  assert.ok(temperatura >= 5, `a cadeia de temperatura corre no tick lento (foram ${temperatura})`);
  assert.ok(graphics <= temperatura + 1,
    `a aquisição de gráficos é partilhada: ${graphics} aquisições para ${temperatura} ciclos de temperatura`);
});
