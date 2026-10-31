import {test}from'node:test';import assert from'node:assert/strict';
import {apiHealthPayload}from'../src/health-payload.ts';
test('health exposes only a valid launch correlation UUID, never secrets',()=>{
 const bootId='d0c0de00-0000-4000-8000-00000000c0de';assert.deepEqual(apiHealthPayload({CYBERSAFE_API_BOOT_ID:bootId,JWT_SECRET:'SECRET_SENTINEL'}),{status:'ok',service:'cybersafe-api',bootId});
 assert.deepEqual(apiHealthPayload({CYBERSAFE_API_BOOT_ID:'SECRET_SENTINEL'}),{status:'ok',service:'cybersafe-api'});
});
