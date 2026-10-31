import {test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import {EventEmitter}from'node:events';
import {waitForApiHealth,startLocalApi}from'../src/api-lifecycle.ts';
const bootId='d0c0de00-0000-4000-8000-00000000c0de';
test('cold readiness at 25s is allowed inside a finite 60s default budget',async()=>{
 let clock=0;const ok=await waitForApiHealth(4991,{now:()=>clock,sleep:async ms=>{clock+=ms},intervalMs:1000,expectedBootId:bootId,fetchImpl:async()=>({ok:clock>=25000,json:async()=>({status:'ok',service:'cybersafe-api',bootId})})});
 assert.equal(ok,true);assert.ok(clock>=25000&&clock<=60000);
});
test('a foreign health responder cannot confirm this child',async()=>{
 let clock=0;const ok=await waitForApiHealth(4992,{timeoutMs:20,intervalMs:5,expectedBootId:bootId,now:()=>clock,sleep:async ms=>{clock+=ms},fetchImpl:async()=>({ok:true,json:async()=>({status:'ok',service:'cybersafe-api',bootId:'another-instance'})})});assert.equal(ok,false);
});
test('silent health connection cannot exceed the declared budget', {timeout:500},async()=>{
 const started=Date.now();assert.equal(await waitForApiHealth(4993,{timeoutMs:35,requestTimeoutMs:5,intervalMs:1,fetchImpl:async()=>new Promise(()=>{})}),false);assert.ok(Date.now()-started<300);
});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cs-api016-unit-'));const entry=path.join(root,'app/node_modules/api/dist/index.js');const child=new EventEmitter();child.pid=1234;child.exitCode=null;child.stderr=new EventEmitter();child.kill=()=>{child.exitCode=0;return true};return{root,child,options:{appPath:root+'/app',userDataDir:root+'/user',electronPath:'fixture.exe',existsSync:p=>p===entry,spawnImpl:()=>child,log:()=>{}}}}
test('early child exit ends pending readiness and never reports started',{timeout:500},async()=>{
 const{child,options}=fixture();const result=await startLocalApi({...options,waitForHealth:()=>{queueMicrotask(()=>{child.exitCode=1;child.emit('exit',1,null)});return new Promise(()=>{})}});assert.equal(result.status,'failed');
});
test('the owner receives the child before readiness starts',async()=>{
 const{child,options}=fixture();let owned;const result=await startLocalApi({...options,onChildSpawned:c=>{owned=c},waitForHealth:async()=>{assert.equal(owned,child);return true}});assert.equal(result.status,'started');child.exitCode=0;child.emit('exit',0,null);
});
