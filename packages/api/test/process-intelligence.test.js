import test from 'node:test';
import assert from 'node:assert/strict';
import {hasProcessConsent,validateProcessIntelligencePayload} from '../dist/process-intelligence.js';
const entry={pid:500,name:'fixture.exe',startedAt:'2026-10-14T10:00:00.000Z',cpuPercent:0,workingSetMb:10};
const payload=()=>({version:1,measuredAt:'2026-10-14T11:00:00.000Z',ram:{totalMb:100,usedMb:50,availableMb:50},cpuPercent:0,topProcesses:[{...entry}],selectedProcess:null,trends:[],limitations:['Working Set não é memória privada.']});
test('recovered validator has bounded real contract, unknown values and explicit consent',()=>{
 assert.equal(validateProcessIntelligencePayload(payload()),true);
 assert.equal(validateProcessIntelligencePayload({...payload(),ram:{totalMb:null,usedMb:null,availableMb:null},cpuPercent:null}),true);
 assert.equal(hasProcessConsent({processConsent:true}),true);
 for(const b of [null,{},false,{processConsent:'true'}])assert.equal(hasProcessConsent(b),false);
 for(const p of [{...payload(),version:2},{...payload(),measuredAt:'yesterday'},{...payload(),cpuPercent:101},{...payload(),topProcesses:Array.from({length:6},()=>entry)},{...payload(),selectedProcess:{...entry,pid:-1}},{...payload(),limitations:Array(9).fill('x')}])assert.equal(validateProcessIntelligencePayload(p),false);
});
