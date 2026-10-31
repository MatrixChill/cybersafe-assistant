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
 * `./win-kernel.js` é a alça nativa do kernel32; um sandbox não a pode abrir
 * (mediria a máquina de quem corre os testes). O stub falha sempre, portanto os
 * campos dependentes do kernel ficam indisponíveis em vez de inventados.
 * `hardware-normalize.js` é puro e entra real: é o contrato que se exercita.
 */
const kernelSandbox = () => ({
  './win-kernel.js': {
    readMemoryStatus: () => ({ status: 'error', reason: 'sandbox' }),
    readPowerStatus: () => ({ status: 'error', reason: 'sandbox' }),
  },
  './hardware-normalize.js': hardwareNormalize,
  './win-pdh.js': {
    PdhDiskProbe: class {
      poll() { return { status: 'unavailable', reason: 'sandbox' }; }
      close() {}
    },
  },
});
function temperature(si, exec) {
  return load('temperature', { systeminformation: si, child_process: { exec }, util: { promisify: () => exec }, './gpu-selection.js': gpu });
}

test('pending disk and network work is not relaunched by later polling ticks',async()=>{let disks=0,net=0;const dg=deferred(),ng=deferred();const{HardwareHealthEngine}=load('hardware',{systeminformation:{fsSize:()=>{disks++;return dg.promise}},os:{uptime:()=>10,cpus:()=>[]},child_process:{},util:{promisify:()=>()=>{}},'./temperature.js':{},'./battery-health.js':battery,'./storage-health.js':{},'./gpu-selection.js':gpu,'./disk.js':disk,...kernelSandbox()});const e=new HardwareHealthEngine();e.readNetworkStats=()=>{net++;return ng.promise};const a=[e.readDisksOnce(),e.readDisksOnce(),e.refreshNetwork(),e.refreshNetwork()];await flush();try{assert.equal(disks,1);assert.equal(net,1);}finally{dg.resolve([]);ng.resolve(null);await Promise.all(a);} });

test('fresh battery from init is not repeated on the first slow tick or re-stamped',async()=>{const{HardwareHealthEngine}=load('hardware',{systeminformation:{},os:{uptime:()=>10,cpus:()=>[]},child_process:{},util:{promisify:()=>()=>{}},'./temperature.js':{readTemperature:async()=>({cpuPackageC:null,cpuCoreMaxC:null,gpuCoreC:null})},'./battery-health.js':battery,'./storage-health.js':{},'./gpu-selection.js':gpu,'./disk.js':disk,...kernelSandbox()});const e=new HardwareHealthEngine();e.initialized=true;e.diskReadAttempted=true;e.lastFastTick=e.lastMediumTick=Date.now();e.lastSlowTick=0;const stamp=Date.now();e.batteryState={updatedAt:stamp,status:'absent'};let calls=0;e.refreshBattery=async()=>{calls++};e.refreshNetwork=e.refreshStorageHealth=async()=>{};e.detectGpu=async()=>({available:false});await e.getSnapshot([]);assert.equal(calls,0);assert.equal(e.batteryState.updatedAt,stamp);e.batteryState.updatedAt=Date.now()-11000;e.lastSlowTick=0;await e.getSnapshot([]);assert.equal(calls,1);});
