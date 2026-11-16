import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DefinitionUpdater} from '../dist/updater.js';
import {probeClamavManagement} from '../dist/external-clamav-manager.js';

test('manager probe is bounded, read-only and recognises an enabled Nigor timer',async()=>{
 const calls=[];
 const probe=(binary,args,options,callback)=>{
  calls.push({binary,args,options});
  callback(null,args[1].endsWith('.timer')?'LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n':'LoadState=not-found\n');
 };
 assert.deepEqual(await probeClamavManagement('linux',true,probe),{state:'managed',unit:'clamav-freshclam-once.timer'});
 assert.equal(calls.length,3);
 for(const call of calls){assert.equal(call.binary,'/usr/bin/systemctl');assert.equal(call.args[0],'show');assert.equal(call.options.timeout,2000);}
 calls.length=0;assert.deepEqual(await probeClamavManagement('win32',true,probe),{state:'none'});assert.equal(calls.length,0);
});

test('failed systemd inspection remains unknown, while an absent manager is not a successful update',async()=>{
 assert.deepEqual(await probeClamavManagement('linux',true,(_b,_a,_o,cb)=>cb(new Error('timeout'),'')),{state:'unknown'});
 assert.deepEqual(await probeClamavManagement('linux',true,(_b,_a,_o,cb)=>cb(null,'LoadState=not-found\n')),{state:'none'});
});

test('system-managed definitions are delegated without claiming a check, changing metadata or spawning FreshClam',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cs-external-db-'));
 const updater=new DefinitionUpdater(root,{probeClamavManager:async()=>({state:'managed',unit:'clamav-freshclam-once.timer'})});
 let spawns=0;updater.runFreshclam=()=>{spawns++;throw new Error('must not spawn')};
 updater.componentStale=component=>component==='clamav';
 const metadataBefore=await readFile(join(root,'.update-meta.json'),'utf8');
 try{
  const result=await updater.checkAndUpdate();
  assert.equal(result.clamChecked,false);assert.equal(result.clamUpdated,false);
  assert.equal(result.clamManagement.state,'managed');assert.equal(result.errors.length,0);
  assert.match(result.warnings.join(' '),/sistema/);assert.equal(spawns,0);
  assert.equal(updater.gate.state.updateActive,false);
  assert.equal(await readFile(join(root,'.update-meta.json'),'utf8'),metadataBefore);
 }finally{updater.stopScheduler();DefinitionUpdater.dispose();await rm(root,{recursive:true,force:true});}
});

test('unknown manager ownership defers definitions without starting a second writer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cs-unknown-db-'));
 const updater=new DefinitionUpdater(root,{probeClamavManager:async()=>({state:'unknown'})});
 updater.runFreshclam=()=>{throw new Error('unexpected writer')};
 updater.componentStale=component=>component==='clamav';
 try{
  const result=await updater.checkAndUpdate();
  assert.equal(result.clamChecked,false);assert.equal(result.clamUpdated,false);
  assert.equal(result.clamManagement.state,'unknown');assert.equal(result.warnings.length,1);
 }finally{updater.stopScheduler();DefinitionUpdater.dispose();await rm(root,{recursive:true,force:true});}
});
