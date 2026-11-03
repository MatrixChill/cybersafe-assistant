import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {databaseReadyForUpdate} from '../src/database-update-readiness.ts';
test('real SQLite integrity/schema probe is read-only',()=>{
 const db=new Database(':memory:');try{assert.equal(databaseReadyForUpdate(db),false);for(const table of ['users','threat_events','training_results'])db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,value TEXT)`);db.prepare('INSERT INTO users(value) VALUES (?)').run('fixture preserved');const before=db.prepare('SELECT * FROM users').all();assert.equal(databaseReadyForUpdate(db),true);assert.deepEqual(db.prepare('SELECT * FROM users').all(),before);}finally{db.close()}
});
