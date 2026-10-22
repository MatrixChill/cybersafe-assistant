// Same folders/options in both modes; reads only, no generated corpus.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import chokidar from 'chokidar';
const mode = process.argv[2] ?? 'inline';
const root = path.join(os.homedir(), 'Desktop');
const options = { persistent: true, ignoreInitial: true, followSymlinks: false,
  ignored: [/(^|[\/\\])\../, /node_modules/, /\.log$/, /cybersafe-assistant[\/\\]logs/, /cybersafe-(zip|scanner|temp|probe)/i],
  awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 2000 } };
const samples = [];
let running = true;
const start = performance.now();
const sampling = (async () => {
  while (running) {
    const at = performance.now();
    await fs.readdir(root);
    await fs.stat(new URL('../package.json', import.meta.url));
    samples.push(performance.now() - at);
    await new Promise(r => setTimeout(r, 50));
  }
})();
let watcher;
let timeout;
try {
  watcher = mode === 'inline' ? chokidar.watch([root], options)
    : new (await import('../packages/native-windows/dist/watcher-process.js')).IsolatedFileWatcher();
  const ready = new Promise((resolve, reject) => {
    watcher.once('ready', resolve);
    watcher.on('error', e => { if (!['EPERM','ENOENT','EACCES','EBUSY'].includes(e.code)) reject(e); });
    timeout = setTimeout(() => reject(Error('ready deadline 120s')), 120000);
  });
  if (mode !== 'inline') await watcher.start([root]);
  await ready;
  const readyMs = performance.now() - start;
  running = false; await sampling;
  const sorted = [...samples].sort((a,b)=>a-b);
  const result = { mode, root, readyMs, samples: samples.length, maxMs: Math.max(...samples),
    p95Ms: sorted[Math.floor(sorted.length * .95)], over200: samples.filter(x=>x>200).length, latenciesMs: samples };
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(timeout); running = false;
  if (watcher) await (mode === 'inline' ? watcher.close() : watcher.stop());
  await sampling;
}
