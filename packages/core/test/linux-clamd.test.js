import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ClamdUnixClient } from '../dist/clamd-linux.js';
import { ClamavBridge, clamavSlotStats } from '../dist/clamav.js';

async function fixture(t, reply = 'stream: OK\0', delay = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-clamd-'));
  await fs.chmod(root, 0o700);
  const socketPath = path.join(root, 'clamd.sock');
  const file = path.join(root, 'benign.txt'); await fs.writeFile(file, 'benign data');
  const sockets = new Set();
  let bytes = Buffer.alloc(0);
  const order = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let input = Buffer.alloc(0), command = false, payload = Buffer.alloc(0);
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (!command) { const n = input.indexOf(0); if (n < 0) return;
        if(input.subarray(0,n).toString()==='zVERSION'){socket.end('ClamAV 1.5.4/1/Test\0');return;}
        assert.equal(input.subarray(0,n).toString(), 'zINSTREAM'); input = input.subarray(n+1); command = true; }
      while (input.length >= 4) {
        const size = input.readUInt32BE(); if (input.length < size+4) return;
        payload = Buffer.concat([payload, input.subarray(4,4+size)]);
        bytes = Buffer.concat([bytes, input.subarray(4,4+size)]); input = input.subarray(4+size);
        if (!size) { order.push(payload.toString()); setTimeout(() => socket.end(reply), delay); return; }
      }
    });
  });
  await new Promise(r => server.listen(socketPath,r)); await fs.chmod(socketPath,0o600);
  const client = new ClamdUnixClient(socketPath);
  t.after(async()=>{client.dispose(); for(const s of sockets)s.destroy(); await new Promise(r=>server.close(r)); await fs.rm(root,{recursive:true,force:true});});
  return { client, file, socketPath, root, order, bytes: () => bytes };
}
const linux = { skip: process.platform !== 'linux' };
test('Unix INSTREAM transmits exact bytes and requires explicit OK', linux, async t => {
  const f = await fixture(t); const result = await f.client.scan(f.file,{timeoutMs:1000});
  assert.equal(result.outcome.verdict,'clean'); assert.deepEqual(f.bytes(),await fs.readFile(f.file));
});
test('daemon signature is mapped to the requested file, not stream', linux, async t => {
  const f=await fixture(t,'stream: Eicar-Signature FOUND\0');const r=await f.client.scan(f.file,{timeoutMs:1000});
  assert.equal(r.outcome.file,f.file);assert.equal(r.outcome.verdict,'detected');assert.equal(r.outcome.signature,'Eicar-Signature');
});
for (const reply of ['stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0','stream: error ERROR\0','nonsense\0']) {
  test(`daemon incomplete/limited result stays inconclusive: ${reply.slice(0,45)}`,linux,async t=>{
    const f=await fixture(t,reply);assert.equal((await f.client.scan(f.file,{timeoutMs:1000})).outcome.verdict,'error');
  });
}
test('timeout is not proof that the daemon stopped; late terminal response confirms completion',linux,async t=>{
  const f=await fixture(t,'stream: OK\0',80);const r=await f.client.scan(f.file,{timeoutMs:25});
  assert.equal(r.outcome.reason,'timeout');assert.equal(r.uncertain,true);assert.equal(await r.completion,true);
});
test('symlink input and world-writable daemon sockets are refused',linux,async t=>{
  const f=await fixture(t);const link=path.join(f.root,'link');await fs.symlink(f.file,link);
  assert.equal((await f.client.scan(link,{timeoutMs:1000})).outcome.verdict,'error');
  await fs.chmod(f.socketPath,0o666);
  assert.equal((await f.client.scan(f.file,{timeoutMs:1000})).outcome.verdict,'error');assert.equal(f.bytes().length,0);
});
test('cancelled before admission sends no bytes',linux,async t=>{
  const f=await fixture(t);const c=new AbortController();c.abort();
  const r=await f.client.scan(f.file,{timeoutMs:1000,signal:c.signal});assert.equal(r.outcome.reason,'aborted');assert.equal(f.bytes().length,0);
});

function bridge(t,f,timeout=1000) {
  const b=new ClamavBridge({linuxDaemonSocket:f.socketPath,linuxDaemonDatabaseDir:f.root,scanTimeoutMs:timeout});
  // Transport/scheduler contract test, not a DB load proof. Real bases are
  // exercised separately by the opt-in benchmark.
  b.isAvailable=async()=>true;b._hasSignatures=true;b._health={status:'active'};b._databaseHealth={status:'active'};b._dbDir=f.root;
  t.after(()=>b.dispose());return b;
}
test('persistent backend: realtime overtakes 30 admitted jobs; all background finishes',linux,async t=>{
  const f=await fixture(t,'stream: OK\0',15);const b=bridge(t,f);
  await fs.writeFile(path.join(f.root,'daily.cvd'),'ClamAV-VDB:Test:1:10:90:hash:sig:builder:1');
  const jobs=Array.from({length:30},()=>b.scanFiles([f.file],{priority:'background'}));
  while(clamavSlotStats().waitingBackground<29)await new Promise(r=>setTimeout(r,1));
  const urgent=path.join(f.root,'new-download');await fs.writeFile(urgent,'new-download');
  const result=await b.scanFiles([urgent],{priority:'realtime'});
  assert.equal(result.files[0].verdict,'clean');assert.ok(f.order.indexOf('new-download')<3);
  assert.ok((await Promise.all(jobs)).every(r=>r.errorCount===0));assert.equal(clamavSlotStats().active,0);
  assert.equal(result.timing.backend,'clamd');
});
test('persistent timeout poisons admission until a real late terminal response',linux,async t=>{
  const f=await fixture(t,'stream: OK\0',100);const b=bridge(t,f,30);
  await fs.writeFile(path.join(f.root,'daily.cvd'),'ClamAV-VDB:Test:1:10:90:hash:sig:builder:1');
  const r=await b.scanFiles([f.file]);assert.equal(r.files[0].reason,'timeout');assert.equal(clamavSlotStats().poisoned,1);
  assert.equal((await b.scanFiles([f.file])).errorCount,1);
  await new Promise(r=>setTimeout(r,130));assert.equal(clamavSlotStats().poisoned,0);assert.equal(clamavSlotStats().active,0);
});

test('daemon loaded daily version is observable for freshness gating',linux,async t=>{
 const f=await fixture(t);assert.equal(await f.client.databaseVersion(),1);
});

test('stale daemon uses the explicit cold fallback, never reports it as persistent coverage',linux,async t=>{
 const f=await fixture(t);const b=bridge(t,f);let fallback=0;
 await fs.writeFile(path.join(f.root,'daily.cvd'),'ClamAV-VDB:Test:2:10:90:hash:sig:builder:1');
 b.options.spawn=()=>{fallback++;return {pid:undefined,killTree(){},outcome:Promise.resolve({code:0,stdout:`${f.file}: OK\n`,stderr:'',killed:false})};};
 const r=await b.scanFiles([f.file]);assert.equal(fallback,1);assert.equal(f.bytes().length,0);assert.equal(r.timing,undefined);
});
