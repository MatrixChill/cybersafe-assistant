import test from 'node:test';import assert from 'node:assert/strict';
import {createWindowsPublisherVerifier} from '../src/updater/windows-publisher.ts';
test('publisher requires valid Authenticode and exact certificate identity',async()=>{
 for(const [status,type,name,expected] of [['Valid','Authenticode','CyberSafe',true],['NotSigned','None','CyberSafe',false],['Valid','Authenticode','Other',false],['UnknownError','Authenticode','CyberSafe',false]]){
  const verifier=createWindowsPublisherVerifier({platform:'win32',run:async()=>JSON.stringify({status,type,name})});
  assert.equal((await verifier.verify('C:/fixture/setup.exe','CyberSafe')).ok,expected);
 }
});
test('unavailable verifier, malformed output and execution errors fail closed',async()=>{
 for(const run of [async()=>'{',async()=>{throw Error('timeout')}])assert.equal((await createWindowsPublisherVerifier({platform:'win32',run}).verify('C:/fixture.exe','CyberSafe')).ok,false);
 assert.equal((await createWindowsPublisherVerifier({platform:'linux'}).verify('/tmp/a','CyberSafe')).ok,false);
});
