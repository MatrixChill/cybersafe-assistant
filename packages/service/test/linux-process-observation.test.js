import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProtectionEngineService } from '../dist/engine.js';
test('Linux process event polling uses the existing POSIX identity provider, never CIM', {skip:process.platform!=='linux'}, async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cs-process-observer-'));const service=new ProtectionEngineService(root);
 t.after(async()=>{await service.dispose();await fs.rm(root,{recursive:true,force:true});});
 let rows=[{pid:100,ppid:1,name:'benign',cpu:0,memoryMb:1,startedAt:'2026-11-16T10:00:00Z'}];
 service.posixProcessProvider.list=()=>rows;
 assert.equal((await service.processMonitor.list())[0].pid,100);
 await service.processMonitor.seedOnly();
 const events=[];service.processMonitor.on('process.started',p=>events.push(p));
 rows=[...rows,{...rows[0],pid:101}];await service.processMonitor.poll();await service.processMonitor.poll();
 assert.deepEqual(events.map(p=>p.pid),[101]);
});
