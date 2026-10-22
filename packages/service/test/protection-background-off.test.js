import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ProtectionEngineService } from '../dist/engine.js';
import { PIPE_NAME } from '@cybersafe/core';
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-off-gate-'));
  const e=new ProtectionEngineService(dir);
  for(const part of ['watcher','processMonitor','etwConsumer','wfpFilter','amsiProvider']) { e[part].start=async()=>{};e[part].stop=async()=>{}; }
  e.updater.startScheduler=()=>{};e.processMonitor.list=async()=>[];e.hardware.getSnapshot=async()=>({});e.refreshConnections=async()=>{};
  const file=path.join(dir,'sample.txt');await fs.writeFile(file,'benign');
  t.after(async()=>{await e.dispose();await fs.rm(dir,{recursive:true,force:true});});
  return {e,file};
}
test('OFF ignores new filesystem and process analysis; explicit start restores admission',async t=>{
  const {e,file}=await fixture(t);let calls=0;e.scanArtifact=async()=>{calls++;return {results:[]}};
  e.shouldScanStartedProcess=()=>true;e.shouldScanProcessPath=()=>true;
  const proc={pid:123,name:'fixture.exe',path:file,commandLine:''};
  await e.handleFileObservation(file);await e.handleProcessStart(proc);assert.equal(calls,0);
  await e.startProtection();await e.handleFileObservation(file);assert.equal(calls,1);
  await e.stopProtection();await e.handleFileObservation(file);assert.equal(calls,1);
});
test('filesystem event awaiting stat cannot cross OFF then ON generation',async t=>{
  const {e,file}=await fixture(t);let calls=0;e.scanArtifact=async()=>{calls++;return {results:[]}};
  await e.startProtection();
  const pending=e.handleFileObservation(file);
  await e.stopProtection();await e.startProtection();await pending;
  assert.equal(calls,0);
});
test('background signal is aborted on OFF; manual scan controls remain independent',async t=>{
  const {e,file}=await fixture(t);let signal;
  e.scanArtifact=async(_p,_s,options)=>{signal=options?.backgroundSignal;return {results:[]}};
  await e.startProtection();await e.handleFileObservation(file);
  assert.ok(signal);assert.equal(signal.aborted,false);await e.stopProtection();assert.equal(signal.aborted,true);
});
test('connecting to pipe while OFF never activates protection',async t=>{
  const {e,file}=await fixture(t);let starts=0;e.startProtection=async()=>{starts++;return {ok:true,protectionEnabled:true}};
  // PIPE exclusivo por fixture: o PIPE_NAME do produto e' global e pode estar
  // ocupado por uma instancia viva (bind -> EADDRINUSE), o que nada diz sobre
  // a politica testada. Nome derivado do global + pid + uuid, POSIX usa TEMP do fixture.
  const pipe=process.platform==='win32'?`${PIPE_NAME}-test-${process.pid}-${randomUUID()}`:path.join(path.dirname(file),'off.sock');
  await e.startPipeServer(pipe);const s=net.createConnection(pipe);await once(s,'connect');s.destroy();
  await new Promise(r=>setTimeout(r,25));assert.equal(starts,0);
});

test('OFF prevents native analysis after an already admitted background await',async t=>{
  const {e,file}=await fixture(t);let release;let entered;
  const started=new Promise(r=>entered=r);
  e.analyzer.analyze=async()=>{entered();return await new Promise(r=>release=r)};
  await e.startProtection();const signal=e.backgroundAbort.signal;
  const job=e.scanArtifact(file,'service',{backgroundSignal:signal});await started;
  await e.stopProtection();release({});assert.equal(await job,null);
});
