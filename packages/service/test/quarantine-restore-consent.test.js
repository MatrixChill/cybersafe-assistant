import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtectionEngineService } from '../dist/engine.js';

function fixture() {
  const calls = [];
  const service = Object.create(ProtectionEngineService.prototype);
  Object.assign(service, {
    quarantine: {list:()=>[{id:'entry-1',sha256:'a'.repeat(64)}],restore:async()=>{calls.push('restore');return {success:true};}},
    allowHash:async()=>calls.push('trust'),eventBus:{publish:()=>calls.push('event')},
  });
  return {service,calls};
}
test('restore never creates trust from non-boolean renderer consent', async () => {
  for (const consent of ['false','true',1,{},[],null]) {
    const {service,calls}=fixture();
    const result=await service.restoreQuarantine('entry-1',consent);
    assert.equal(result.success,false);
    assert.deepEqual(calls,[],'invalid consent must be refused before restoring');
  }
});
test('restore only adds trust after successful restore and explicit true', async () => {
  for (const consent of [false,true]) {
    const {service,calls}=fixture();
    assert.equal((await service.restoreQuarantine('entry-1',consent)).success,true);
    assert.deepEqual(calls,consent?['restore','trust','event']:['restore','event']);
  }
  const {service,calls}=fixture();
  service.quarantine.restore=async()=>({success:false,error:'controlled refusal'});
  assert.equal((await service.restoreQuarantine('entry-1',true)).success,false);
  assert.deepEqual(calls,[]);
});
