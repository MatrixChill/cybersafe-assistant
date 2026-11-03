import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {ScanManager} from '../dist/scan-manager.js';

test('one outer batch covers regular files and ZIP while inner contents still reach all engines',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'cs-mixed-batch-'));
 const batches=[], analyzed=[];
 const engine={
  prefetchClamav:async files=>{batches.push([...files]);return {spawned:true,files:files.length};},
  clearClamavPrefetch:()=>{},
  scanArtifact:async file=>{analyzed.push(file);return {highRiskCount:0,overallSeverity:'safe'};},
  emitScanProgress:()=>{},
 };
 try {
  const plain=path.join(root,'plain.txt'),archive=path.join(root,'archive.zip');
  await writeFile(plain,'benign');
  const zip=new AdmZip();zip.addFile('inside.txt',Buffer.from('benign inside'));zip.writeZip(archive);
  const manager=new ScanManager(engine);
  const id=await manager.startScan('custom',root);
  const deadline=Date.now()+5000;
  while(manager.getScan(id)?.status==='running' && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  assert.equal(manager.getScan(id)?.status,'completed');
  assert.deepEqual([...batches[0]].sort(),[plain,archive].sort());
  assert.equal(batches.length,2,'outer batch plus extracted-content batch');
  assert.ok(analyzed.includes(plain));assert.ok(analyzed.includes(archive));
  assert.ok(analyzed.some(file=>path.basename(file)==='inside.txt'));
 }finally{await rm(root,{recursive:true,force:true});}
});
