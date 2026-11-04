import test from 'node:test';import assert from 'node:assert/strict';
import {createWindowsInstaller,createPreviewWindowsInstaller} from '../src/updater/windows-installer.ts';

test('Preview requires an idle service lease before staging and releases it on failure',async()=>{
  for (const granted of [false,true]) {
    const reached=[];
    const adapter=createPreviewWindowsInstaller({
      stagingRoot:'C:/fixture',journalFile:'C:/fixture/op.json',authorizeExecution:()=>true,
      confirmConsent:async()=>true,signatureVerifier:{verify:async()=>({ok:true})},
      acquireScanLease:async()=>{reached.push('lease');return granted?{renew:async()=>true,release:async()=>{reached.push('release')}}:null;},
      requestShutdown:async()=>{reached.push('shutdown');},
    });
    const result=await adapter.install({confirmed:true,scanState:'idle',expectedVersion:'0.2.0-rc.6',
      artifactPath:'C:/missing/setup.exe',manifest:{channel:'preview',version:'0.2.0-rc.6',
      file:{sizeBytes:1},signature:{value:'invalid',signedByFingerprint:'unknown'}}});
    assert.equal(result.ok,false);
    if(process.platform==='win32') assert.deepEqual(reached,granted?['lease','release']:['lease']);
  }
});
test('default installer refuses execution before staging or shutdown',async()=>{
 const events=[];
 const adapter=createWindowsInstaller({stagingRoot:'C:/fixture',journalFile:'C:/fixture/op.json',expectedPublisher:'CyberSafe',signatureVerifier:{verify:async()=>({ok:true})},publisherVerifier:{verify:async()=>({ok:true})},requestShutdown:async()=>{throw Error('must not shut down')},onDiagnostic:(event,details)=>events.push({event,details})});
 const r=await adapter.install({confirmed:true,expectedVersion:'0.2.0',scanState:'idle',artifactPath:'C:/missing/setup.exe',manifest:{version:'0.2.0'}});assert.equal(r.ok,false);
 assert.equal(events.length,1);assert.equal(events[0].event,'updater-handoff-failed');
 assert.ok(['windows-required','execution-not-authorized'].includes(events[0].details.reasonCode));
 assert.equal(JSON.stringify(events).includes('C:/fixture'),false,'diagnósticos não incluem caminhos locais');
});

test('denied consent and invalid manifest cannot request shutdown',async()=>{
 for(const consent of [false,true]){let shutdown=0;
 const adapter=createWindowsInstaller({stagingRoot:'C:/fixture',journalFile:'C:/fixture/op.json',expectedPublisher:'CyberSafe',authorizeExecution:()=>true,confirmConsent:async()=>consent,signatureVerifier:{verify:async()=>({ok:false})},publisherVerifier:{verify:async()=>{throw Error('must not reach publisher')}},requestShutdown:async()=>{shutdown++}});
 const context={confirmed:true,expectedVersion:'0.2.0',scanState:'idle',artifactPath:'C:/missing/setup.exe',manifest:{channel:'stable',version:'0.2.0',signature:{value:'invalid',signedByFingerprint:'unknown'}}};
 assert.equal((await adapter.install(context)).ok,false);assert.equal(shutdown,0);
 }
});

test('Stable adapter refuses Preview before consent, publisher checks or shutdown', async () => {
  const reached = [];
  const adapter = createWindowsInstaller({
    stagingRoot: 'C:/fixture', journalFile: 'C:/fixture/op.json', expectedPublisher: 'CyberSafe',
    authorizeExecution: () => true,
    confirmConsent: async () => { reached.push('consent'); return true; },
    signatureVerifier: {verify: async () => { reached.push('signature'); return {ok:true}; }},
    publisherVerifier: {verify: async () => { reached.push('publisher'); return {ok:true}; }},
    requestShutdown: async () => { reached.push('shutdown'); },
  });
  const result = await adapter.install({confirmed:true, scanState:'idle', expectedVersion:'0.2.0-rc.6',
    manifest:{channel:'preview', version:'0.2.0-rc.6'}});
  assert.equal(result.ok,false);
  assert.deepEqual(reached,[]);
  if (process.platform === 'win32') assert.match(result.message,/non-Stable/);
});
