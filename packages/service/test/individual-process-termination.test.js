import test from 'node:test';
import assert from 'node:assert/strict';
import {ProtectionEngineService} from '../dist/engine.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {LogWriter} from '../dist/log-writer.js';
import path from 'node:path';
function service() {
 const s=Object.create(ProtectionEngineService.prototype);
 Object.assign(s,{killRequestSeq:0,actionsLog:{write:async()=>{}},pipeAuthRequired:true,pipeToken:'synthetic-not-secret',disposed:false,isShuttingDown:false,startupStateValue:'ready',criticalRpcOperations:0,
  clamDatabaseGate:{state:{activeScans:0,updatePending:false,updateActive:false}},protectionState:false,protectionTransition:null,protectionStopUnconfirmed:false,fileObservationReads:0,realtimeQueue:{size:0,active:0},clamavPrefetches:new Map(),scanAbortControllers:new Map(),scanManager:{getActiveScan:()=>null,updateLeaseActive:()=>false},updater:{operationInProgress:false},ownChildPids:new Map(),processes:[]});
 return s;
}
test('service vetoes only critical work, untrusted pipe, startup and definitions updates',()=>{
 const oldReadonly=process.env.CYBERSAFE_DEV_WINDOWS_READONLY,oldFixture=process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;
 delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;
 try{assert.equal(service().terminationBlocked(),null);for(const change of [{criticalRpcOperations:1},{pipeAuthRequired:false},{pipeToken:undefined},{disposed:true},{isShuttingDown:true},{startupStateValue:'starting'}]){const s=service();Object.assign(s,change);assert.ok(s.terminationBlocked(),JSON.stringify(change));}
 // P0: realtime file work and the global scan are independent of an individual
 // handle-based termination. They must not hold the user in "aguarda alguns
 // segundos" indefinitely; protected/identity gates below still apply.
 for(const allowed of [{realtimeQueue:{size:3,active:1}},{fileObservationReads:2},{updater:{operationInProgress:true}},{clamDatabaseGate:{state:{activeScans:1,updatePending:true,updateActive:true}}}, {clamavPrefetches:new Map([['scan',{}]])},{scanAbortControllers:new Map([['scan',{}]]),scanManager:{getActiveScan:()=>({id:'scan'}),updateLeaseActive:()=>false}}]){const s=service();Object.assign(s,allowed);assert.equal(s.terminationBlocked(),null,JSON.stringify(allowed));}}
 finally{if(oldReadonly===undefined)delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;else process.env.CYBERSAFE_DEV_WINDOWS_READONLY=oldReadonly;if(oldFixture===undefined)delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;else process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN=oldFixture;}
});
test('legacy tree request stays refused without taskkill',async()=>{const s=service();s.runTaskkill=()=>{throw Error('must never run')};assert.equal((await s.killProcess(12345)).success,false)});
test('critical operation remains counted across async boundaries and is cleared on errors',async()=>{const s=service();let release;s.dispatchTracked=()=>new Promise(resolve=>release=resolve);const pending=s.dispatch('quarantine.restore',{id:'synthetic'});assert.equal(s.criticalRpcOperations,1);assert.ok(s.terminationBlocked());release({success:true});await pending;assert.equal(s.criticalRpcOperations,0);s.dispatchTracked=async()=>{throw Error('test')};await assert.rejects(()=>s.dispatch('definitions.update',undefined));assert.equal(s.criticalRpcOperations,0)});

