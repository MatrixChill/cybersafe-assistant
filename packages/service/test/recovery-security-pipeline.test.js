import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ProtectionEngineService} from '../dist/engine.js';
import {NativeEngineBridge} from '../dist/native-engine-bridge.js';
import {createSecurityNotifications} from '../../desktop/src/security-notifications.ts';
async function fixture(t, nativeAvailable = true){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-recovery-pipeline-'));
  const file=path.join(dir,'fixture.txt');await fs.writeFile(file,'Benign disposable fixture.');
  const e=new ProtectionEngineService(dir);await e.quarantine.init();
  e.vt.isEnabled=()=>false;e.logHistory=async()=>{};e.actionsLog.write=async()=>{};
  const original=NativeEngineBridge.scan;NativeEngineBridge.scan=async()=>nativeAvailable
    ? ({ok:true,result:{path:file,file_size:26,sha256:createHash('sha256').update('Benign disposable fixture.').digest('hex'),entropy:0,score:0,level:'safe',reasons:[],pe:{valid_pe:false,is_64:false,machine:0,sections:0,writable_executable_section:false,no_imports:false,suspicious_section:false}}})
    : ({ok:false,result:null,failure:'unavailable'});
  t.after(async()=>{NativeEngineBridge.scan=original;await e.dispose();await fs.rm(dir,{recursive:true,force:true});});
  const sha=createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const analysis={artifactPath:file,fileName:'fixture.txt',size:26,sha256:sha,verdict:'safe',severity:'low',riskScore:0,confidence:0.9,rulesTriggered:[],factors:[],recommendedAction:'allowed',scanTimestamp:new Date().toISOString()};
  e.analyzer.analyze=async()=>({...analysis,factors:[],rulesTriggered:[...analysis.rulesTriggered]});
  const events=[],toasts=[];
  const notifications=createSecurityNotifications({notificationsEnabled:()=>true,isQuitting:()=>false,notify:(title,body)=>toasts.push({title,body}),now:()=>1000});
  e.eventBus.on('event',event=>{events.push(event);notifications.handleEvent(event)});
  const critical=()=>Object.assign(analysis,{verdict:'malicious',severity:'critical',riskScore:100,confidence:0.99,recommendedAction:'quarantined',rulesTriggered:['known_bad_hash']});
  return {e,file,analysis,critical,events,toasts};
}
test('A benign analysis never produces threat or native notification',async t=>{
  const {e,file,events,toasts}=await fixture(t);const result=await e.scanArtifact(file,'service',{skipVirusTotal:true});
  assert.equal(result.results[0].verdict,'safe');assert.equal(events.some(e=>e.type==='threat.detected'),false);assert.equal(toasts.length,0);
});
test('B critical detection defaults to warning, keeps original and sends truthful notification',async t=>{
  const {e,file,critical,events,toasts}=await fixture(t);critical();await e.scanArtifact(file,'service',{skipVirusTotal:true});
  assert.equal(events.some(e=>e.type==='threat.detected'),true);assert.equal(events.some(e=>e.type==='quarantine.added'),false);
  assert.notEqual(e.threats[0].action,'quarantined');assert.ok(await fs.stat(file));assert.equal(toasts.length,1);
});
test('C explicit automatic opt-in confirms destination and manifest before success notification',async t=>{
  const {e,file,critical,events,toasts}=await fixture(t);critical();e.quarantinePolicy='automatic-high-confidence';
  await e.scanArtifact(file,'service',{skipVirusTotal:true});
  const entry=events.find(e=>e.type==='quarantine.added')?.data;assert.ok(entry?.id);assert.ok(await fs.stat(entry.quarantinePath));
  assert.ok(JSON.parse(await fs.readFile(path.join(e.baseDir,'quarantine','manifest.json'),'utf8')).some(x=>x.id===entry.id));
  await assert.rejects(fs.stat(file));assert.equal(e.threats[0].action,'quarantined');assert.ok(toasts.some(t=>/foi colocado/.test(t.body)));
  assert.ok(events.findIndex(e=>e.type==='threat.detected')<events.findIndex(e=>e.type==='quarantine.requested'));
  assert.ok(events.findIndex(e=>e.type==='quarantine.requested')<events.findIndex(e=>e.type==='quarantine.added'));
  assert.notEqual(events.find(e=>e.type==='threat.detected').data.action,'quarantined');
});
test('D null or thrown quarantine never emits success; explicit manual action reports failure',async t=>{
  const {e,file,critical,events,toasts}=await fixture(t);critical();e.quarantinePolicy='automatic-high-confidence';e.quarantine.quarantine=async()=>null;
  await e.scanArtifact(file,'service',{skipVirusTotal:true});assert.ok(events.some(e=>e.type==='quarantine.failed'));assert.equal(events.some(e=>e.type==='quarantine.added'),false);assert.notEqual(e.threats[0].action,'quarantined');
  assert.ok(toasts.some(t=>/Falha/.test(t.body)));assert.ok(await fs.stat(file));
  e.quarantine.quarantine=async()=>{throw Error('simulated IO failure')};
  const result=await e.dispatch('threat.action',{id:file,action:'quarantine',sha256:e.threats[0].sha256});assert.equal(result.success,false);assert.equal(events.some(e=>e.type==='quarantine.added'),false);
});
test('E unavailable engine stays inconclusive and never produces clean verdict',async t=>{
  const {e,file,analysis,events}=await fixture(t, false);Object.assign(analysis,{verdict:'inconclusive',confidence:0.3});
  const result=await e.scanArtifact(file,'service',{skipVirusTotal:true});assert.equal(result.results[0].verdict,'inconclusive');assert.equal(events.some(e=>e.type==='threat.detected'),false);
});
test('F OFF does not admit automatic file analysis',async t=>{
  const {e,file}=await fixture(t);let calls=0;e.scanArtifact=async()=>{calls++;return null};await e.handleFileObservation(file);assert.equal(calls,0);
});
test('G duplicate detection notification is deduplicated',async t=>{
  const {e,file,critical,toasts}=await fixture(t);critical();await e.scanArtifact(file,'service',{skipVirusTotal:true});await e.scanArtifact(file,'service',{skipVirusTotal:true});assert.equal(toasts.length,1);
});
test('warning detection cannot terminate an observed process automatically',async t=>{
  const {e,file,critical,events}=await fixture(t);critical();await e.scanArtifact(file,'service',{skipVirusTotal:true});
  let kills=0;e.runAutoKill=async()=>{kills++;return true};e.protectionState=true;e.shouldScanStartedProcess=()=>true;
  await e.handleProcessStart({pid:45555,ppid:123,name:'fixture.exe',path:file,commandLine:'',startedAt:new Date().toISOString(),cpu:0,memoryMb:1});
  assert.equal(kills,0);assert.equal(events.some(e=>e.type==='process.blocked'||e.type==='process.killed'),false);
});
test('H removal during background analysis produces no safe result, threat or quarantine',async t=>{
  const {e,file,critical,analysis,events}=await fixture(t);critical();
  e.analyzer.analyze=async()=>{await fs.unlink(file);return {...analysis,factors:[]}};
  const result=await e.scanArtifact(file,'service',{skipVirusTotal:true,backgroundSignal:new AbortController().signal});
  assert.equal(result?.results[0].verdict,'inconclusive');assert.equal(events.some(e=>e.type==='threat.detected'||e.type==='quarantine.added'),false);
});
test('real filesystem create -> NativeWindowsWatcher -> service queue -> EventBus -> notification mock',async t=>{
  const {e,critical,events,toasts}=await fixture(t);critical();
  const downloads=path.join(e.baseDir,'isolated-downloads');await fs.mkdir(downloads);
  e.bindWatchers();e.protectionState=true;
  // Only registry enumeration is stubbed; file watcher and chokidar child are real.
  e.watcher.captureRegistrySnapshot=async()=>{};
  await e.watcher.start([downloads]);
  const file=path.join(downloads,'synthetic.txt');
  const analyzed=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('file pipeline deadline')),15000);
    e.eventBus.on('event',event=>{if(event.type==='threat.detected' && event.data.filePath===file){clearTimeout(timeout);resolve(event);}});
  });
  await fs.writeFile(file,'Benign simulated detection.');await analyzed;
  assert.ok(events.some(event=>event.type==='file.created'&&event.data.path===file));
  assert.equal(toasts.length,1);assert.ok(await fs.stat(file));assert.equal(e.realtimeQueue.active<=1,true);
  assert.deepEqual(e.watcher.getMonitoredPaths(),[downloads]);
});
test('ClamAV availability loss publishes a real engine event once per change',async t=>{
  const {e,events,toasts}=await fixture(t);let status='active';Object.defineProperty(e.clamav,'health',{get:()=>({status,detail:'synthetic'})});
  e.getProtectionState();status='unavailable';e.getProtectionState();e.getProtectionState();
  assert.equal(events.filter(e=>e.type==='engine.health'&&e.data.essentialUnavailable).length,1);
  assert.ok(toasts.some(t=>/ClamAV/.test(t.body)));
});
test('event burst bounds filesystem admission as well as scan queue and reports overflow',async t=>{
  const {e,file,events}=await fixture(t);e.protectionState=true;
  const jobs=Array.from({length:1000},()=>e.handleFileObservation(file));
  assert.ok(e.fileObservationReads<=64);await Promise.all(jobs);
  const health=e.getProtectionState().engine;assert.ok(health.realtimeDroppedEvents>=936);
  assert.ok(events.some(e=>e.type==='engine.health'&&e.data.reason==='queue-overflow'));
});
test('manual authorization includes digest, refuses replacement bytes, and confirms real isolation',async t=>{
  const {e,file,critical,analysis,events}=await fixture(t);critical();await e.scanArtifact(file,'service',{skipVirusTotal:true});
  assert.equal((await e.dispatch('threat.action',{id:file,action:'quarantine'})).success,false);
  assert.equal((await e.dispatch('threat.action',{id:file,action:'quarantine',sha256:'b'.repeat(64)})).success,false);
  await fs.writeFile(file,'Replacement benign bytes');assert.equal((await e.dispatch('threat.action',{id:file,action:'quarantine',sha256:analysis.sha256})).success,false);
  assert.ok(await fs.stat(file));assert.equal(events.some(e=>e.type==='quarantine.added'),false);
  await fs.writeFile(file,'Benign disposable fixture.');
  assert.equal((await e.dispatch('threat.action',{id:file,action:'quarantine',sha256:analysis.sha256})).success,true);
  assert.equal(events.filter(e=>e.type==='quarantine.added').length,1);await assert.rejects(fs.stat(file));
});
test('manual file removed during analysis is also inconclusive',async t=>{
  const {e,file,critical,analysis,events}=await fixture(t);critical();e.analyzer.analyze=async()=>{await fs.unlink(file);return {...analysis,factors:[]}};
  const result=await e.scanArtifact(file,'system-scanner',{skipVirusTotal:true});assert.equal(result.results[0].verdict,'inconclusive');assert.equal(events.some(e=>e.type==='threat.detected'||e.type==='quarantine.added'),false);
});

for (const fail of [false,true]) test('file event during activation is '+(fail?'discarded on failure':'replayed only after confirmation'),async t=>{
  const {e,file,critical,events}=await fixture(t);critical();e.bindWatchers();
  e.updater.startScheduler=()=>{};e.processMonitor.list=async()=>[];e.hardware.getSnapshot=async()=>null;e.refreshConnections=async()=>{};
  e.watcher.start=async()=>{e.watcher.emit('file.created',{kind:'file.created',path:file,observedAt:new Date().toISOString()});assert.equal(events.some(x=>x.type==='threat.detected'),false);};
  e.processMonitor.start=async()=>{if(fail)throw Error('synthetic activation failure')};e.etwConsumer.start=async()=>{};e.wfpFilter.start=async()=>{};e.amsiProvider.start=async()=>{};
  const state=await e.startProtection();assert.equal(state.protectionEnabled,!fail);
  for(let i=0;i<20;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(events.filter(x=>x.type==='threat.detected').length,fail?0:1);
  assert.equal(e.watcher.listenerCount('file.created'),1,'temporary capture listener removed');
});
