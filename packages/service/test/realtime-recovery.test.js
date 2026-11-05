import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeRecovery} from '../dist/realtime-recovery.js';
function harness(options={}) {
 let time=0; let seq=0;const timers=new Map();
 const queue=new RealtimeRecovery({...options,now:()=>time,setTimer:fn=>{timers.set(++seq,fn);return seq;},clearTimer:id=>timers.delete(id)});
 return {queue,timers,advance:ms=>{time+=ms;},async tick(){const first=timers.entries().next().value;if(first){timers.delete(first[0]);first[1]();}for(let i=0;i<8;i++)await Promise.resolve();}};
}
test('separa causas, deduplica caminhos e recupera quando a admissão passa',async()=>{
 const h=harness();let calls=0;
 h.queue.defer('C:/fixture/a','metadata',async()=>{calls++;return true;});
 h.queue.defer('c:/fixture/a','analysis',async()=>{calls++;return true;});
 assert.equal(h.queue.snapshot().metadataRejections,1);assert.equal(h.queue.snapshot().analysisRejections,1);
 assert.equal(h.queue.snapshot().pending,1);await h.tick();assert.equal(calls,1);assert.equal(h.queue.snapshot().recovered,1);
});
test('maxPaths não cresce e recusa adicional fica registada',()=>{
 const h=harness({maxPaths:2});const run=async()=>false;
 h.queue.defer('a','metadata',run);h.queue.defer('b','analysis',run);
 assert.equal(h.queue.defer('c','analysis',run),'full');assert.equal(h.queue.snapshot().pending,2);assert.equal(h.queue.snapshot().dropped,1);
});
test('repetição tem orçamento finito mesmo com callbacks repetidos',async()=>{
 const h=harness({maxAttempts:3});let calls=0;const run=async()=>{calls++;return false;};
 h.queue.defer('a','analysis',run);
 await h.tick();h.queue.defer('a','analysis',run);await h.tick();await h.tick();await h.tick();
 assert.equal(calls,3);assert.equal(h.queue.snapshot().exhausted,1);assert.equal(h.timers.size,0);
});
test('TTL impede tentativa tardia',async()=>{
 const h=harness({maxAgeMs:30});let calls=0;h.queue.defer('a','metadata',async()=>{calls++;return true;});h.advance(31);await h.tick();assert.equal(calls,0);assert.equal(h.queue.snapshot().expired,1);
});
test('encerramento cancela timer e não ressuscita trabalho em execução',async()=>{
 const h=harness();let release;let calls=0;
 h.queue.defer('a','analysis',()=>{calls++;return new Promise(r=>release=r);});await h.tick();h.queue.defer('b','metadata',async()=>{calls++;return true;});h.queue.clear();release(false);for(let i=0;i<8;i++)await Promise.resolve();await h.tick();assert.equal(calls,1);assert.equal(h.timers.size,0);assert.equal(h.queue.snapshot().pending,0);
});
test('exceções consomem orçamento e não criam unhandled rejection',async()=>{
 const h=harness({maxAttempts:2});h.queue.defer('a','metadata',async()=>{throw Error('fixture');});await h.tick();await h.tick();assert.equal(h.queue.snapshot().exhausted,1);assert.equal(h.timers.size,0);
});
test('apenas uma tentativa em execução',async()=>{
 const h=harness();let release;let second=0;
 h.queue.defer('a','analysis',()=>new Promise(r=>release=r));h.queue.defer('b','analysis',async()=>{second++;return true;});await h.tick();await h.tick();assert.equal(second,0);release(true);for(let i=0;i<8;i++)await Promise.resolve();await h.tick();assert.equal(second,1);
});

test('uma admissão bloqueada tem prazo e não bloqueia os outros caminhos',async()=>{
 const h=harness({maxAttempts:1});let second=0;
 h.queue.defer('a','metadata',()=>new Promise(()=>{}));h.queue.defer('b','analysis',async()=>{second++;return true;});
 await h.tick();await h.tick();await h.tick();assert.equal(second,1);assert.equal(h.queue.snapshot().exhausted,1);
});
test('clear também liberta uma tentativa que nunca respondeu',async()=>{
 const h=harness();h.queue.defer('a','metadata',()=>new Promise(()=>{}));await h.tick();h.queue.clear();for(let i=0;i<12;i++)await Promise.resolve();assert.equal(h.timers.size,0);assert.equal(h.queue.snapshot().running,false);
});

