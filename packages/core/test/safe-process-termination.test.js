import test from 'node:test';
import assert from 'node:assert/strict';
import { SafeProcessTermination } from '../dist/safe-process-termination.js';
const start='2026-10-30T08:00:00.0000000Z';
function fixture(overrides={}) {
 let kills=0,closed=0,exited=false,busy=false; const events=[];
 const info={pid:900,name:'ordinary.exe',path:'C:\\Apps\\ordinary.exe',startedAt:start,creation:((BigInt(Date.parse(start))+11644473600000n)*10000n).toString(),eligible:true,...overrides};
 const lease={read:()=>({...info}), exited:()=>exited,terminate:()=>{kills++;exited=true;}, close:()=>closed++};
 const controller=new SafeProcessTermination({open:()=>lease,blocked:()=>busy?'critical-operation':null,audit:e=>events.push(e)});
 return {controller,info,events,lease,get kills(){return kills},get closed(){return closed},busy:()=>busy=true,exit:()=>exited=true};
}
function prepare(f){return f.controller.prepare({pid:900,startedAt:start});}
test('preparation and cancellation never terminate; one-use ticket',async()=>{const f=fixture();const p=prepare(f);assert.equal(p.ok,true);f.controller.cancel(p.ticket);assert.equal(f.kills,0);assert.equal(f.closed,1);assert.equal((await f.controller.confirm(p.ticket)).success,false);});
test('confirmed single target, exit proof and audit provenance',async()=>{const f=fixture();const p=prepare(f);assert.equal(f.kills,0);const r=await f.controller.confirm(p.ticket);assert.equal(r.status,'killed');assert.equal(f.kills,1);assert.equal(f.closed,1);assert.equal(f.events.at(-1).status,'killed');assert.equal(f.events.at(-1).source,'user-confirmed');assert.equal((await f.controller.confirm(p.ticket)).success,false);});
test('protected and own processes are denied before mutation',()=>{for(const reason of ['protected','self','security','service']){const f=fixture({eligible:false,reason});assert.equal(prepare(f).ok,false);assert.equal(f.kills,0);assert.equal(f.closed,1);}});
test('PID reuse and incomplete creation identity fail closed',async()=>{const f=fixture();const p=prepare(f);f.info.creation='different';assert.equal((await f.controller.confirm(p.ticket)).status,'reused');assert.equal(f.kills,0);assert.equal(prepare(fixture({startedAt:null})).ok,false);});
test('natural exit is never attributed to CyberSafe',async()=>{const f=fixture();const p=prepare(f);f.exit();const r=await f.controller.confirm(p.ticket);assert.equal(r.status,'already-exited');assert.equal(f.kills,0);assert.equal(f.events.at(-1).status,'already-exited');});
test('critical work is checked again after confirmation',async()=>{const f=fixture();const p=prepare(f);f.busy();assert.equal((await f.controller.confirm(p.ticket)).success,false);assert.equal(f.kills,0);});
test('Windows access denied is preserved numerically without raw diagnostics',async()=>{const f=fixture();f.lease.terminate=()=>{throw Object.assign(new Error('sensitive raw output'),{win32Code:5})};const r=await f.controller.confirm(prepare(f).ticket);assert.equal(r.status,'access-denied');assert.equal(r.win32Code,5);assert.equal(JSON.stringify(r).includes('sensitive'),false);assert.equal(f.closed,1);});
test('termination requested without signaled exit is timeout, never success',async()=>{const f=fixture();f.lease.terminate=()=>{};f.controller.waitMs=1;const r=await f.controller.confirm(prepare(f).ticket);assert.equal(r.status,'timeout');assert.equal(r.success,false);});
test('malformed input, expired tickets and shutdown close handles without mutation',async()=>{const f=fixture();assert.equal(f.controller.prepare({pid:900}).ok,false);const p=prepare(f);f.controller.dispose();assert.equal((await f.controller.confirm(p.ticket)).success,false);assert.equal(f.closed,1);assert.equal(f.kills,0);});

test('expired confirmation cannot mutate and releases its handle',async()=>{const f=fixture();const p=prepare(f);f.controller.tickets.get(p.ticket).expiresAt=Date.now()-1;assert.equal((await f.controller.confirm(p.ticket)).success,false);assert.equal(f.kills,0);assert.equal(f.closed,1);});
test('lossy millisecond snapshot is refused, including same-millisecond reuse',()=>{const f=fixture();assert.equal(f.controller.prepare({pid:900,startedAt:'2026-10-30T08:00:00.000Z'}).ok,false);f.info.creation=(BigInt(f.info.creation)+10n).toString();assert.equal(prepare(f).ok,false);assert.equal(f.kills,0)});

test('CIM microseconds prepare a native exact identity; later 100 ns change is refused',async()=>{const f=fixture();f.info.creation=(BigInt(f.info.creation)+1n).toString();f.info.startedAt='2026-10-30T08:00:00.0000001Z';const p=prepare(f);assert.equal(p.ok,true);assert.equal(p.target.startedAt,f.info.startedAt);f.info.creation=(BigInt(f.info.creation)+1n).toString();assert.equal((await f.controller.confirm(p.ticket)).status,'reused');assert.equal(f.kills,0)});

test('eligibility is rechecked immediately before mutation',async()=>{const f=fixture();const p=prepare(f);f.info.eligible=false;assert.equal((await f.controller.confirm(p.ticket)).status,'protected');assert.equal(f.kills,0)});
