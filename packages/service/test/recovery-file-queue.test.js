import test from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeFileQueue} from '../dist/realtime-file-queue.js';
const tick=()=>new Promise(r=>setImmediate(r));
test('bounded queue coalesces duplicate fingerprint but retains changed file after running job',async()=>{
  let release;const calls=[];const q=new RealtimeFileQueue(2,()=>100);
  assert.equal(q.enqueue('a','v1',async()=>{calls.push('v1');await new Promise(r=>release=r)}),'queued');
  assert.equal(q.enqueue('a','v1',async()=>calls.push('duplicate')),'duplicate');
  assert.equal(q.enqueue('a','v2',async()=>calls.push('v2')),'queued');
  q.enqueue('b','v1',async()=>calls.push('b'));
  assert.equal(q.enqueue('c','v1',async()=>calls.push('c')),'full');
  release();await tick();await tick();assert.deepEqual(calls,['v1','v2','b']);assert.equal(q.active,0);
  assert.equal(q.enqueue('a','v2',async()=>calls.push('duplicate')),'duplicate');
});
test('clear removes pending admissions, permits fresh generation and catches job failure',async()=>{
  let release;const calls=[];const q=new RealtimeFileQueue();
  q.enqueue('a','v1',async()=>{await new Promise(r=>release=r)});q.enqueue('b','v1',async()=>calls.push('b'));
  q.clear();q.enqueue('c','v1',async()=>{calls.push('c');throw Error('fixture')});release();await tick();await tick();
  assert.deepEqual(calls,['c']);assert.equal(q.active,0);
});
