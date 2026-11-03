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
