import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ScanManager } from '../dist/scan-manager.js';
import { pinFixture } from '../dist/fixture-pin.js';
import AdmZip from 'adm-zip';
import { ProtectionEngineService } from '../dist/engine.js';
import { scanCustomContido, installDevFixtureGate, FIXTURE_ROOT_ENV, FIXTURE_SCAN_FLAG } from '../dist/dev-fixture-gate.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cs-toctou-final-'));
  const corpus = path.join(root, 'corpus'); const inner = path.join(corpus, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  const file = path.join(inner, 'a.txt'); const bytes = 'Harmless authorized original fixture.\n'; fs.writeFileSync(file, bytes);
  const bait = path.join(root, 'bait'); fs.mkdirSync(bait); fs.writeFileSync(path.join(bait, 'a.txt'), 'Wrong replacement bytes.\n');
  const old = [process.env[FIXTURE_ROOT_ENV], process.env[FIXTURE_SCAN_FLAG]];
  process.env[FIXTURE_ROOT_ENV] = root; process.env[FIXTURE_SCAN_FLAG] = '1';
  t.after(() => { for (const [i,k] of [FIXTURE_ROOT_ENV,FIXTURE_SCAN_FLAG].entries()) { if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i]; } fs.rmSync(root,{recursive:true,force:true}); });
  return { root,corpus,inner,file,bytes,bait };
}
function mount(sm) {
  const svc={scanManager:sm,handleRequest:async r=>({ok:true,result:{id:await sm.startScan(r.payload.type,r.payload.targetPath)}})};
  installDevFixtureGate(svc,process.env,()=>{}); return svc;
}
async function finish(sm,id) {
  const end=Date.now()+12000;
  while(Date.now()<end){const s=sm.getLastScan(id);if(s && !['running','queued'].includes(s.status) && !sm.currentScanPromise)return s;await new Promise(r=>setTimeout(r,10));}
  assert.fail('Scan did not settle/release');
}
for(const attack of ['junction','file-replace','write']) {
  test(`FINAL exact last-check/handoff race: ${attack} cannot change bytes read by real Scanner`,async t=>{
    const a=setup(t);const service=new ProtectionEngineService(path.join(a.root,'state'));
    t.after(()=>service.dispose());
    let attempted=false,denied=false;const observed=[];
    const original=service.scanArtifact.bind(service);
    service.scanArtifact=async(file,source,options)=>{
      if(!attempted){attempted=true;try{
        if(attack==='junction'){fs.renameSync(a.inner,a.inner+'-old');fs.symlinkSync(a.bait,a.inner,'junction');}
        else if(attack==='file-replace'){fs.renameSync(a.file,a.file+'-old');fs.copyFileSync(path.join(a.bait,'a.txt'),a.file);}
        else fs.writeFileSync(a.file,'Wrong replacement bytes.\n');
      }catch(e){assert.ok(['EBUSY','EPERM','EACCES'].includes(e.code),e.message);denied=true;}}
      const result=await original(file,source,options);observed.push(result);return result;
    };
    const sm=new ScanManager(service);const svc=mount(sm);
    const r=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.corpus}});
    const state=await finish(sm,r.result.id);
    assert.equal(attempted,true);assert.equal(denied,true,'Windows must reject replacement BEFORE engine reopens');
    console.log(JSON.stringify({attack,attempted,denied,expectedSha256:createHash('sha256').update(a.bytes).digest('hex'),actualSha256:observed[0]?.results?.[0]?.sha256}));
    assert.equal(state.status,'completed',state.error);assert.equal(observed.length,1);
    assert.equal(observed[0].results[0].sha256,createHash('sha256').update(a.bytes).digest('hex'),'Zero wrong bytes, including first file');
    // Release must be effective, not just a counter: both file and ancestor are mutable again.
    fs.writeFileSync(a.file,'Released');fs.renameSync(a.file,a.file+'-released');fs.renameSync(a.inner,a.inner+'-released');
  });
}

test('FINAL real benign control preserves readOnly and exact SHA-256 across prefetch and per-file reopen',async t=>{
  const a=setup(t);const service=new ProtectionEngineService(path.join(a.root,'state'));t.after(()=>service.dispose());
  let readOnly;const scan=service.scanArtifact.bind(service);service.scanArtifact=async(f,s,o)=>{readOnly=o.readOnly;return scan(f,s,o);};
  const sm=new ScanManager(service);const svc=mount(sm);const r=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.file}});
  const state=await finish(sm,r.result.id);assert.equal(state.status,'completed',state.error);assert.equal(state.filesAnalyzed,1);assert.equal(readOnly,true);
  fs.writeFileSync(a.file,'Release verified');
});

test('FINAL prefetch reopens are protected and failed engine work releases the lease',async t=>{
  const a=setup(t);let attempted=false;const sm=new ScanManager({emitScanProgress(){},
    prefetchClamav:async files=>{
      attempted=true;assert.throws(()=>fs.writeFileSync(files[0],'Wrong prefetch bytes'));
      assert.equal(fs.readFileSync(files[0],'utf8'),a.bytes);
      throw Error('synthetic prefetch failure');
    },scanArtifact:async()=>assert.fail('No per-file scan after failed prefetch')});
  const svc=mount(sm);const r=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.corpus}});
  const state=await finish(sm,r.result.id);assert.equal(attempted,true);assert.equal(state.status,'failed');
  fs.writeFileSync(a.file,'Released after engine error');fs.renameSync(a.inner,a.inner+'-released');
});

