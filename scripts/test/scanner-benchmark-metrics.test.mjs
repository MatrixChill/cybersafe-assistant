import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePerfLogs} from '../scanner-benchmark-metrics.mjs';
test('reports measured init, resources and cache sources without manufacturing missing metrics',()=>{
 const rows=['[Service] engine-init totalMs=120','[ScanPerf] RESOURCE_SUMMARY elapsedMs=200 cpuMs=40 rssStartMb=30 rssEndMb=32 rssDeltaMb=2','[ScanPerf] ENGINE_PHASE engine=clamav elapsedMs=3 source=batch-cache outcome=clean','[ScanPerf] ENGINE_PHASE engine=clamav elapsedMs=9 source=direct outcome=timeout'].map(line=>({line}));
 const result=parsePerfLogs(rows);
 assert.equal(result.initializationMs,120);
 assert.equal(result.resources.cpuMs,40);
 assert.deepEqual(result.clamavSources,{batchCache:1,direct:1});
 assert.equal(result.engines.clamav.totalMs,12);
 assert.equal(result.engines.clamav.outcomes.timeout,1);
 assert.equal(parsePerfLogs([]).resources,null);
 assert.equal(parsePerfLogs([]).initializationMs,null);
});

test('deadline cancels the owned scan and never returns a running success',async()=>{
 const {waitForTerminal}=await import('../scanner-benchmark-metrics.mjs');
 let cancelled=false;
 await assert.rejects(()=>waitForTerminal({getScan:()=>({status:'running'}),cancelScan:id=>{assert.equal(id,'own');cancelled=true;}},'own',0),/prazo/);
 assert.equal(cancelled,true);
 const state={status:'completed',filesScanned:2};
 assert.equal(await waitForTerminal({getScan:()=>state},'own',100),state);
});

test('retains every batch/phase and counts actual spawn calls without calling them total child CPU',()=>{
 const result=parsePerfLogs(['[ScanPerf] PHASE_END scanId=x phase=gathering elapsedMs=12 selected=40','[ScanPerf] PHASE_END scanId=x phase=batch elapsedMs=23 candidates=40','[ScanPerf] CLAMSCAN_SPAWN_CALL_BEGIN scanId=x argCount=4','[ScanPerf] CLAMSCAN_SPAWN_CALL_BEGIN scanId=x argCount=4'].map(line=>({line})));
 assert.deepEqual(result.phases,[{phase:'gathering',elapsedMs:12},{phase:'batch',elapsedMs:23}]);
 assert.equal(result.clamavSpawnCalls,2);
});
