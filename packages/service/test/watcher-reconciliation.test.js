import test from 'node:test';import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {reconcileWatcherRoot} from '../dist/watcher-reconciliation.js';
test('root requires actual completed analyses and an unchanged snapshot',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cs-reconcile-'));const file=path.join(root,'benign.txt');
 try{await fs.writeFile(file,'benign');let calls=0;const signal=new AbortController().signal;
 assert.equal(await reconcileWatcherRoot(root,async()=>{calls++;return true;},signal),true);assert.equal(calls,1);
 assert.equal(await reconcileWatcherRoot(root,async()=>false,signal),false);
 assert.equal(await reconcileWatcherRoot(root,async()=>{await fs.writeFile(file,'changed');return true;},signal),false);
 const aborted=new AbortController();aborted.abort();assert.equal(await reconcileWatcherRoot(root,async()=>true,aborted.signal),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('missing and oversized roots cannot be declared reconciled',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cs-reconcile-'));
 try{const signal=new AbortController().signal;assert.equal(await reconcileWatcherRoot(path.join(root,'absent'),async()=>true,signal),false);
 for(let i=0;i<33;i++)await fs.writeFile(path.join(root,`${i}.txt`),'benign');let calls=0;
 assert.equal(await reconcileWatcherRoot(root,async()=>{calls++;return true;},signal),false);assert.equal(calls,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

import {RealtimeLossLedger} from '../dist/realtime-loss.js';
import {realtimeCoverage} from '@cybersafe/shared-types';
test('only reconciled snapshot gaps clear; counters and unavailable roots persist',()=>{
 const loss=new RealtimeLossLedger();loss.noteWatcherSignal({path:'fixture',novos:1,total:1});
 loss.noteCoverageGap('fixture','overflow');
 assert.equal(realtimeCoverage({realtimeLoss:loss.summary()}).watcherIndeterminate,true);
 loss.confirmRootSnapshot('fixture');
 assert.equal(loss.summary().watcherNamelessCallbacks,1);
 assert.equal(realtimeCoverage({realtimeLoss:loss.summary()}).watcherIndeterminate,false);
 loss.noteCoverageGap('fixture','raiz-desaparecida');loss.noteCoverageGap('fixture','overflow');loss.confirmRootSnapshot('fixture');
 assert.equal(realtimeCoverage({realtimeLoss:loss.summary()}).watcherIndeterminate,true);
});

import {WatcherReconciler} from '../dist/watcher-reconciliation.js';
test('new signals and stop invalidate an in-flight confirmation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolve;const confirmed=[];
 const scheduler=new WatcherReconciler(()=>new Promise(r=>{resolve=r;}),root=>confirmed.push(root));
 scheduler.schedule('fixture');t.mock.timers.tick(3000);await Promise.resolve();
 scheduler.schedule('fixture');resolve(true);for(let i=0;i<8;i++)await Promise.resolve();
 assert.deepEqual(confirmed,[]);
 t.mock.timers.tick(3000);await Promise.resolve();scheduler.clear();resolve(true);
 for(let i=0;i<8;i++)await Promise.resolve();assert.deepEqual(confirmed,[]);
});
test('timer alone never confirms recovery; a successful operation is required',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const confirmed=[];
 const scheduler=new WatcherReconciler(async()=>false,root=>confirmed.push(root));
 scheduler.schedule('fixture');t.mock.timers.tick(3000);for(let i=0;i<8;i++)await Promise.resolve();
 assert.deepEqual(confirmed,[]);scheduler.clear();
});
