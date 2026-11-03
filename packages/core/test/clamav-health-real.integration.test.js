import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClamavBridge, createSpawnClamav, clamavSlotStats, probeDatabaseDir } from '../dist/clamav.js';

// Opt-in: base oficial explicitamente autorizada; nunca procura ficheiros pessoais.
test('real: carga pequena preserva saúde, prioridade e ausência de filhos órfãos', {
  skip: !process.env.CYBERSAFE_CLAMAV_REAL_BASE, timeout: 120_000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-health-real-'));
  const target = path.join(root, 'benigno.txt');
  await fs.writeFile(target, 'CyberSafe: ensaio benigno de fila e saúde.');
  const realSpawn = createSpawnClamav();
  const order = [], pids = new Set();
  let live = 0, peak = 0;
  const bridge = new ClamavBridge({
    datadir: process.env.CYBERSAFE_CLAMAV_REAL_BASE, maxConcurrent: 1,
    spawn(file, args, request, hooks) {
      const handle = realSpawn(file, args, request, hooks);
      order.push(request?.scanId ?? 'background');
      if (handle.pid) pids.add(handle.pid);
      peak = Math.max(peak, ++live);
      handle.outcome.then(() => live--, () => live--);
      return handle;
    },
  });
  bridge.collectDatabaseCandidates = async () => [await probeDatabaseDir(process.env.CYBERSAFE_CLAMAV_REAL_BASE, 'explicit')];
  const wait = async fn => {
    const deadline = Date.now() + 10_000;
    while (!fn()) { assert.ok(Date.now() < deadline, 'estado de fila no prazo'); await new Promise(r => setTimeout(r, 10)); }
  };
  t.after(async () => { await bridge.dispose(); await fs.rm(root, {recursive:true,force:true}); });
  const start = Date.now();
  assert.equal(await bridge.isAvailable(), true);
  assert.equal(bridge.health.status, 'active');
  const first = bridge.scanFiles([target]);
  await wait(() => clamavSlotStats().active === 1);
  const background = bridge.scanFiles([target]);
  const user = bridge.scanFiles([target], {scanId:'controlled-user'});
  await wait(() => clamavSlotStats().waitingUser === 1 && clamavSlotStats().waitingBackground === 1);
  const health = bridge.isAvailable(true);
  assert.equal(await health, true);
  assert.equal(bridge.health.status, 'active', 'ocupação legítima não degrada');
  for (const result of await Promise.all([first, user, background])) {
    assert.equal(result.files[0].verdict, 'clean');
  }
  assert.equal(bridge.health.status, 'active');
  assert.notEqual(bridge.health.busy, true, 'carga positiva recupera a prova adiada');
  assert.equal(order[2], 'controlled-user');
  assert.equal(peak, 1);
  await bridge.dispose();
  assert.equal(bridge.liveChildPids().length, 0);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), {code:'ESRCH'}, 'o SO confirma que o filho terminou');
  console.log(JSON.stringify({scope:'3 scans benignos, não benchmark completo',elapsedMs:Date.now()-start,order,peak,orphans:0}));
});
