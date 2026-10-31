import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SignatureDatabase,sanitizeSignatureRecords} from '../dist/signatures.js';

test('QA3: only complete hexadecimal SHA-256 values count as usable signatures',()=>{
 const valid='a1'.repeat(32);
 const records=sanitizeSignatureRecords([
  {sha256:'not-a-hash'},{sha256:'a'.repeat(63)},{sha256:'a'.repeat(65)},
  {sha256:'g'.repeat(64)},{sha256:' '},
  {sha256:' '+valid.toUpperCase()+' ',family:'benign controlled fixture'},
  {sha256:valid,family:'duplicate'},
 ]);
 assert.equal(records.length,1);
 assert.equal(records[0].sha256,valid);
 assert.equal(records[0].family,'benign controlled fixture');
});

test('QA3: database containing only unusable hashes falls back degraded, never active',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qa3-invalid-hashdb-'));
 try{
  const file=path.join(dir,'hashes.json');
  await fs.writeFile(file,JSON.stringify([{sha256:'invalid-only',family:'not a usable signature'}]));
  const db=new SignatureDatabase();await db.load(file);
  assert.equal(db.health.status,'degraded');
  assert.equal(db.source,'built-in');
  assert.ok(db.size>0);
  assert.equal(db.match('invalid-only'),undefined);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
