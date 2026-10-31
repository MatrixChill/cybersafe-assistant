import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as logic from '../dist/windows-health-logic.js';

function harness() {
  const children = [], timers = new Set(); let clock = 0;
  const source = fs.readFileSync(new URL('../src/powershell.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: key => {
    if (key === './windows-health-logic.js') return logic;
    if (key !== 'node:child_process') throw Error(key);
    return { spawn: (...args) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.script = args[1].at(-1); child.kills = 0; child.kill = () => { child.kills++; return true; };
      children.push(child); return child;
    } };
  }, process: { platform: 'win32' }, performance:{now:()=>clock}, Buffer, Date, setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) });
  return { ...exports, children, timers, advance(ms){clock+=ms;}, close(child) { child.stdout.emit('data', Buffer.from('[]')); child.emit('close', 0); } };
}

test('multiple executor instances share the two physical child slots',async()=>{const h=harness(),es=[new h.PowerShellExecutor(),new h.PowerShellExecutor(),new h.PowerShellExecutor()];const reads=es.flatMap(e=>[e.run('systemInfo'),e.run('services')]);try{assert.equal(h.children.length,2,'per-instance bound is not global');}finally{for(let i=0;i<h.children.length;i++)h.close(h.children[i]);es.forEach(e=>e.killAll());}assert.ok((await Promise.all(reads)).every(r=>r.ok));});

test('timeout in one owner cannot free a global slot before close',async()=>{const h=harness(),a=new h.PowerShellExecutor(),b=new h.PowerShellExecutor();const reads=[a.run('systemInfo'),a.run('services'),b.run('disks')];for(const timer of [...h.timers])timer();try{assert.equal(h.children.length,2);assert.equal(h.powerShellAdmissionSnapshot().active,2);assert.ok((await Promise.all(reads)).every(x=>x.timedOut));}finally{a.killAll();b.killAll();for(const child of h.children)h.close(child);}assert.equal(h.powerShellAdmissionSnapshot().active,0);});
test('global queue is bounded and disposal removes only that owners waiting work',async()=>{const h=harness(),es=Array.from({length:20},()=>new h.PowerShellExecutor());const names=['systemInfo','services','disks','tcpConnections','localUsers','topProcessesByCpu','topProcessesByRam','firewallProfiles'];const reads=es.flatMap(e=>names.map(n=>e.run(n)));assert.equal(h.children.length,2);assert.ok(h.powerShellAdmissionSnapshot().queued<=64);assert.ok(h.powerShellAdmissionSnapshot().rejected>0);es.forEach(e=>e.killAll());for(const child of h.children)h.close(child);assert.ok((await Promise.all(reads)).every(x=>!x.ok));assert.equal(h.powerShellAdmissionSnapshot().queued,0);assert.equal(h.powerShellAdmissionSnapshot().active,0);});

test('interactive queries get priority but aged background queries cannot starve',async()=>{const h=harness(),a=new h.PowerShellExecutor(),b=new h.PowerShellExecutor(),c=new h.PowerShellExecutor();const reads=[a.run('systemInfo'),a.run('services'),a.run('disks'),b.run('tcpConnections')];h.close(h.children[0]);assert.match(h.children[2].script,/Get-NetTCPConnection/);h.advance(1500);reads.push(c.run('tcpConnections'));h.close(h.children[1]);assert.match(h.children[3].script,/Win32_LogicalDisk/);for(let i=2;i<h.children.length;i++)h.close(h.children[i]);[a,b,c].forEach(e=>e.killAll());await Promise.all(reads);});
test('no child is launched after queued budget expires even if timer callback is delayed',async()=>{const h=harness(),a=new h.PowerShellExecutor(),b=new h.PowerShellExecutor();const reads=[a.run('systemInfo'),a.run('services')],waiting=b.run('tcpConnections');h.advance(16000);h.close(h.children[0]);const spawned=h.children.length;for(let i=1;i<h.children.length;i++)h.close(h.children[i]);a.killAll();b.killAll();await Promise.all(reads);const result=await waiting;assert.equal(spawned,2,'expired admission must never spawn');assert.equal(result.timedOut,true);});