test('FINAL fixture archives cannot introduce extracted paths without a validated lease',async t=>{
  const a=setup(t);fs.unlinkSync(a.file);const zip=new AdmZip();zip.addFile('entry.txt',Buffer.from('Harmless extracted fixture'));const archive=path.join(a.inner,'a.zip');zip.writeZip(archive);
  let calls=0;const sm=new ScanManager({emitScanProgress(){},scanArtifact:async()=>{calls++;return null;}});const svc=mount(sm);
  const r=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.corpus}});const state=await finish(sm,r.result.id);
  assert.equal(state.status,'failed');assert.match(state.error,/realdev_fixture_gate/);assert.equal(calls,0,'Unpinned extracted paths must never reach an engine');
  fs.writeFileSync(archive,'Released after refusal');
});

test('FINAL partial acquisition failure releases every earlier file and ancestor lock', t=>{
  const a=setup(t);const decision=scanCustomContido({type:'custom',targetPath:a.corpus},{root:a.root,real:a.root});
  assert.equal(decision.ok,true);fs.unlinkSync(a.file);
  assert.throws(()=>pinFixture(decision.snapshot),/realdev_fixture_gate/);
  fs.renameSync(a.corpus,a.corpus+'-released');
  fs.writeFileSync(path.join(a.corpus+'-released','inner','a.txt'),'Partial lease released');
});

test('FINAL lease is idempotent and rejects conflicting existing writer handles', t=>{
  const a=setup(t);const decision=scanCustomContido({type:'custom',targetPath:a.corpus},{root:a.root,real:a.root});
  const writer=fs.openSync(a.file,'r+');
  try { assert.throws(()=>pinFixture(decision.snapshot),/realdev_fixture_gate/); } finally { fs.closeSync(writer); }
  const lease=pinFixture(decision.snapshot);assert.throws(()=>fs.writeFileSync(a.file,'blocked'));
  lease.release();lease.release();fs.writeFileSync(a.file,'Released');
});

test('FINAL cancellation retains locks until in-flight engine promise settles then releases',async t=>{
  const a=setup(t);let entered,release;const started=new Promise(r=>entered=r);const hold=new Promise(r=>release=r);
  const sm=new ScanManager({emitScanProgress(){},scanArtifact:async()=>{entered();await hold;return null;}});const svc=mount(sm);
  t.after(()=>release());const r=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.corpus}});await started;
  sm.cancelScan(r.result.id);
  let denial;try{fs.writeFileSync(a.file,'Wrong during cancel');}catch(e){denial=e;}
  release();await finish(sm,r.result.id);
  assert.ok(denial,'Locks must survive published cancellation until engine returns');
  fs.writeFileSync(a.file,'Released after cancel');assert.equal(sm.getLastScan(r.result.id).status,'cancelled');
});

test('FINAL cleanup: clearClamavPrefetch failure must not strand heartbeat, maps or resolve',async t=>{
  const a=setup(t);const errors=[];const original=console.error;
  console.error=(...args)=>{errors.push(args.map(String).join(' '));};
  t.after(()=>{console.error=original;});
  const sm=new ScanManager({emitScanProgress(){},
    clearClamavPrefetch(){throw Error('synthetic prefetch cleanup failure');},
    scanArtifact:async()=>({results:[],highRiskCount:0,overallSeverity:'low'})});
  const svc=mount(sm);
  const r1=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.corpus}});
  const s1=await finish(sm,r1.result.id);
  assert.equal(s1.status,'completed',s1.error);
  assert.equal(sm.currentScanPromise,null,'the worker promise must be released even when a cleanup step throws');
  assert.ok(errors.some(l=>l.includes('clearClamavPrefetch')),`diagnostico escondido: ${JSON.stringify(errors)}`);
  const r2=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.corpus}});
  assert.ok(r2.result.id,'second scan must be admitted after a cleanup failure');
  const s2=await finish(sm,r2.result.id);assert.equal(s2.status,'completed',s2.error);
  // Real lease really released despite the failing cleanup step:
  fs.writeFileSync(a.file,'Released despite failing cleanup step');
});

test('FINAL cleanup: unconfirmed lease release stays visible and cannot strand the next scan',async t=>{
  const a=setup(t);const errors=[];const original=console.error;
  console.error=(...args)=>{errors.push(args.map(String).join(' '));};
  t.after(()=>{console.error=original;});
  let releases=0;
  const sm=new ScanManager({emitScanProgress(){},
    scanArtifact:async()=>({results:[],highRiskCount:0,overallSeverity:'low'})},undefined,{
    fixtureLeaseFactory:()=>({release(){releases++;throw Error('realdev_fixture_gate: libertação de locks não confirmada');}}),
  });
  const svc=mount(sm);
  const r1=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.corpus}});
  const s1=await finish(sm,r1.result.id);
  assert.equal(s1.status,'completed',s1.error);
  assert.equal(releases,1,'the injected lease must be the one actually used by the worker');
  assert.equal(sm.currentScanPromise,null);
  assert.ok(errors.some(l=>l.includes('releaseFixtureLease')),`lock nao libertado escondido: ${JSON.stringify(errors)}`);
  const r2=await svc.handleRequest({method:'scan.start',payload:{type:'custom',targetPath:a.corpus}});
  assert.ok(r2.result.id,'a leaked lock must not block admission of the next scan');
  const s2=await finish(sm,r2.result.id);assert.equal(s2.status,'completed',s2.error);assert.equal(releases,2);
});
