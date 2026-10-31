// Controlled real service-object proof. No init/watchers/network or personal files.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-classic-four-engine-proof-'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = async (file) => hash(await fs.readFile(file));
const dbSource = 'C:/Users/caioc/.cybersafe-integration/pap-integration-p0-codex-20261027/freshclam-validation/database';
process.env.NODE_ENV = 'development';
process.env.CYBERSAFE_USB_PROTECTION = '0';
process.env.CYBERSAFE_STARTUP_RESUME = '0';
process.env.CYBERSAFE_CLAMSCAN_PATH = path.join(repo, 'vendor/clamav/clamscan.exe');
for (const flag of ['CYBERSAFE_DEV_WINDOWS_READONLY', 'CYBERSAFE_REALDEV_FIXTURE_SCAN']) {
  if (process.env[flag] === '1') throw new Error(`Separate proof cannot override inherited ${flag}`);
}
const resources = path.join(root, 'resources');
const definitions = path.join(root, 'service/definitions');
await fs.mkdir(resources, { recursive: true });
for (const dir of ['yara', 'hashes', 'clamav']) await fs.mkdir(path.join(definitions, dir), { recursive: true });
const nativeSource = path.join(repo, 'packages/native-engine/build/Release/scan-engine.exe');
const expectedNative = '797c927f69ff4a75911bd472a99d75f0d83638b4b2888b31d344474d61f0d1c1';
assert.equal(await digest(nativeSource), expectedNative);
await fs.copyFile(nativeSource, path.join(resources, 'scan-engine.exe'));
process.resourcesPath = resources;
const dbDigests = {};
for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) {
  const source = path.join(dbSource, name), destination = path.join(definitions, 'clamav', name);
  const metadata = await fs.stat(source);
  await fs.copyFile(source, destination);
  // Preserve the source timestamp; this is not a fabricated refresh.
  await fs.utimes(destination, metadata.atime, metadata.mtime);
  dbDigests[name] = await digest(source);
  assert.equal(await digest(destination), dbDigests[name]);
}
const { ProtectionEngineService } = await import(pathToFileURL(path.join(repo, 'packages/service/dist/engine.js')).href);
const { NativeEngineBridge } = await import(pathToFileURL(path.join(repo, 'packages/service/dist/native-engine-bridge.js')).href);
const { BUILTIN_HASH_SIGNATURES } = await import(pathToFileURL(path.join(repo, 'packages/core/dist/signatures.js')).href);
const service = new ProtectionEngineService(path.join(root, 'service'));
let evidence;
try {
  await service.quarantine.init();
  const target = path.join(root, 'fixture.txt');
  const bytes = Buffer.from('CYBERSAFE_SAFE_SYNTHETIC_CLASSIC_AND_HASH_20261027');
  await fs.writeFile(target, bytes);
  const ruleFile = path.join(definitions, 'yara/default.yar');
  await fs.writeFile(ruleFile, 'rule SyntheticScopeProof { strings: $a = "CYBERSAFE_SAFE_SYNTHETIC_CLASSIC_AND_HASH_20261027" condition: $a }');
  const hashes = path.join(definitions, 'hashes/default.json');
  await fs.writeFile(hashes, JSON.stringify([...BUILTIN_HASH_SIGNATURES, { sha256: hash(bytes), family: 'SyntheticScopeProof', severity: 'low', source: 'local-synthetic-validation-only' }]));
  await service.signatures.load(hashes);
  await service.yara.load(ruleFile);
  assert.equal(service.signatures.match(hash(bytes)).family, 'SyntheticScopeProof');
  assert.deepEqual((await service.yara.scanFile(target)).map((x) => x.ruleId), ['SyntheticScopeProof']);
  const before = Date.now();
  assert.equal(await service.clamav.isAvailable(), true);
  const clamLoadMs = Date.now() - before;
  const response = await service.scanArtifact(target, 'service', { skipVirusTotal: true, readOnly: true });
  const result = response.results?.[0];
  assert.ok(result, 'actual service result must exist');
  assert.equal(result.nativeEngine?.status, 'completed');
  assert.equal(service.clamav.health.status, 'active');
  assert.equal(NativeEngineBridge.health.status, 'active');
  assert.equal(await digest(target), hash(bytes), 'read-only scan leaves the fixture unchanged');
  evidence = {
    observedAt: new Date().toISOString(), root, scope: 'real service object; synthetic fixture; not Electron or installed',
    resources: { nativeSha256: expectedNative, databases: dbDigests },
    yara: { health: service.yara.health, rules: service.yara.ruleCount, matchedRule: 'SyntheticScopeProof' },
    hashDb: { health: service.signatures.health, matchedFamily: 'SyntheticScopeProof', productionCoverageNotProven: true },
    clamav: { health: service.clamav.health, loadProofMs: clamLoadMs },
    native: { health: NativeEngineBridge.health, status: result.nativeEngine.status },
    verdict: result.verdict, analysisState: result.analysisState, rulesTriggered: result.rulesTriggered,
    fixtureUnchanged: true,
  };
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await service.dispose(); }
