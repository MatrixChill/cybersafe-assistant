import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MalwareAnalyzer,SignatureDatabase,TrustEngine,YaraEngine} from '../dist/index.js';
test('missing engine, unknown result and explicit failure cannot produce safe',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-recovery-verdict-'));const file=path.join(dir,'fixture.txt');await fs.writeFile(file,'Benign disposable fixture.');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const clamav of [undefined,{scanFile:async()=>({detected:false})},{scanFile:async()=>({detected:false,verdict:'error'})}]){
   const a=new MalwareAnalyzer({clamav,signatures:new SignatureDatabase(),trust:new TrustEngine(),yara:new YaraEngine()});
   const result=await a.analyze(file);assert.equal(result.verdict,'inconclusive');assert.ok(result.confidence<=0.3);
 }
});
test('large-file resource limit is inconclusive, while a measured known hash still detects',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-recovery-large-'));const file=path.join(dir,'fixture.bin');
 await fs.writeFile(file,'benign');await fs.truncate(file,101*1024*1024);t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let known=false,calls=0;
 const a=new MalwareAnalyzer({signatures:{match:()=>known?{source:'synthetic-test'}:undefined},trust:new TrustEngine(),yara:new YaraEngine(),clamav:{scanFile:async()=>{calls++;return {verdict:'clean',detected:false}}}});
 const skipped=await a.analyze(file);assert.equal(skipped.verdict,'inconclusive');assert.ok(skipped.confidence<=0.3);assert.equal(calls,0);
 assert.ok(skipped.rulesTriggered.includes('scan_inconclusive'));
 known=true;const detected=await a.analyze(file);assert.equal(detected.verdict,'malicious');assert.ok(detected.rulesTriggered.includes('known_bad_hash'));
});
