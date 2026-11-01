import test from 'node:test';
import assert from 'node:assert/strict';
import {ProtectionEngineService} from '../dist/engine.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
function service() {
 const s=Object.create(ProtectionEngineService.prototype);
 Object.assign(s,{pipeAuthRequired:true,pipeToken:'synthetic-not-secret',disposed:false,isShuttingDown:false,startupStateValue:'ready',criticalRpcOperations:0,
  clamDatabaseGate:{state:{activeScans:0,updatePending:false,updateActive:false}},protectionState:false,protectionTransition:null,protectionStopUnconfirmed:false,fileObservationReads:0,realtimeQueue:{size:0,active:0},clamavPrefetches:new Map(),scanAbortControllers:new Map(),scanManager:{getActiveScan:()=>null},updater:{operationInProgress:false},ownChildPids:new Map(),processes:[]});
 return s;
}
test('service vetoes critical work, untrusted pipe, startup and protection without invoking native code',()=>{
 const oldReadonly=process.env.CYBERSAFE_DEV_WINDOWS_READONLY,oldFixture=process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;
 delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;
 try{assert.equal(service().terminationBlocked(),null);for(const change of [{criticalRpcOperations:1},{realtimeQueue:{size:0,active:1}},{pipeAuthRequired:false},{pipeToken:undefined},{disposed:true},{isShuttingDown:true},{startupStateValue:'starting'},{scanManager:{getActiveScan:()=>({id:'x'})}},{updater:{operationInProgress:true}},{clamDatabaseGate:{state:{activeScans:1}}}]){const s=service();Object.assign(s,change);assert.ok(s.terminationBlocked(),JSON.stringify(change));}}
 finally{if(oldReadonly===undefined)delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;else process.env.CYBERSAFE_DEV_WINDOWS_READONLY=oldReadonly;if(oldFixture===undefined)delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;else process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN=oldFixture;}
});
test('legacy tree request stays refused without taskkill',async()=>{const s=service();s.runTaskkill=()=>{throw Error('must never run')};assert.equal((await s.killProcess(12345)).success,false)});
test('critical operation remains counted across async boundaries and is cleared on errors',async()=>{const s=service();let release;s.dispatchTracked=()=>new Promise(resolve=>release=resolve);const pending=s.dispatch('quarantine.restore',{id:'synthetic'});assert.equal(s.criticalRpcOperations,1);assert.ok(s.terminationBlocked());release({success:true});await pending;assert.equal(s.criticalRpcOperations,0);s.dispatchTracked=async()=>{throw Error('test')};await assert.rejects(()=>s.dispatch('definitions.update',undefined));assert.equal(s.criticalRpcOperations,0)});

test('real service dispatch with fake native handle: proof-only event, sanitized audit, natural exit separate',async()=>{
 const oldReadonly=process.env.CYBERSAFE_DEV_WINDOWS_READONLY,oldFixture=process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;
 delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;
 const root=await mkdtemp(path.join(os.tmpdir(),'termination-mocked-'));
 try{
 const s=service();const events=[];let exited=false,kills=0;
 const startedAt='2026-10-30T08:00:00.0000000Z';const creation=((BigInt(Date.parse(startedAt))+11644473600000n)*10000n).toString();
 const identity={pid:12345,name:'notepad.exe',path:'C:\\Apps\\notepad.exe',startedAt,creation,eligible:true};
 Object.assign(s,{logsDir:root,individualTermination:null,processes:[{...identity,ppid:0}],eventBus:{publish:(...args)=>events.push(args)},gateMethodDuringStartup:async()=>{},
 killProtectionContext:()=>({selfPid:1,ancestorPids:[],internalPaths:[],internalPathPrefixes:[],commandLineMarkers:[],fallbackNames:[],systemPidThreshold:100}),
 openIndividualProcess:()=>({read:()=>identity,exited:()=>exited,terminate:()=>{kills++;exited=true},close(){}})});
 const prepared=await s.dispatch('process.termination.prepare',{pid:12345,startedAt});assert.equal(prepared.ok,true);assert.equal(kills,0);
 const result=await s.dispatch('process.termination.confirm',{ticket:prepared.ticket});assert.equal(result.confirmation,'handle-signaled');assert.equal(kills,1);assert.equal(s.processesEnumeratedAt,0);assert.equal(s.processes.length,1,'rows are not hidden by bare PID');
 assert.equal(events.length,1);assert.equal(events[0][0],'process.killed');assert.equal(events[0][3].scope,'single-process');assert.equal(events.some(e=>e[0]==='process.exited'),false);
 // Allow the append-only audit write to settle (no product filesystem touched).
 await new Promise(r=>setTimeout(r,50));const log=await readFile(path.join(root,'actions.log'),'utf8');assert.match(log,/user-confirmed/);assert.doesNotMatch(log,/C:\\Apps|pipeToken|synthetic-not-secret/);
 s.individualTermination.dispose();
 }finally{await rm(root,{recursive:true,force:true});if(oldReadonly===undefined)delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;else process.env.CYBERSAFE_DEV_WINDOWS_READONLY=oldReadonly;if(oldFixture===undefined)delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;else process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN=oldFixture;}
});

test('idle enabled protection is not disabled or treated as busy',()=>{const oldReadonly=process.env.CYBERSAFE_DEV_WINDOWS_READONLY,oldFixture=process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;try{const s=service();s.protectionState=true;assert.equal(s.terminationBlocked(),null,'sessão idle e protegida não é operação crítica');assert.equal(s.protectionState,true,'idle não desliga a proteção');const f=service();f.protectionState=true;process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN='1';assert.equal(f.terminationBlocked(),'critical-operation-or-untrusted-session','com scan de fixture real a sessão é não-confiável: `engine.ts:3934` veta a terminação de caso, e essa recusa é o comportamento garantido, não um efeito secundário');}finally{if(oldReadonly===undefined)delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;else process.env.CYBERSAFE_DEV_WINDOWS_READONLY=oldReadonly;if(oldFixture===undefined)delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;else process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN=oldFixture;}});
