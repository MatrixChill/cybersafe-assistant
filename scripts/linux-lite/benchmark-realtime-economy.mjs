/** Lab-only: real watcher -> queue -> engines -> verdicts, ClamAV ECONOMY mode (clamscan, no clamd).
 * Disposable corpus under a fresh 0700 temp dir; no personal profile. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
if (process.platform !== 'linux' || process.getuid() === 0 || !process.argv.includes('--disposable-lab')) throw Error('lab only');
process.env.NODE_ENV = 'test'; delete process.env.CYBERSAFE_CLAMAV_MODE; delete process.env.CYBERSAFE_CLAMD_SOCKET;
const { ProtectionEngineService } = await import(new URL('../../packages/service/dist/engine.js', import.meta.url).href);
const { NativeEngineBridge } = await import(new URL('../../packages/service/dist/native-engine-bridge.js', import.meta.url).href);
const count = Number(process.argv.find(a => a.startsWith('--count='))?.slice(8) ?? 40);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-bench-eco-')); await fs.chmod(root, 0o700);
const downloads = path.join(root, 'Downloads'), data = path.join(root, 'service');
await fs.mkdir(downloads); await fs.mkdir(data);
const engine = new ProtectionEngineService(data);
engine.watcher.getDefaultPaths = () => [downloads];
const created = new Map(), done = new Map();
let peakRss = 0;
const rssPoll = setInterval(async () => {
  try {
    for (const pid of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      const cmd = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      const argv0 = cmd.split('\0')[0];
      if (!(argv0 === 'clamscan' || argv0.endsWith('/clamscan'))) continue;
      const st = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
      peakRss = Math.max(peakRss, Number(st.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0));
    }
  } catch {}
}, 100);
let clamscanSpawns = 0;
engine.eventBus.on('event', e => {
  const f = e.data?.artifactPath ?? e.data?.filePath ?? e.data?.path;
  if (e.type === 'artifact.analyzed' && f && created.has(f) && !done.has(f)) done.set(f, { ms: performance.now() - created.get(f), verdict: e.data.verdict, state: e.data.analysisState });
});
try {
  await engine.init(); await engine.clamav.isAvailable(); await NativeEngineBridge.probe();
  const started = await engine.startProtection(); if (!started.ok) throw Error(JSON.stringify(started));
  await new Promise(r => setTimeout(r, 2000));
  const t0 = performance.now();
  for (let i = 0; i < count; i++) { const f = path.join(downloads, `benign-${i}.txt`); created.set(f, performance.now()); await fs.writeFile(f, `Benign economy fixture ${i}\n`); }
  const deadline = Date.now() + 20 * 60_000;
  while (done.size < count && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
  const lat = [...done.values()].map(v => v.ms).sort((a, b) => a - b);
  const q = p => lat[Math.max(0, Math.ceil(lat.length * p) - 1)];
  const verdicts = {}; for (const v of done.values()) verdicts[`${v.verdict}/${v.state}`] = (verdicts[`${v.verdict}/${v.state}`] ?? 0) + 1;
  console.log(JSON.stringify({ mode: 'economy(clamscan)', count, completed: done.size, totalMs: Math.round(performance.now() - t0), medianMs: Math.round(q(.5)), p95Ms: Math.round(q(.95)), maxMs: Math.round(lat.at(-1)), peakClamscanRssKb: peakRss, verdicts }));
} finally {
  clearInterval(rssPoll);
  await engine.stopProtection?.().catch(() => {}); await engine.dispose?.().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
