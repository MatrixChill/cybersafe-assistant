import {readdir,readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function incompleteEngines(health) {
  return ['clamav','yara','hashDb','nativeEngine'].filter(key=>health?.engine?.[key]?.status!=='active');
}

/** Only used on our generated, private synthetic corpus. Never scans user folders. */
export async function inventoryCorpus(root) {
  const files=[];
  for (const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw Error('unexpected synthetic corpus entry');
    const bytes=await readFile(path.join(root,entry.name));
    files.push({path:entry.name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  return {fileCount:files.length,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0),files};
}

export function parsePerfLogs(rows) {
  const engines = new Map();
  const summary = {
    initializationMs: null,
    phases: [],
    clamavSpawnCalls: 0,
    resources: null,
    clamavSources: {batchCache: 0, direct: 0},
    zipMs: 0,
    zipCount: 0,
    prefetchMs: null,
    batchMs: null,
    historyMs: null,
    historyCount: 0,
    perfLines: 0,
  };
  for (const row of rows) {
    const line = row.line;
    const phase = /^\[ScanPerf\] PHASE_END .*phase=(\w+) elapsedMs=(\d+)/.exec(line);
    if (phase) summary.phases.push({phase:phase[1],elapsedMs:Number(phase[2])});
    if (line.startsWith('[ScanPerf] CLAMSCAN_SPAWN_CALL_BEGIN ')) summary.clamavSpawnCalls++;
    const init = /^\[Service\] engine-init totalMs=(\d+)/.exec(line);
    if (init) summary.initializationMs = Number(init[1]);
    if (line.startsWith('[ScanPerf] RESOURCE_SUMMARY ')) {
      summary.resources = Object.fromEntries([...line.matchAll(/(elapsedMs|cpuMs|rssStartMb|rssEndMb|rssDeltaMb)=(-?\d+)/g)].map(m => [m[1],Number(m[2])]));
    }
    let m = /^\[ScanPerf\] ENGINE_PHASE engine=(\w+) elapsedMs=(\d+)/.exec(line);
    if (m) {
      summary.perfLines += 1;
      const name = m[1];
      const ms = Number(m[2]);
      const entry = engines.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, outcomes: {} };
      const outcome = / outcome=(\w+)/.exec(line)?.[1];
      if (outcome) entry.outcomes[outcome] = (entry.outcomes[outcome] ?? 0) + 1;
      if (name === 'clamav') {
        const source = / source=([\w-]+)/.exec(line)?.[1];
        if (source === 'batch-cache') summary.clamavSources.batchCache++;
        if (source === 'direct') summary.clamavSources.direct++;
      }
      entry.count += 1;
      entry.totalMs += ms;
      entry.maxMs = Math.max(entry.maxMs, ms);
      engines.set(name, entry);
      continue;
    }
    m = /^\[ScanPerf\] ZIP_PHASE .*elapsedMs=(\d+)/.exec(line);
    if (m) {
      summary.perfLines += 1;
      summary.zipMs += Number(m[1]);
      summary.zipCount += 1;
      continue;
    }
    m = /^\[ScanPerf\] prefetch end .*elapsed=(\d+)s/.exec(line);
    if (m) {
      summary.perfLines += 1;
      summary.prefetchMs = Number(m[1]) * 1000;
      continue;
    }
    m = /^\[ScanPerf\] SCANMANAGER_BATCH_END .*elapsedMs=(\d+)/.exec(line);
    if (m) {
      summary.perfLines += 1;
      summary.batchMs = Number(m[1]);
      continue;
    }
    m = /^\[ScanPerf\] HISTORY_RECORD .*elapsedMs=(\d+)/.exec(line);
    if (m) {
      summary.perfLines += 1;
      summary.historyMs = Number(m[1]);
      summary.historyCount += 1;
    }
  }
  const enginesOut = {};
  for (const [name, entry] of engines) {
    enginesOut[name] = {
      count: entry.count,
      outcomes: entry.outcomes,
      totalMs: entry.totalMs,
      avgMs: Math.round((entry.totalMs / entry.count) * 10) / 10,
      maxMs: entry.maxMs,
    };
  }
  return { engines: enginesOut, ...summary };
}


export async function waitForTerminal(manager, id, timeoutMs = 300_000) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const state = manager.getScan(id);
    if (state && ['completed','cancelled','failed'].includes(state.status)) return state;
    if (performance.now() >= deadline) {
      manager.cancelScan(id);
      throw new Error('benchmark atingiu o prazo; scan cancelado, sem resultado completo');
    }
    await new Promise(resolve => setTimeout(resolve,50));
  }
}

/** Opt-in local corpus, copied read-only from the source to the benchmark-owned base. */
export async function seedBenchmarkYara(source,baseDir) {
 const stat=await lstat(source);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>4*1024*1024)throw Error('YARA corpus must be a bounded regular file');
 const bytes=await readFile(source);
 if(bytes.length!==stat.size)throw Error('YARA corpus changed during read');
 const dir=path.join(baseDir,'definitions','yara');
 await mkdir(dir,{recursive:true});
 await writeFile(path.join(dir,'default.yar'),bytes,{flag:'wx'});
 return {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source:'explicit-local-corpus; source unchanged'};
}
