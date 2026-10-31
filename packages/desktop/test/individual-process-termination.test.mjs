import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file,extra={}) {const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL,...extra});return exports;}
const {registerProcessTerminationIpc}=load('process-termination-ipc.ts');
const {trustedIpcHandler}=load('ipc-guard.ts');
const token='fba31111-1111-4111-8111-111111111111';
test('actual IPC registry rejects malformed requests and critical work before calling service',()=>{
 const handlers=new Map(),calls=[];let critical=false;
 registerProcessTerminationIpc((c,h)=>handlers.set(c,h),{prepare:p=>calls.push(['prepare',p]),confirm:t=>calls.push(['confirm',t]),cancel:t=>calls.push(['cancel',t]),critical:()=>critical});
 const prepare=handlers.get('service:prepare-process-termination'),confirm=handlers.get('service:confirm-process-termination');
 for(const p of [null,{}, {pid:-1,startedAt:'x'},{pid:4294967297,startedAt:'2026-10-30T08:00:00Z'}])assert.equal(prepare(null,p).ok,false);
 assert.equal(confirm(null,'bad').success,false);assert.equal(calls.length,0);
 critical=true;assert.equal(prepare(null,{pid:12345,startedAt:'2026-10-30T08:00:00Z'}).ok,false);assert.equal(confirm(null,token).success,false);assert.equal(calls.length,0);
 critical=false;prepare(null,{pid:12345,startedAt:'2026-10-30T08:00:00Z',path:'not forwarded'});assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['prepare',{pid:12345,startedAt:'2026-10-30T08:00:00Z'}]);
 confirm(null,token);assert.equal(calls[1][0],'confirm');
});
test('trusted-frame guard blocks foreign windows, remote documents and subframes for every termination channel',()=>{
 const frame={url:'file:///trusted/index.html'},contents={mainFrame:frame,isDestroyed:()=>false},handlers=new Map();let calls=0;
 registerProcessTerminationIpc((c,h)=>handlers.set(c,trustedIpcHandler(()=>contents,()=> 'file:///trusted/index.html',h)),{prepare:()=>calls++,confirm:()=>calls++,cancel:()=>calls++,critical:()=>false});
 for(const event of [{sender:{},senderFrame:frame},{sender:contents,senderFrame:{url:frame.url}},{sender:contents,senderFrame:null}])for(const h of handlers.values())assert.throws(()=>h(event,token));
 frame.url='https://untrusted.invalid';for(const h of handlers.values())assert.throws(()=>h({sender:contents,senderFrame:frame},token));assert.equal(calls,0);
});
test('real preload exposes only fixed channels, strips extra input and never confirms on prepare/cancel',async()=>{
 let bridge;const calls=[];const code=ts.transpileModule(fs.readFileSync(new URL('../src/preload.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,api)=>{if(name==='electronAPI')bridge=api}},ipcRenderer:{on(){},invoke:(...args)=>{calls.push(args);return Promise.resolve({})}},webUtils:{}}},process:{env:{}},console,URL,setTimeout,clearTimeout});
 const p={pid:12345,startedAt:'2026-10-30T08:00:00.0000000Z'};await bridge.prepareProcessTermination({...p,extra:'stripped'});await bridge.cancelProcessTermination(token);
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['service:prepare-process-termination',p],['service:cancel-process-termination',token]]);
 await assert.rejects(()=>bridge.confirmProcessTermination('bad'));assert.equal(calls.length,2);await bridge.confirmProcessTermination(token);assert.equal(calls[2][0],'service:confirm-process-termination');
});

test('all new termination channels remain denied in Windows readonly mode',async()=>{
 const {decidirCanalWindowsReadOnly}=await import('../src/dev-windows-readonly-boundary.ts');
 for(const channel of ['service:prepare-process-termination','service:confirm-process-termination','service:cancel-process-termination'])assert.equal(decidirCanalWindowsReadOnly(channel).permitido,false);
});
