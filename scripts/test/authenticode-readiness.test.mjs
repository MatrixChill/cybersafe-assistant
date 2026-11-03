import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {auditAuthenticode} from '../authenticode-readiness.mjs';

async function fixture(t) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-auth-audit-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'benign.exe');await fs.writeFile(file,'inert fixture');return file; }
test('requires an approved publisher before querying Windows',async t=>{let called=false;const r=await auditAuthenticode(await fixture(t),'',{verify:async()=>{called=true;return {ok:true};}});assert.equal(r.ok,false);assert.equal(called,false);});
test('records final bytes only after valid Authenticode',async t=>{const r=await auditAuthenticode(await fixture(t),'Approved fixture',{verify:async()=>({ok:true})});assert.equal(r.ok,true);assert.equal(r.size,13);assert.match(r.sha256,/^[a-f0-9]{64}$/);assert.equal(r.productionEnabled,false);});
test('invalid signature fails closed without a release hash',async t=>{const r=await auditAuthenticode(await fixture(t),'Approved fixture',{verify:async()=>({ok:false,reason:'mismatch'})});assert.equal(r.ok,false);assert.equal(r.sha256,undefined);});
test('rejects mutation during verification',async t=>{const f=await fixture(t);const r=await auditAuthenticode(f,'Approved fixture',{verify:async()=>{await fs.writeFile(f,'changed bytes');return {ok:true};}});assert.equal(r.ok,false);assert.equal(r.sha256,undefined);});
