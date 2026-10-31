// Real authenticated service pipe, operating exclusively on this process's synthetic fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

for (const flag of ['CYBERSAFE_DEV_WINDOWS_READONLY', 'CYBERSAFE_REALDEV_FIXTURE_SCAN']) {
  if (process.env[flag] === '1') throw new Error(`Separate proof cannot override ${flag}`);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-quarantine-pipe-proof-'));
const token = crypto.randomBytes(32).toString('hex');
process.env.CYBERSAFE_PIPE_TOKEN = token;
process.env.CYBERSAFE_USB_PROTECTION = '0';
process.env.CYBERSAFE_STARTUP_RESUME = '0';
const core = await import(pathToFileURL(path.join(repo, 'packages/core/dist/index.js')).href);
const { ProtectionEngineService } = await import(pathToFileURL(path.join(repo, 'packages/service/dist/engine.js')).href);
const service = new ProtectionEngineService(path.join(root, 'service'));
const pipe = `\\\\.\\pipe\\cs-quarantine-proof-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;

async function rpc(method, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    const clientNonce = core.generatePipeNonce();
    const id = crypto.randomUUID();
    let buffer = '';
    const timer = setTimeout(() => finish(new Error(`RPC deadline: ${method}`)), 10000);
    function finish(error, result) { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); }
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(core.encodeMessage({ type: 'auth-hello', v: core.PIPE_AUTH_VERSION, nonce: clientNonce })));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const decoded = core.decodeMessages(buffer); buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message.type === 'auth-challenge') {
          if (!core.verifyPipeProof(token, 'server', clientNonce, message.nonce, message.proof)) { finish(new Error('Server identity refused')); return; }
          socket.write(core.encodeMessage({ type: 'auth-response', v: core.PIPE_AUTH_VERSION, proof: core.makePipeProof(token, 'client', clientNonce, message.nonce) }));
        } else if (message.type === 'auth') {
          if (!message.ok) { finish(new Error('Client authentication refused')); return; }
          socket.write(core.encodeMessage({ type: 'request', id, method, payload }));
        } else if (message.type === 'response' && message.id === id) {
          finish(message.ok ? null : new Error(String(message.error)), message.result);
        }
      }
    });
  });
}

try {
  const definitions = path.join(root, 'service/definitions');
  await fs.mkdir(path.join(definitions, 'yara'), { recursive: true });
  await fs.mkdir(path.join(definitions, 'hashes'), { recursive: true });
  const target = path.join(root, 'synthetic-fixture.txt');
  const bytes = Buffer.from('CYBERSAFE_SAFE_QUARANTINE_PIPE_FIXTURE_20261027');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(target, bytes);
  const rule = path.join(definitions, 'yara/default.yar');
  await fs.writeFile(rule, 'rule SafeQuarantineScope { strings: $a = "CYBERSAFE_SAFE_QUARANTINE_PIPE_FIXTURE_20261027" condition: $a }');
  const hashFile = path.join(definitions, 'hashes/default.json');
  await fs.writeFile(hashFile, JSON.stringify([...core.BUILTIN_HASH_SIGNATURES, { sha256: digest, family: 'SyntheticQuarantineScope', severity: 'low', source: 'local-synthetic-validation' }]));
  await service.quarantine.init();
  await service.yara.load(rule);
  await service.signatures.load(hashFile);
  const detected = await service.scanArtifact(target, 'service', { readOnly: true, skipVirusTotal: true });
  assert.equal(detected.results[0].verdict, 'malicious');
  await service.startPipeServer(pipe);
  const isolated = await rpc('threat.action', { id: target, action: 'quarantine', sha256: digest });
  assert.equal(isolated.success, true);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const entries = await rpc('quarantine.list');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sha256, digest);
  assert.equal(entries[0].isolationStatus, 'confirmed');
  const reopened = new core.QuarantineManager(path.join(root, 'service'));
  await reopened.init();
  assert.equal(reopened.list()[0].sha256, digest, 'manifest survives a new manager instance');
  const restored = await rpc('quarantine.restore', { id: entries[0].id });
  assert.equal(restored.success, true);
  assert.deepEqual(await fs.readFile(target), bytes);
  const second = await rpc('threat.action', { id: target, action: 'quarantine', sha256: digest });
  assert.equal(second.success, true);
  const secondEntry = (await rpc('quarantine.list'))[0];
  const deleted = await rpc('quarantine.delete', { id: secondEntry.id });
  assert.equal(deleted.success, true);
  assert.equal((await rpc('quarantine.list')).length, 0);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const missing = await rpc('quarantine.restore', { id: secondEntry.id });
  assert.equal(missing.success, false);
  const proof = { observedAt: new Date().toISOString(), root, scope: 'authenticated real service pipe, own synthetic fixture only; not Electron UI', detection: 'malicious synthetic hash/rule', isolated: true, isolationStatus: entries[0].isolationStatus, manifestReopened: true, restoredBytesEqual: true, deleted: true, missingRestoreRefused: true };
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally { await service.dispose(); }
