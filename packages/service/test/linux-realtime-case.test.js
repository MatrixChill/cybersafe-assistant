import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeRecovery } from '../dist/realtime-recovery.js';
test('Linux saturation recovery does not merge two case-distinct files',{skip:process.platform!=='linux'},()=>{
 const recovery=new RealtimeRecovery({setTimer:()=>1,clearTimer:()=>{}});
 assert.equal(recovery.defer('/tmp/Case.txt','analysis',async()=>true),'scheduled');
 assert.equal(recovery.defer('/tmp/case.txt','analysis',async()=>true),'scheduled');
 assert.equal(recovery.snapshot().pending,2);
});
