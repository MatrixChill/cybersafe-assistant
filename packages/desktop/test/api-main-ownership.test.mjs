import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {EventEmitter} from 'node:events';
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const start=source.indexOf('function startPackagedApi(): void {');
const end=source.indexOf('\n/**',start+1);
assert.ok(start>0&&end>start);
const quitMarker='app.on("before-quit", (event) => {';
const quitStart=source.indexOf(quitMarker)+quitMarker.length;
const quitPrefix=source.slice(quitStart,source.indexOf('  if (!serviceProcess',quitStart));
const js=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function harness(){
 const stopped=[];let calls=0, resolve;
 const pending=new Promise(r=>resolve=r);
 const create=new Function('startLocalApi','stopLocalApi',`let apiRuntime=null,apiChild=null,apiStartInFlight=false,isQuitting=false;let serviceProcess=null,updateStateUnsub=null,appUpdater=null;const logExitEvent=()=>{};
 const app={isPackaged:true,getAppPath:()=>'',getPath:()=>''};const DEFAULT_API_PORT=4000;
 const process={execPath:'fixture'};const logStartup=()=>{};const classifyStartupError=()=> 'UNKNOWN';const console={log(){},error(){}};
 ${js}
 return {start:startPackagedApi,quit:()=>{${quitPrefix}},state:()=>({apiChild,apiRuntime,apiStartInFlight})};`);
 let options;const owner=create(o=>{calls++;options=o;return pending;},c=>stopped.push(c));
 return {owner,stopped,get calls(){return calls},spawn(child){options.onChildSpawned(child)},resolve};
}
test('actual Main retains pending child, prevents duplicate starts and stops it on quit',async()=>{
 const h=harness();h.owner.start();h.owner.start();assert.equal(h.calls,1);
 const child=new EventEmitter();h.spawn(child);assert.equal(h.owner.state().apiChild,child);
 h.owner.quit();assert.deepEqual(h.stopped,[child]);h.resolve({status:'started',runtime:{child}});
 await new Promise(r=>setImmediate(r));assert.equal(h.owner.state().apiRuntime,null);
 assert.equal(h.owner.state().apiStartInFlight,false);h.owner.start();assert.equal(h.calls,1);
});
test('failure cannot spawn over a child whose death has not been observed',async()=>{
 const h=harness();h.owner.start();const child=new EventEmitter();h.spawn(child);h.resolve({status:'failed',reason:'timeout'});
 await new Promise(r=>setImmediate(r));h.owner.start();assert.equal(h.calls,1);
 child.emit('exit',1,null);assert.equal(h.owner.state().apiChild,null);
});
