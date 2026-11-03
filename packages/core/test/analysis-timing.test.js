import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MalwareAnalyzer } from '../dist/analysis.js';

test('opt-in engine phase timings are numeric, path-free and verdict-neutral', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-timing-private-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'private-benign.txt'); await fs.writeFile(file,'benign');
 const analyzer=new MalwareAnalyzer({signatures:{match:()=>undefined},trust:{evaluate:()=>({decision:'unknown'})},yara:{scanFile:async()=>[]},clamav:{scanFile:async()=>({verdict:'clean',detected:false})}});
 const old=process.env.CYBERSAFE_DEBUG_SCAN, log=console.log, rows=[];
 console.log=(...args)=>rows.push(args.join(' '));
 try {
  process.env.CYBERSAFE_DEBUG_SCAN='0'; const before=await analyzer.analyze(file); assert.equal(rows.length,0);
  process.env.CYBERSAFE_DEBUG_SCAN='1'; const after=await analyzer.analyze(file); assert.equal(after.verdict,before.verdict);
  for(const phase of ['yara','clamav','hashdb']) assert.ok(rows.some(r=>new RegExp(`^\\[ScanPerf\\] ENGINE_PHASE engine=${phase} elapsedMs=\\d+`).test(r)),phase);
  assert.doesNotMatch(rows.join('\n'),/private-benign|cs-timing-private|[A-Z]:\\/);
 } finally {console.log=log;if(old===undefined)delete process.env.CYBERSAFE_DEBUG_SCAN;else process.env.CYBERSAFE_DEBUG_SCAN=old;}
});
