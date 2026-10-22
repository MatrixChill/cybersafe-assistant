import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveEventRefresh} from '../src/lib/processActions.ts';
test('file observation and analysis events update history without seven-subsystem snapshots',()=>{
 for(const event of ['file.created','file.modified','file.deleted','file.renamed','artifact.analyzed','quarantine.requested'])assert.equal(resolveEventRefresh(event),'none',event);
 for(const event of ['threat.detected','quarantine.added','quarantine.failed','engine.health','protection.changed'])assert.equal(resolveEventRefresh(event),'snapshot',event);
});
