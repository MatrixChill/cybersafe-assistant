import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {atomicWriteJsonSync} from '../src/atomic-json.ts';
test('atomic JSON replaces a complete document and preserves old data on replacement failure',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cs-atomic-'));const file=path.join(dir,'settings.json');
 try{fs.writeFileSync(file,'{"previous":true}');
  for(const operation of ['writeFileSync','fsyncSync','renameSync']) {
   assert.throws(()=>atomicWriteJsonSync(file,{next:true},{...fs,[operation](){throw Error('injected failure')}}));
   assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{previous:true});
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{previous:true});assert.deepEqual(fs.readdirSync(dir),['settings.json']);
  atomicWriteJsonSync(file,{next:true});assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{next:true});
 }finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});
test('transient Windows rename contention retries without deleting the destination',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cs-atomic-retry-')),file=path.join(dir,'settings.json');fs.writeFileSync(file,'{"old":true}');let attempts=0;
 try{atomicWriteJsonSync(file,{next:true},{...fs,renameSync(from,to){attempts++;if(attempts===1){const error=new Error('busy');error.code='EBUSY';throw error;}return fs.renameSync(from,to);}});assert.equal(attempts,2);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{next:true});}
 finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});