test('real service dispatch with fake native handle: proof-only event, sanitized audit, natural exit separate',async()=>{
 const oldReadonly=process.env.CYBERSAFE_DEV_WINDOWS_READONLY,oldFixture=process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;
 delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;
 const root=await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)),'termination-mocked-'));
 try{
 const s=service();const events=[];let exited=false,kills=0;
 const startedAt='2026-10-30T08:00:00.0000000Z';const creation=((BigInt(Date.parse(startedAt))+11644473600000n)*10000n).toString();
 const identity={pid:12345,name:'notepad.exe',path:'C:\\Apps\\notepad.exe',startedAt,creation,eligible:true};
 Object.assign(s,{logsDir:root,individualTermination:null,processes:[{...identity,ppid:0}],eventBus:{publish:(...args)=>events.push(args)},gateMethodDuringStartup:async()=>{},
 killProtectionContext:()=>({selfPid:1,ancestorPids:[],internalPaths:[],internalPathPrefixes:[],commandLineMarkers:[],fallbackNames:[],systemPidThreshold:100}),
 openIndividualProcess:()=>({read:()=>identity,exited:()=>exited,terminate:()=>{kills++;exited=true},close(){}})});
 // A benign fixture must remain terminable while realtime work and a global
 // scan are active; the handle and creation identity are the proof, not queue idleness.
 Object.assign(s,{realtimeQueue:{size:2,active:1},fileObservationReads:1,clamavPrefetches:new Map([['scan',{}]]),scanAbortControllers:new Map([['scan',{}]]),scanManager:{getActiveScan:()=>({id:'scan'}),updateLeaseActive:()=>false}});
 const prepared=await s.dispatch('process.termination.prepare',{pid:12345,startedAt});assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.equal(kills,0);
 const result=await s.dispatch('process.termination.confirm',{ticket:prepared.ticket});assert.equal(result.confirmation,'handle-signaled');assert.equal(kills,1);assert.equal(s.processesEnumeratedAt,0);assert.equal(s.processes.length,1,'rows are not hidden by bare PID');
 assert.equal(events.length,1);assert.equal(events[0][0],'process.killed');assert.equal(events[0][3].scope,'single-process');assert.equal(events.some(e=>e[0]==='process.exited'),false);
 // Allow the append-only audit write to settle (no product filesystem touched).
 await new Promise(r=>setTimeout(r,50));const log=await readFile(path.join(root,'actions.log'),'utf8');assert.match(log,/user-confirmed/);assert.doesNotMatch(log,/C:\\Apps|pipeToken|synthetic-not-secret/);
 s.individualTermination.dispose();
 }finally{await rm(root,{recursive:true,force:true});if(oldReadonly===undefined)delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;else process.env.CYBERSAFE_DEV_WINDOWS_READONLY=oldReadonly;if(oldFixture===undefined)delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;else process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN=oldFixture;}
});

test('idle enabled protection is not disabled or treated as busy',()=>{const oldReadonly=process.env.CYBERSAFE_DEV_WINDOWS_READONLY,oldFixture=process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;try{const s=service();s.protectionState=true;assert.equal(s.terminationBlocked(),null,'sessão idle e protegida não é operação crítica');assert.equal(s.protectionState,true,'idle não desliga a proteção');const f=service();f.protectionState=true;process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN='1';assert.equal(f.terminationBlocked(),'readonly-mode','com scan de fixture real a sessão é read-only: a terminação é recusada por uma razão específica, não por um código agregado');}finally{if(oldReadonly===undefined)delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;else process.env.CYBERSAFE_DEV_WINDOWS_READONLY=oldReadonly;if(oldFixture===undefined)delete process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN;else process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN=oldFixture;}});

