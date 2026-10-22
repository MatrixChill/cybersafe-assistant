import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScanHistory, toScanHistoryEntry } from '../dist/scan-history.js';
const state = (value) => ({ id:'synthetic-history',type:'custom',status:'completed',filesScanned:1,filesTotal:1,filesAnalyzed:1,filesExcluded:0,filesFailed:0,threatsFound:0,startTime:'2026-10-18T12:00:00Z',endTime:'2026-10-18T12:00:01Z', filesInconclusive:value });
it('contador inconclusivo inválido não se converte em zero', () => {
 for (const value of [NaN,Infinity,-1,0.5,undefined,null,'0']) assert.equal('filesInconclusive' in toScanHistoryEntry(state(value)),false, String(value));
 for (const value of [0,1,3]) assert.equal(toScanHistoryEntry(state(value)).filesInconclusive,value);
});
it('histórico real preserva ausência de medição após gravar e reabrir', async () => {
 const root = await mkdtemp(join(tmpdir(),'cybersafe-history-truth-'));
 try {
  const file=join(root,'scans.jsonl');await new ScanHistory(file).record(state(NaN));
  const page=await new ScanHistory(file).query();assert.equal(page.entries.length,1);assert.equal('filesInconclusive' in page.entries[0],false);
 } finally { await rm(root,{recursive:true,force:true}); }
});
