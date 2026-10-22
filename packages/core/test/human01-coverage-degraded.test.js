import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineIsDegraded, deriveProtectionStatus } from '../dist/definitions.js';
const health=()=>({serviceRunning:true,osLayerHealthy:true,degradedReasons:[],monitoredPaths:[],yara:{status:'active'},hashDb:{status:'active'},clamav:{status:'active'},nativeEngine:{status:'active'},wfp:{status:'active'}});
test('rejeição de admissão degrada mesmo com quatro motores e WFP ativos',()=>{const h={...health(),realtimeDroppedEvents:10};assert.equal(engineIsDegraded(h),true);assert.notEqual(deriveProtectionStatus(true,0,engineIsDegraded(h)),'safe');});
test('sinal de watcher sem nome impede estado protegido',()=>{const h={...health(),realtimeLoss:{queueRejections:0,watcherCallbacksIndeterminate:true}};assert.equal(engineIsDegraded(h),true);});
test('sem perda conhecida não inventa degradação adicional',()=>assert.equal(engineIsDegraded({...health(),realtimeDroppedEvents:0}),false));
