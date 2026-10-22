import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProcessIntelligencePayload, processContextForChat } from '../dist/process-intelligence.js';
const entry={pid:500,name:'chrome.exe',startedAt:'2026-10-14T10:00:00.000Z',cpuPercent:0,workingSetMb:10};
const payload=()=>({version:1,measuredAt:'2026-10-14T11:00:00.000Z',ram:{totalMb:100,usedMb:60,availableMb:40},cpuPercent:10,topProcesses:[{...entry}],selectedProcess:null,trends:[],limitations:['Working Set não é memória privada.']});
test('strict allowlist refuses private fields, invalid measurements and unbound trends',()=>{
  assert.equal(validateProcessIntelligencePayload(payload()),true);
  for(const p of [{...payload(),commandLine:'private'},{...payload(),cpuPercent:NaN},{...payload(),ram:{totalMb:100,usedMb:-1,availableMb:40}},{...payload(),topProcesses:[{...entry,path:'private'}]},{...payload(),trends:[{pid:42,startedAt:entry.startedAt,previousMb:1,currentMb:2,deltaMb:1,intervalMs:1,samples:3}]}]) assert.equal(validateProcessIntelligencePayload(p),false);
});
test('process context requires explicit consent before adding telemetry to chat',()=>{
  assert.throws(()=>processContextForChat({processIntelligence:payload()}));
  assert.throws(()=>processContextForChat({processIntelligence:payload(),processConsent:false}));
  assert.match(processContextForChat({processIntelligence:payload(),processConsent:true}),/FACTO MEDIDO/);
  assert.equal(processContextForChat({}),null);
});