test('recusa legada fica auditada sem consultar nem atuar sobre processos', async t => {
 const root=await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)),'legacy-audit-'));
 const s=service();s.killRequestSeq=0;s.actionsLog=new LogWriter(root,'actions.log');
 let queries=0,kills=0,events=0;
 s.queryCimProcesses=async()=>{queries++;return []};s.runTaskkill=async()=>{kills++};s.eventBus={publish:()=>events++};
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const pid of [4,12345]){const result=await s.killProcess(pid);assert.equal(result.success,false);assert.equal(result.status,'failed');assert.match(result.error,/nenhuma ação/);}
 const lines=(await readFile(path.join(root,'actions.log'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(lines.length,2);assert.equal(new Set(lines.map(line=>line.requestId)).size,2);
 for(const line of lines){assert.equal(line.action,'process.termination.refused');assert.equal(line.reason,'legacy-disabled');assert.equal(line.executed,false);}
 assert.equal(queries,0);assert.equal(kills,0);assert.equal(events,0);
});

test('prepare -> confirm revalidates service gates and native identity without real processes', async t => {
 const previous = new Map(['CYBERSAFE_DEV_WINDOWS_READONLY','CYBERSAFE_REALDEV_FIXTURE_SCAN'].map(k=>[k,process.env[k]]));
 for(const key of previous.keys()) delete process.env[key];
 const root=await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)),'transition-audit-'));
 t.after(async()=>{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});});
 const startedAt='2026-10-30T08:00:00.0000000Z';
 const cases=[
  ['idle','killed',()=>{}],
  ['scan and realtime queue become busy','killed',s=>Object.assign(s,{realtimeQueue:{size:4,active:1},fileObservationReads:2,scanAbortControllers:new Map([['global',{}]]),scanManager:{getActiveScan:()=>({id:'global'}),updateLeaseActive:()=>false}})],
  ['natural exit','already-exited',(_s,f)=>f.exited=true],
  ['PID reuse','reused',(_s,f)=>f.identity={...f.identity,creation:(BigInt(f.identity.creation)+10n).toString()}],
  ['native eligibility revoked','protected',(_s,f)=>f.identity={...f.identity,eligible:false}],
  ['own child becomes protected','protected',s=>s.ownChildPids.set(12345,{})],
  ['critical operation begins','protected',s=>s.criticalRpcOperations=1],
  ['shutdown begins','protected',s=>s.isShuttingDown=true],
  ['authentication lost','protected',s=>s.pipeToken=undefined],
  ['readonly enabled','protected',()=>process.env.CYBERSAFE_DEV_WINDOWS_READONLY='1'],
  ['ticket expired','failed',(s,f)=>s.individualTermination.tickets.get(f.ticket).expiresAt=Date.now()-1],
  ['ticket invalid','failed',(_s,f)=>f.ticket='not-a-ticket'],
  ['controller disposed','failed',s=>s.individualTermination.dispose()],
 ];
 for(const [name,expected,change] of cases) await t.test(name,async()=>{
  delete process.env.CYBERSAFE_DEV_WINDOWS_READONLY;
  const s=service();let kills=0,closes=0,opens=0;
  const f={exited:false,identity:{pid:12345,name:'notepad.exe',path:path.win32.join('C:', 'Synthetic', 'notepad.exe'),startedAt,creation:((BigInt(Date.parse(startedAt))+11644473600000n)*10000n).toString(),eligible:true},ticket:''};
  Object.assign(s,{logsDir:root,individualTermination:null,processes:[{...f.identity,ppid:0}],eventBus:{publish(){}},gateMethodDuringStartup:async()=>{},
   killProtectionContext:()=>({selfPid:1,ancestorPids:[],internalPaths:[],internalPathPrefixes:[],commandLineMarkers:[],fallbackNames:[],systemPidThreshold:100}),
   openIndividualProcess:()=>{opens++;return {read:()=>({...f.identity}),exited:()=>f.exited,terminate:()=>{kills++;f.exited=true},close:()=>closes++}}});
  try {
   const p=await s.dispatch('process.termination.prepare',{pid:12345,startedAt});assert.equal(p.ok,true,name);assert.equal(kills,0);f.ticket=p.ticket;
   change(s,f);
   const result=await s.dispatch('process.termination.confirm',{ticket:f.ticket});
   assert.equal(result.status,expected,name);assert.equal(kills,expected==='killed'?1:0,name);assert.equal(opens,1,'confirm must never reopen by PID');
   assert.equal((await s.dispatch('process.termination.confirm',{ticket:f.ticket})).success,false,'one-use confirmation');
  } finally {s.individualTermination.dispose();}
  assert.equal(closes,1,'retained handle closes exactly once');
 });
 // Audit writes are append-only and asynchronous, not a claimed native proof.
 await new Promise(resolve=>setTimeout(resolve,50));
});
