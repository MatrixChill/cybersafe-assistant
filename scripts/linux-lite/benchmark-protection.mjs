/** Opt-in Linux lab benchmark. Creates only its own disposable corpus.
 * INSTREAM/arbiter + quarantine measurements; NOT a whole watcher/UI benchmark. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ClamavBridge } from '../../packages/core/dist/clamav.js';
import { QuarantineManager } from '../../packages/core/dist/response.js';
import AdmZip from 'adm-zip';

if(process.platform!=='linux'||process.getuid()===0||!process.argv.includes('--disposable-lab'))throw new Error('Requires Linux non-root --disposable-lab.');
const socket=process.argv.find(a=>a.startsWith('--socket='))?.slice(9);
if(!socket||!path.isAbsolute(socket))throw new Error('Explicit private clamd socket required.');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'cs-protection-benchmark-'));
await fs.chmod(root,0o700);
const percentile=(a,p)=>[...a].sort((a,b)=>a-b)[Math.max(0,Math.ceil(a.length*p)-1)];
const result={kind:'Linux lab ClamAV arbiter + quarantine (not full watcher)',createdAt:new Date().toISOString(),cold:[],warm:[],detections:[]};
const bridge=new ClamavBridge({linuxDaemonSocket:socket});
const quarantine=new QuarantineManager(root);await quarantine.init();
try {
 const cold=path.join(root,'cold.txt');await fs.writeFile(cold,'Benign CyberSafe baseline\n');
 const begin=performance.now();const c=spawn('clamscan',['--alert-exceeds-max=yes',cold]);let peak=0;
 c.stdout.resume();c.stderr.resume();
 const poll=setInterval(async()=>{try{const s=await fs.readFile(`/proc/${c.pid}/status`,'utf8');peak=Math.max(peak,Number(s.match(/^VmRSS:\s+(\d+)/m)?.[1]||0));}catch{}},50);
 const code=await new Promise((r,j)=>{c.once('error',j);c.once('close',r);});clearInterval(poll);
 result.cold.push({count:1,elapsedMs:performance.now()-begin,peakRssKb:peak,exitCode:code});
 const warmup=performance.now();await bridge.isAvailable();result.healthWarmupMs=performance.now()-warmup;
 for(const count of [1,10,100,317]){
  const files=[];for(let i=0;i<count;i++){const file=path.join(root,`benign-${count}-${i}.txt`);await fs.writeFile(file,`Benign CyberSafe fixture ${count}/${i}\n`);files.push(file);}
  const begin=performance.now(),latencies=[],queues=[],executions=[];let next=0,errors=0,detected=0;
  await Promise.all(Array.from({length:Math.min(16,count)},async()=>{while(next<files.length){const file=files[next++];const admitted=performance.now();const r=await bridge.scanFiles([file],{priority:'realtime'});latencies.push(performance.now()-begin);queues.push((admitted-begin)+(r.timing?.queueMs??0));executions.push(r.timing?.executionMs??0);errors+=r.errorCount;detected+=r.detected?1:0;}}));
  result.warm.push({count,burstConcurrency:16,totalMs:performance.now()-begin,medianLatencyMs:percentile(latencies,.5),p95LatencyMs:percentile(latencies,.95),medianQueueMs:percentile(queues,.5),p95QueueMs:percentile(queues,.95),medianExecutionMs:percentile(executions,.5),errors,detected});
 }
 if(process.argv.includes('--eicar')){
  // Standard non-executable AV test string, ONLY inside this newly created lab.
  const content=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  const zip=new AdmZip();zip.addFile('eicar.txt',content);const nested=new AdmZip();nested.addFile('inner.zip',zip.toBuffer());
  for(const [name,bytes] of [['eicar.txt',content],['eicar.zip',zip.toBuffer()],['nested.zip',nested.toBuffer()]]){
   const file=path.join(root,name);const begin=performance.now();await fs.writeFile(file,bytes);
   const scan=await bridge.scanFiles([file],{priority:'realtime'});const detectedAt=performance.now();
   let entry=null;if(scan.detected)entry=await quarantine.quarantine({artifactPath:file,fileName:name,sha256:createHash('sha256').update(bytes).digest('hex'),verdict:'malicious',riskScore:100,rulesTriggered:[scan.files[0].signature]});
   result.detections.push({format:name,verdict:scan.files[0].verdict,signature:scan.files[0].signature,detectMs:detectedAt-begin,quarantineMs:performance.now()-detectedAt,isolationStatus:entry?.isolationStatus??'not-confirmed',timing:scan.timing});
  }
 }
 const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
 if(output)await fs.writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(result,null,2));
}finally{await bridge.dispose();await fs.rm(root,{recursive:true,force:true});}
