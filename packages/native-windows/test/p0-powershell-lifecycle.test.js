import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as logic from '../dist/windows-health-logic.js';

function harness() {
  const children = [], timers = new Set();
  const source = fs.readFileSync(new URL('../src/powershell.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: key => {
    if (key === './windows-health-logic.js') return logic;
    if (key !== 'node:child_process') throw Error(key);
    return { spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kills = 0; child.kill = () => { child.kills++; return true; };
      children.push(child); return child;
    } };
  }, process: { platform: 'win32' }, Buffer, Date, setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) });
  return { ...exports, children, timers, close(child) { child.stdout.emit('data', Buffer.from('[]')); child.emit('close', 0); } };
}

test('Windows snapshot burst is bounded to two children and same query shares work', async () => {
  const h = harness(), e = new h.PowerShellExecutor();
  const names = ['systemInfo','topProcessesByCpu','topProcessesByRam','services','tcpConnections','localUsers','disks','firewallProfiles'];
  const reads = names.map(n => e.run(n));
  const duplicate = e.run('systemInfo');
  try { assert.equal(h.children.length, 2); }
  finally {
    for (let i = 0; i < h.children.length; i++) h.close(h.children[i]);
    e.killAll();
  }
  assert.equal(h.children.length, 8);
  assert.equal((await duplicate).ok, true);
  assert.ok((await Promise.all(reads)).every(r => r.ok));
});

test('timeout settles caller but retains ownership and slot until actual close; no respawn of timed out query', async () => {
  const h = harness(), e = new h.PowerShellExecutor();
  const first = e.run('systemInfo'), second = e.run('services'), queued = e.run('disks');
  const timer = [...h.timers][0]; timer();
  assert.equal((await first).timedOut, true);
  const repeat = e.run('systemInfo');
  try { assert.equal(h.children.length, 2, 'kill request is not proof of process exit'); }
  finally { for (let i = 0; i < h.children.length; i++) h.close(h.children[i]); e.killAll(); }
  assert.equal((await repeat).timedOut, true);
  assert.equal((await second).ok, true);
  assert.equal((await queued).ok, true);
  assert.equal(h.children.length, 3);
});

test('queued reads expire without spawning when both owned children fail to close', { timeout: 1000 }, async () => {
  const h = harness(), e = new h.PowerShellExecutor();
  const reads = ['systemInfo','services','disks'].map(n => e.run(n));
  for (const timer of [...h.timers]) timer();
  assert.ok((await Promise.all(reads)).every(r => r.timedOut));
  assert.equal(h.children.length, 2);
  e.killAll();
});

test('error followed by close does not release ownership of a newer same-query attempt', async () => {
  const h = harness(), e = new h.PowerShellExecutor();
  const first = e.run('systemInfo');
  h.children[0].emit('error', Error('spawn failed'));
  assert.equal((await first).ok, false);
  const second = e.run('systemInfo');
  h.children[0].emit('close', -1);
  const third = e.run('systemInfo');
  try { assert.equal(h.children.length, 2); }
  finally { for (let i = 1; i < h.children.length; i++) h.close(h.children[i]); e.killAll(); }
  assert.equal((await second).ok, true);
  assert.equal((await third).ok, true);
});

test('dispose resolves queued/running callers, kills only owned children, and forbids new work', { timeout: 1000 }, async () => {
  const h = harness(), e = new h.PowerShellExecutor();
  const reads = ['systemInfo','services','disks','localUsers'].map(n => e.run(n));
  e.killAll();
  const late = e.run('firewallProfiles');
  // Close events deliberately absent: disposal must settle its callers itself.
  assert.ok((await Promise.all([...reads, late])).every(r => !r.ok));
  assert.equal(h.children.length, 2);
  assert.ok(h.children.every(c => c.kills === 1));
  assert.equal(h.timers.size, 0);
});
