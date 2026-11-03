import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {UpdateJournal} from '../src/updater/install-journal.ts';
const context={confirmed:true,expectedVersion:'0.2.0',scanState:'idle',artifactPath:'C:/cache/setup.exe',manifest:{version:'0.2.0',file:{sha256:'a'.repeat(64)}}};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cs-update-journal-'));t.after(()=>{for(const f of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,f));fs.rmdirSync(dir)});return path.join(dir,'operation.json')}
test('journal refuses absent consent and competing operations; exit zero alone is not completion',t=>{
 const file=fixture(t),j=new UpdateJournal(file);assert.throws(()=>j.prepare({...context,confirmed:false}));assert.equal(fs.existsSync(file),false);
 const prepared=j.prepare(context);assert.throws(()=>j.prepare(context));j.advance(prepared.id,'shutdown');j.advance(prepared.id,'installing');j.installerExited(prepared.id,0);
 assert.equal(new UpdateJournal(file).read().stage,'awaiting-start');
 assert.equal(j.confirmStartup(prepared.id,'wrong','0.2.0',true).stage,'recovery-required');
});
test('startup confirms identity, version and ready data before completion; interruption is explicit',t=>{
 const file=fixture(t),j=new UpdateJournal(file);const p=j.prepare(context);j.advance(p.id,'shutdown');j.advance(p.id,'installing');j.installerExited(p.id,0);
 assert.equal(j.confirmStartup(p.id,p.startupToken,'0.2.0',true).stage,'completed');
 const next=j.prepare(context);j.advance(next.id,'shutdown');j.advance(next.id,'installing');assert.equal(new UpdateJournal(file).recoverInterrupted().stage,'recovery-required');
});

test('installer errors, wrong versions and unready data require recovery',t=>{
 for(const scenario of ['exit','version','data']){
 const file=fixture(t),j=new UpdateJournal(file),p=j.prepare(context);j.advance(p.id,'shutdown');j.advance(p.id,'installing');
 if(scenario==='exit'){assert.equal(j.installerExited(p.id,1603).stage,'recovery-required');}
 else{j.installerExited(p.id,0);assert.equal(j.confirmStartup(p.id,p.startupToken,scenario==='version'?'0.1.0':'0.2.0',scenario!=='data').stage,'recovery-required');}
 assert.throws(()=>j.prepare(context));
 }
});
