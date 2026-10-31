import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {QuarantineManager} from '../dist/response.js';
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-recovery-quarantine-'));
 const file=path.join(dir,'fixture.txt');await fs.writeFile(file,'Benign fixture');
 const q=new QuarantineManager(dir);await q.init();
 t.after(async()=>{for(const e of q.list())await fs.chmod(e.quarantinePath,0o600).catch(()=>{});await fs.rm(dir,{recursive:true,force:true});});
 const sha=createHash('sha256').update('Benign fixture').digest('hex');
 return {q,dir,file,analysis:{artifactPath:file,fileName:'fixture.txt',sha256:sha,verdict:'malicious',severity:'critical',riskScore:100,rulesTriggered:['known_bad_hash'],confidence:0.99}};
}
test('success is verified against real destination and durable confirmed manifest',async t=>{
 const {q,dir,file,analysis}=await fixture(t);const entry=await q.quarantine(analysis);
 assert.equal(entry.isolationStatus,'confirmed');await assert.rejects(fs.stat(file));assert.ok(await fs.stat(entry.quarantinePath));
 const disk=JSON.parse(await fs.readFile(path.join(dir,'quarantine','manifest.json'),'utf8'));
 assert.equal(disk[0].sha256,analysis.sha256);assert.equal(disk[0].isolationStatus,'confirmed');
 const reopened=new QuarantineManager(dir);await reopened.init();assert.equal(reopened.list()[0].id,entry.id);
});
test('changed detection digest refuses movement and preserves source',async t=>{
 const {q,file,analysis}=await fixture(t);await fs.writeFile(file,'Changed benign fixture');assert.equal(await q.quarantine(analysis),null);
 assert.equal(await fs.readFile(file,'utf8'),'Changed benign fixture');assert.equal(q.list().length,0);
});
test('manifest failure before move preserves source',async t=>{
 const {q,file,analysis}=await fixture(t);q.flush=async()=>{throw Error('fixture manifest failure')};assert.equal(await q.quarantine(analysis),null);
 assert.equal(await fs.readFile(file,'utf8'),'Benign fixture');assert.equal(q.list().length,0);
});
test('rename failure preserves original and never confirms manifest',async t=>{
 const {q,file,analysis}=await fixture(t);const rename=fs.rename;fs.rename=async(a,b)=>{if(a===file)throw Object.assign(Error('fixture locked'),{code:'EPERM'});return rename(a,b)};
 try{assert.equal(await q.quarantine(analysis),null);}finally{fs.rename=rename;}
 assert.equal(await fs.readFile(file,'utf8'),'Benign fixture');assert.equal(q.list().some(e=>e.isolationStatus==='confirmed'),false);
});
test('chmod failure after movement retains recovery metadata and bytes without success',async t=>{
 const {q,dir,analysis}=await fixture(t);const chmod=fs.chmod;fs.chmod=async(a,b)=>{if(String(a).endsWith('.quarantine'))throw Error('fixture chmod');return chmod(a,b)};
 try{assert.equal(await q.quarantine(analysis),null);}finally{fs.chmod=chmod;}
 const entry=q.list()[0];assert.ok(entry);assert.equal(entry.isolationStatus,'recovery-required');assert.equal(await fs.readFile(entry.quarantinePath,'utf8'),'Benign fixture');
 const reopened=new QuarantineManager(dir);await reopened.init();assert.equal(reopened.list()[0].isolationStatus,'recovery-required');
});
test('destination changed during move never confirms isolation and remains recoverable',async t=>{
 const {q,file,analysis}=await fixture(t);const rename=fs.rename;
 fs.rename=async(a,b)=>{await rename(a,b);if(a===file)await fs.writeFile(b,'Changed benign bytes')};
 try{assert.equal(await q.quarantine(analysis),null);}finally{fs.rename=rename;}
 assert.equal(q.list()[0].isolationStatus,'recovery-required');assert.ok(await fs.stat(q.list()[0].quarantinePath));
});
test('confirmation read failure preserves recovery-required metadata across restart',async t=>{
 const {q,dir,analysis}=await fixture(t);const read=fs.readFile;let failed=false;
 fs.readFile=async(a,...args)=>{if(!failed&&String(a).endsWith('manifest.json')){failed=true;throw Error('fixture read failure')}return read(a,...args)};
 try{assert.equal(await q.quarantine(analysis),null);}finally{fs.readFile=read;}
 const reopened=new QuarantineManager(dir);await reopened.init();assert.equal(reopened.list()[0].isolationStatus,'recovery-required');assert.ok(await fs.stat(reopened.list()[0].quarantinePath));
});
