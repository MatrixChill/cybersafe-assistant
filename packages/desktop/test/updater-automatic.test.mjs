import test from 'node:test';
import assert from 'node:assert/strict';
import {startAutomaticChecks} from '../src/updater/automatic-checks.ts';
test('automatic checks require explicit preference, avoid overlap and stop at disposal',async()=>{
 let tick,cleared=false,calls=0,resolve;
 const state={automaticCheckEnabled:false,phase:'idle'};
 const updater={snapshotCopy:()=>state,check:()=>{calls++;return new Promise(r=>resolve=r)}};
 const stop=startAutomaticChecks(updater,{schedule:fn=>{tick=fn;return()=>{cleared=true}}});
 await tick();assert.equal(calls,0);
 state.automaticCheckEnabled=true;const pending=tick();await tick();assert.equal(calls,1);
 resolve({});await pending;state.phase='downloading';await tick();assert.equal(calls,1);
 stop();assert.equal(cleared,true);state.phase='idle';await tick();assert.equal(calls,1);
});
test('timer errors are contained and allow a later attempt',async()=>{
 let tick,calls=0;const stop=startAutomaticChecks({snapshotCopy:()=>({automaticCheckEnabled:true,phase:'idle'}),check:async()=>{calls++;throw Error('offline')}},{schedule:fn=>{tick=fn;return()=>{}}});
 await tick();await tick();assert.equal(calls,2);stop();
});
