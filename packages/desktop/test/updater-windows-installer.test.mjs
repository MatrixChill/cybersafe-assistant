import test from 'node:test';import assert from 'node:assert/strict';
import {createWindowsInstaller} from '../src/updater/windows-installer.ts';
test('default installer refuses execution before staging or shutdown',async()=>{
 const adapter=createWindowsInstaller({stagingRoot:'C:/fixture',journalFile:'C:/fixture/op.json',expectedPublisher:'CyberSafe',signatureVerifier:{verify:async()=>({ok:true})},publisherVerifier:{verify:async()=>({ok:true})},requestShutdown:async()=>{throw Error('must not shut down')}});
 const r=await adapter.install({confirmed:true,expectedVersion:'0.2.0',scanState:'idle',artifactPath:'C:/missing/setup.exe',manifest:{version:'0.2.0'}});assert.equal(r.ok,false);
});

test('denied consent and invalid manifest cannot request shutdown',async()=>{
 for(const consent of [false,true]){let shutdown=0;
 const adapter=createWindowsInstaller({stagingRoot:'C:/fixture',journalFile:'C:/fixture/op.json',expectedPublisher:'CyberSafe',authorizeExecution:()=>true,confirmConsent:async()=>consent,signatureVerifier:{verify:async()=>({ok:false})},publisherVerifier:{verify:async()=>{throw Error('must not reach publisher')}},requestShutdown:async()=>{shutdown++}});
 const context={confirmed:true,expectedVersion:'0.2.0',scanState:'idle',artifactPath:'C:/missing/setup.exe',manifest:{version:'0.2.0',signature:{value:'invalid',signedByFingerprint:'unknown'}}};
 assert.equal((await adapter.install(context)).ok,false);assert.equal(shutdown,0);
 }
});
