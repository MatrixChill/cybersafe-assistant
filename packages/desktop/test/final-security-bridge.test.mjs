import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomBytes,createHash} from 'node:crypto';import {EventEmitter} from 'node:events';
import {ProtectionEngineService} from '../../service/dist/engine.js';import {NativeEngineBridge} from '../../service/dist/native-engine-bridge.js';
import {ServiceClient} from '../src/service-client.ts';import {createSecurityNotifications} from '../src/security-notifications.ts';import {createNativeNotificationDelivery} from '../src/notification-delivery.ts';
const wait=async predicate=>{const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('isolated bridge deadline');await new Promise(r=>setTimeout(r,5));}};
for(const mode of ['confirmed','failed','notifications-off'])test('real authenticated pipe bridges '+mode+' to history and mock native Notification',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cybersafe-final-bridge-'));const targetDir=await fs.mkdtemp(path.join(os.tmpdir(),'cybersafe-final-target-'));const file=path.join(targetDir,'fixture.txt');await fs.writeFile(file,'Benign isolated fixture');
 const oldToken=process.env.CYBERSAFE_PIPE_TOKEN;const token=randomBytes(32).toString('hex');process.env.CYBERSAFE_PIPE_TOKEN=token;const engine=new ProtectionEngineService(dir);if(oldToken===undefined)delete process.env.CYBERSAFE_PIPE_TOKEN;else process.env.CYBERSAFE_PIPE_TOKEN=oldToken;
 const pipe=process.platform==='win32'?'\\\\.\\pipe\\cybersafe-final-'+randomBytes(8).toString('hex'):path.join(dir,'test.sock');const client=new ServiceClient(pipe,token);
 t.after(async()=>{client.disconnect();await engine.dispose();await fs.rm(dir,{recursive:true,force:true});await fs.rm(targetDir,{recursive:true,force:true});});
 const stored=[];engine.eventsLog.write=async value=>{stored.push(JSON.parse(value));await fs.appendFile(path.join(dir,'history.jsonl'),value+'\n');};engine.logHistory=async()=>{};engine.actionsLog.write=async()=>{};engine.vt.isEnabled=()=>false;
 engine.bindEventBus();await engine.quarantine.init();t.mock.method(NativeEngineBridge,'scan',async()=>({ok:false,result:null}));
 const sha=createHash('sha256').update(await fs.readFile(file)).digest('hex');engine.analyzer.analyze=async()=>({artifactPath:file,fileName:'fixture.txt',size:22,sha256:sha,verdict:'malicious',severity:'critical',riskScore:100,confidence:0.99,rulesTriggered:['known_bad_hash'],factors:[],recommendedAction:'quarantined',scanTimestamp:new Date().toISOString()});
 const osCalls=[],diagnostics=[],received=[];class MockNative extends EventEmitter{constructor(options){super();osCalls.push(options);}show(){this.emit('show');}}
 const delivery=createNativeNotificationDelivery({isSupported:()=>true,create:options=>new MockNative(options),notificationsEnabled:()=>mode!=='notifications-off',isQuitting:()=>false,diagnostic:status=>diagnostics.push(status)});
 const notifications=createSecurityNotifications({notify:delivery.notify,notificationsEnabled:()=>mode!=='notifications-off',isQuitting:()=>false});client.onEvent(event=>{received.push(event);notifications.handleEvent(event)});
 await engine.startPipeServer(pipe);await client.connect();
 await engine.scanArtifact(file,'service',{skipVirusTotal:true});await wait(()=>received.some(e=>e.type==='threat.detected'));
 if(mode==='notifications-off'){assert.equal(osCalls.length,0);assert.equal(diagnostics.length,0);assert.ok(engine.events.some(e=>e.type==='threat.detected'));assert.ok(stored.some(e=>e.type==='threat.detected'));return;}
 if(mode==='failed')engine.quarantine.quarantine=async()=>null;
 const result=await engine.dispatch('threat.action',{id:file,action:'quarantine',sha256:sha});assert.equal(result.success,mode==='confirmed');const terminal=mode==='confirmed'?'quarantine.added':'quarantine.failed';await wait(()=>received.some(e=>e.type===terminal));assert.ok(stored.some(e=>e.type===terminal));assert.equal(osCalls.length,2);
 assert.match(osCalls[1].body,mode==='confirmed'?/confirmada/i:/falha/i);if(mode==='failed'){assert.equal(received.some(e=>e.type==='quarantine.added'),false);assert.ok(await fs.stat(file));}else await assert.rejects(fs.stat(file));
 for(const message of osCalls)assert.doesNotMatch(message.body,/AppData|cybersafe-final-bridge|Users/);assert.ok(diagnostics.includes('accepted'));assert.doesNotMatch(JSON.stringify(received),new RegExp(token));
});
