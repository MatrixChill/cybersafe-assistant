import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ClamavBridge, classifyClamavHealth} from '@cybersafe/core';

// Synthetic outcomes only: no executable, live DB or Windows call.
// Probe state is overridden on the TEST instance, never in production code.
let dir, file;
before(async () => {
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'fecho14-valid-clamav-'));
  file=path.join(dir,'benign.txt');
  await fs.writeFile(file,'Benign isolated scanner fixture.\n');
});
after(async () => {await fs.rm(dir,{recursive:true,force:true});});

function makeBridge({hasSignatures=true, outcome, spawnThrows=false, hangs=false}={}) {
  const state={calls:0,kills:0,probes:0};
  const bridge=new ClamavBridge({scanTimeoutMs:20,spawn:()=>{
    state.calls++;
    if(spawnThrows) throw Object.assign(new Error('fixture ENOENT'),{code:'ENOENT'});
    let resolve;
    const promise=hangs?new Promise(r=>{resolve=r;}):Promise.resolve(outcome);
    return {outcome:promise,killTree(){state.kills++;resolve?.({code:null,stdout:'',stderr:'',killed:true,timedOut:true});}};
  }});
  bridge.isAvailable=async()=>{
    state.probes++;
    bridge._hasSignatures=hasSignatures;
    bridge._dbDir=hasSignatures?dir:null;
    bridge._health=hasSignatures?{status:'active',detail:'Synthetic probe: ready'}:{status:'unavailable',detail:'Synthetic probe: signatures absent'};
    return hasSignatures;
  };
  return {bridge,state};
}

test('operacional: versão e assinaturas reconhecidas produzem health active',()=>{
  const health=classifyClamavHealth({versionOutput:'ClamAV 1.5.4/28000/Wed Oct 14 00:00:00 2026',dbDir:'/synthetic',dbFiles:['main.cvd','daily.cvd']});
  assert.equal(health.available,true);
  assert.equal(health.health.status,'active');
});
test('motor indisponível: spawn ENOENT no seam devolve error, não clean',async()=>{
  const {bridge,state}=makeBridge({spawnThrows:true});
  const result=await bridge.scanFile(file);
  assert.equal(state.calls,1,'o seam foi realmente atingido');
  assert.equal(result.verdict,'error');
  assert.equal(result.status.status,'unavailable');
});
test('base ausente: probe sem assinaturas impede spawn e nunca declara clean',async()=>{
  const {bridge,state}=makeBridge({hasSignatures:false});
  const result=await bridge.scanFile(file);
  assert.equal(state.probes,1);
  assert.equal(state.calls,0);
  assert.equal(result.verdict,'error');
  assert.equal(result.status.status,'unavailable');
});
test('análise inconclusiva: deadline termina handle falso e devolve timeout',async()=>{
  const {bridge,state}=makeBridge({hangs:true});
  const result=await bridge.scanFile(file);
  assert.equal(state.calls,1);
  assert.equal(state.kills,1);
  assert.equal(result.verdict,'error');
  assert.equal(result.reason,'timeout');
});
test('limpo comprovado: stdout por ficheiro OK chega pelo handle válido',async()=>{
  const {bridge,state}=makeBridge({outcome:{code:0,stdout:`${file}: OK\n`,stderr:'',killed:false,timedOut:false}});
  const result=await bridge.scanFile(file);
  assert.equal(state.calls,1);
  assert.equal(state.kills,0);
  assert.equal(result.verdict,'clean');
  assert.equal(result.detected,false);
});
test('exit zero sem prova de leitura não basta para declarar limpo',async()=>{
  const {bridge,state}=makeBridge({outcome:{code:0,stdout:'',stderr:'',killed:false,timedOut:false}});
  const result=await bridge.scanFile(file);
  assert.equal(state.calls,1);
  assert.equal(result.verdict,'error');
});
