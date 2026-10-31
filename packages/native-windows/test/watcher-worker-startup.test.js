import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { IsolatedFileWatcher } from '../dist/watcher-process.js';
const delay = ms => new Promise(r=>setTimeout(r,ms));
function next(emitter, event) { return once(emitter,event,{signal:AbortSignal.timeout(12000)}); }
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-watch-lifecycle-'));
  const watcher=new IsolatedFileWatcher();
  t.after(async()=>{await watcher.stop();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,watcher};
}
test('watcher runs in a different process; real file events and stop/restart', {timeout:25000},async t=>{
  const {dir,watcher}=await fixture(t);
  const ready=next(watcher,'ready');
  await watcher.start([dir]);
  assert.ok(watcher.pid>0);assert.notEqual(watcher.pid,process.pid);
  await ready;
  const added=next(watcher,'add');await fs.writeFile(path.join(dir,'sample.txt'),'first');
  assert.equal((await added)[0],path.join(dir,'sample.txt'));
  const changed=next(watcher,'change');await fs.writeFile(path.join(dir,'sample.txt'),'second');await changed;
  const removed=next(watcher,'unlink');await fs.unlink(path.join(dir,'sample.txt'));await removed;
  const pid=watcher.pid;await watcher.stop();await watcher.stop();
  assert.throws(()=>process.kill(pid,0));assert.equal(watcher.pid,undefined);
  const again=next(watcher,'ready');await watcher.start([dir]);await again;assert.notEqual(watcher.pid,pid);
});
test('stop during startup closes owned child and suppresses late events',{timeout:15000},async t=>{
  const {dir,watcher}=await fixture(t);const events=[];watcher.on('add',p=>events.push(p));
  const starting=watcher.start([dir]);const stopping=watcher.stop();
  await Promise.allSettled([starting,stopping]);assert.equal(watcher.pid,undefined);
  await fs.writeFile(path.join(dir,'late.txt'),'late');await delay(100);assert.deepEqual(events,[]);
});
test('unexpected child exit is visible; explicit start recovers',{timeout:15000},async t=>{
  const {dir,watcher}=await fixture(t);let ready=next(watcher,'ready');await watcher.start([dir]);await ready;
  const failed=once(watcher,'error');process.kill(watcher.pid);assert.match(String((await failed)[0]),/exit/i);
  ready=next(watcher,'ready');await watcher.start([dir]);await ready;
});

test('NativeWindowsWatcher stop during path validation cannot start a late child',async t=>{
  const { NativeWindowsWatcher }=await import('../dist/index.js');
  const w=new NativeWindowsWatcher();let release;
  w.validateAndFilterPaths=()=>new Promise(r=>release=r);
  const started=w.start(['C:/pending']);await w.stop();release(['C:/pending']);await started;
  assert.equal(w.watcher,null);assert.equal(w.registryTimer,null);
});

test('parent crash disconnects and terminates the watcher child', {timeout:15000}, async t => {
  const {dir} = await fixture(t);
  const moduleUrl = new URL('../dist/watcher-process.js', import.meta.url).href;
  const source = `import { IsolatedFileWatcher } from ${JSON.stringify(moduleUrl)};
    const watcher = new IsolatedFileWatcher();
    watcher.on('error', () => {});
    await watcher.start([${JSON.stringify(dir)}]);
    process.send({pid: watcher.pid});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let childPid;
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill();
    if (childPid) { try { process.kill(childPid); } catch {} }
  });
  const [message] = await once(parent, 'message', {signal: AbortSignal.timeout(10000)});
  childPid = message.pid;
  assert.ok(childPid > 0);
  const exited = once(parent, 'exit');
  parent.kill();
  await exited;
  const deadline = Date.now() + 5000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(childPid, 0); } catch { alive = false; }
    if (alive) await delay(50);
  }
  assert.equal(alive, false, 'watcher orphan after parent crash');
  childPid = undefined;
});