test('resultado da versão antiga não confirma a revisão recebida em voo',async()=>{
 const h=harness();let release;let old=0;let latest=0;
 h.queue.defer('a','analysis',()=>{old++;return new Promise(r=>release=r);});await h.tick();
 h.queue.defer('A','metadata',async()=>{latest++;return true;});release(true);for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(h.queue.snapshot().recovered,0);await h.tick();assert.equal(old,1);assert.equal(latest,1);assert.equal(h.queue.snapshot().recovered,1);
});
test('cooldown após esgotar mantém budget e só liberta com nova janela',async()=>{
 const h=harness({maxAttempts:1,maxAgeMs:30});let calls=0;const run=async()=>{calls++;return false;};
 h.queue.defer('a','metadata',run);await h.tick();assert.equal(calls,1);
 assert.equal(h.queue.defer('A','analysis',run),'full');await h.tick();assert.equal(calls,1);assert.equal(h.queue.snapshot().suppressed,1);
 h.advance(31);assert.equal(h.queue.defer('a','analysis',run),'scheduled');await h.tick();assert.equal(calls,2);
});

// Real elapsed scheduling (the older harness intentionally ignores delays).
function elapsedHarness() {
 let time=0, sequence=0; const timers=new Map();
 const recovery=new RealtimeRecovery({now:()=>time,
  setTimer:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:time+delay});return id;},
  clearTimer:id=>timers.delete(id)});
 return {recovery,get time(){return time;},async until(end){
  for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
   if(!next || next[1].at>end)break;
   timers.delete(next[0]);time=next[1].at;next[1].fn();
   for(let i=0;i<16;i++)await Promise.resolve();
  }time=end;
 }};
}

test('default recovery survives a seven-second occupied analysis slot',async()=>{
 const h=elapsedHarness();let admitted=0;
 h.recovery.defer('fixture/download.txt','analysis',async()=>{
  if(h.time<7000)return false;
  admitted++;return true;
 });
 await h.until(12000);
 assert.equal(admitted,1,'a temporary seven-second saturation must not exhaust recovery at 3.1 seconds');
 assert.equal(h.recovery.snapshot().recovered,1);
 assert.equal(h.recovery.snapshot().exhausted,0);
 assert.equal(h.recovery.snapshot().pending,0);
});

test('default recovery still expires persistent saturation within its two-minute window',async()=>{
 const h=elapsedHarness();let attempts=0;
 h.recovery.defer('fixture/blocked.txt','analysis',async()=>{attempts++;return false;});
 await h.until(126000);
 const snapshot=h.recovery.snapshot();
 assert.equal(snapshot.pending,0);
 assert.equal(snapshot.expired,1);
 assert.ok(attempts<=32,'admission work must remain bounded');
 const before=attempts;await h.until(240000);assert.equal(attempts,before);
});

test('real bounded queue admits a rejected file after a seven-second scan completes',async()=>{
 const {RealtimeFileQueue}=await import('../dist/realtime-file-queue.js');
 const h=elapsedHarness();const q=new RealtimeFileQueue(1,()=>h.time);const scanned=[];let release;
 q.enqueue('running','v1',()=>new Promise(resolve=>{release=resolve;}));
 q.enqueue('waiting','v1',async()=>{scanned.push('waiting');});
 const admit=async()=>q.enqueue('download','v1',async()=>{scanned.push('download');},'high')!=='full';
 assert.equal(await admit(),false);
 h.recovery.defer('download','analysis',admit);
 await h.until(7000);
 assert.equal(h.recovery.snapshot().pending,1);
 release();for(let i=0;i<24;i++)await Promise.resolve();
 await h.until(12000);for(let i=0;i<24;i++)await Promise.resolve();
 assert.deepEqual(scanned,['waiting','download']);
 assert.equal(h.recovery.snapshot().recovered,1);
 assert.equal(q.active,0);assert.equal(q.size,0);
});
