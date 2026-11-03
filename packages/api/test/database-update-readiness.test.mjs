import test from 'node:test';import assert from 'node:assert/strict';
import {databaseReadyForUpdate} from '../src/database-update-readiness.ts';
test('update readiness requires SQLite integrity and the persisted core schema',()=>{
 const tables=['users','threat_events','training_results'].map(name=>({name}));
 const db={pragma:()=> 'ok',prepare:()=>({all:()=>tables})};assert.equal(databaseReadyForUpdate(db),true);
 assert.equal(databaseReadyForUpdate({...db,pragma:()=> 'corrupt'}),false);
 assert.equal(databaseReadyForUpdate({...db,prepare:()=>({all:()=>[{name:'users'}]})}),false);
 assert.equal(databaseReadyForUpdate({...db,pragma:()=>{throw Error('migration unavailable')}}),false);
});
