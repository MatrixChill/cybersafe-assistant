import test from 'node:test';
import assert from 'node:assert/strict';
import type {EngineHealth} from '@cybersafe/shared-types';
import {engineCards} from '../src/v2/dashboard/model';
test('missing coverage metric does not claim a coverage measurement',()=>{
 const cards=engineCards({serviceRunning:true,osLayerHealthy:true,degradedReasons:[],monitoredPaths:[],clamav:{status:'active'}} satisfies EngineHealth,true);
 assert.equal(cards.find(c=>c.key==='clamav')?.coverage,'Sem métrica de cobertura');
 assert.equal(engineCards(undefined,false)[0].coverage,'Sem leitura de cobertura');
});
