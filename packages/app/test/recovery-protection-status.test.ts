import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveProtectionLevel} from '../src/lib/protectionHealth.ts';
test('healthy service and engines do not prove realtime monitoring is enabled',()=>{
  const e={serviceRunning:true,anyEngineDegraded:false} as any;
  assert.notEqual(deriveProtectionLevel('safe',e,{enabled:false}), 'protected');
  assert.notEqual(deriveProtectionLevel('safe',e,{}), 'protected');
  assert.notEqual(deriveProtectionLevel('safe',e,{enabled:true,pausedUntil:'2026-10-14T14:00:00Z'}), 'protected');
  assert.equal(deriveProtectionLevel('safe',e,{enabled:true}), 'protected');
});
