/** Real watcher -> service -> engines -> events/history; no renderer or personal profile. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.platform!=='linux'||process.getuid()===0||!process.argv.includes('--disposable-lab'))throw Error('Explicit non-root Linux lab required.');
const socket=process.argv.find(a=>a.startsWith('--socket='))?.slice(9);if(!socket)throw Error('Local clamd socket required.');
process.env.NODE_ENV='test';process.env.CYBERSAFE_CLAMAV_MODE='performance';process.env.CYBERSAFE_CLAMD_SOCKET=socket;
process.env.CYBERSAFE_DEBUG_SCAN='1';
const {ProtectionEngineService}=await import('../../packages/service/dist/engine.js');
const {NativeEngineBridge}=await import('../../packages/service/dist/native-engine-bridge.js');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'cs-realtime-lab-'));await fs.chmod(root,0o700);
const downloads=path.join(root,'Downloads'),data=path.join(root,'service');await fs.mkdir(downloads);await fs.mkdir(data);
await fs.writeFile(path.join(data,'protection-policy.json'),JSON.stringify({quarantinePolicy:'automatic-high-confidence'}),{mode:0o600});
const engine=new ProtectionEngineService(data),events=[],times=new Map();
engine.watcher.getDefaultPaths=()=>[downloads];
engine.eventBus.on('event',e=>{
 events.push(e);
 const file=e.data?.artifactPath??e.data?.filePath??e.data?.path??e.data?.originalPath;
 if(file&&times.has(file))times.get(file).events.push({type:e.type,elapsedMs:performance.now()-times.get(file).created,...(e.type==='artifact.analyzed'?{verdict:e.data.verdict,analysisState:e.data.analysisState}: {})});
});
try{
 await engine.init();await engine.clamav.isAvailable();await NativeEngineBridge.probe();
 const started=await engine.startProtection();assert.equal(started.ok,true,JSON.stringify(started));
 const count=Number(process.argv.find(a=>a.startsWith('--count='))?.slice(8)??10);
 if(!Number.isInteger(count)||count<1||count>317)throw Error('Count must be between 1 and 317.');
 const corpus=Array.from({length:count},(_,i)=>[`benign-${i}.txt`,`Benign realtime fixture ${i}\n`]);
 if(process.argv.includes('--eicar'))corpus.push(['eicar-test.txt','X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*']);
 for(const [name,bytes]of corpus){const file=path.join(downloads,name);times.set(file,{created:performance.now(),events:[]});await fs.writeFile(file,bytes);}
 const deadline=Date.now()+60_000;
 while(Date.now()<deadline){if([...times.values()].every(t=>t.events.some(e=>e.type==='artifact.analyzed')))break;await new Promise(r=>setTimeout(r,100));}
 const rows=[...times].map(([file,v])=>({fixture:path.basename(file),events:v.events}));
 assert.ok(rows.every(r=>r.events.some(e=>e.type==='artifact.analyzed')),'every new file must reach a verdict');
 if(process.argv.includes('--eicar')){
  assert.ok(events.some(e=>e.type==='threat.detected'),'real detection event required');
  assert.ok(events.some(e=>e.type==='quarantine.added'),'known EICAR hash must isolate under the explicit lab policy');
  await assert.rejects(fs.lstat(path.join(downloads,'eicar-test.txt')),{code:'ENOENT'});
 }
 await engine.dispose();
 const history=await fs.readFile(path.join(data,'history.jsonl'),'utf8');
 if(process.argv.includes('--eicar')){
  assert.ok(history.includes('threat.detected'),'persistent detection history required');
  assert.ok(history.includes('quarantine.added'),'persistent isolation history required');
 }
 const percent=(values,p)=>values.sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
 const firstVerdicts=rows.map(r=>r.events.find(e=>e.type==='artifact.analyzed'));
 const result={kind:'real service, watcher and engines; no GUI',files:rows,summary:{count:rows.length,medianVerdictMs:percent(firstVerdicts.map(e=>e.elapsedMs),.5),p95VerdictMs:percent(firstVerdicts.map(e=>e.elapsedMs),.95),inconclusive:firstVerdicts.filter(e=>e.verdict==='inconclusive').length,failed:firstVerdicts.filter(e=>e.analysisState==='failed').length},threatDetected:events.some(e=>e.type==='threat.detected'),quarantineConfirmed:events.some(e=>e.type==='quarantine.added'),historyPersisted:true};
 assert.equal(result.summary.inconclusive,0,'no initial fixture verdict may be silently inconclusive');
 assert.equal(result.summary.failed,0);
 const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);if(output)await fs.writeFile(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{await engine.dispose();/* Retain private synthetic history for inspection, never restore test detections. */}
