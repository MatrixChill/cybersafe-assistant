import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectLauncher, assertRebuiltLauncher, assertExtractedLauncher, verifySetupLauncher, buildCleanLauncher } from '../windows-launcher-proof.mjs';
import { runFreezeGatedPipeline } from '../package-windows.mjs';
import { validateExactApproval } from '../source-freeze.mjs';

const wide = s => Buffer.from(s + '\0', 'utf16le');
const install = String.raw`Software\7f4c0981-4cbf-53f9-af6e-a266427c7961`;
const uninstall = String.raw`Software\Microsoft\Windows\CurrentVersion\Uninstall\7f4c0981-4cbf-53f9-af6e-a266427c7961`;
const fixture = (...strings) => {
  const header = Buffer.alloc(256);
  header.write('MZ', 0); header.writeUInt32LE(128, 0x3c); header.write('PE\0\0', 128); header.writeUInt16LE(0x8664, 132);
  return Buffer.concat([header, ...strings.map(wide)]);
};
const good = fixture('0.2.0-rc.8', install, uninstall, 'InstallLocation', 'DisplayVersion');

test('rejects old version, missing NSIS install key and invalid binary', () => {
  assert.equal(inspectLauncher(good, '0.2.0-rc.8').ok, true);
  assert.equal(inspectLauncher(fixture('0.2.0-rc.6', uninstall, 'InstallLocation', 'DisplayVersion'), '0.2.0-rc.8').ok, false);
  assert.equal(inspectLauncher(Buffer.from('not a launcher'), '0.2.0-rc.8').ok, false);
  const wrongArch = Buffer.from(good); wrongArch.writeUInt16LE(0x14c, 132);
  assert.equal(inspectLauncher(wrongArch, '0.2.0-rc.8').ok, false);
});

test('a stale launcher is refused even if its displayed metadata matches', () => {
  assert.doesNotThrow(() => assertRebuiltLauncher(good, Buffer.from(good)));
  assert.throws(() => assertRebuiltLauncher(good, Buffer.concat([good, Buffer.from('changed source')])), /launcher.*rebuild/i);
});

test('a real stale launcher is rejected against a clean current rebuild', {skip:process.platform !== 'win32' || !fs.existsSync('output/rc8-independent-verification/payload/resources/cybersafe-update-launcher.exe'), timeout:90000}, () => {
  const old = fs.readFileSync('output/rc8-independent-verification/payload/resources/cybersafe-update-launcher.exe');
  const rebuilt = buildCleanLauncher();
  assert.throws(() => assertRebuiltLauncher(old, rebuilt.bytes), /launcher.*rebuild/i);
});

test('freeze refuses an approval for different bytes or Git identity', () => {
  const identity = {head:'a'.repeat(40), gitTree:'b'.repeat(40), digest:'c'.repeat(64), entries:2011};
  assert.deepEqual(validateExactApproval(identity, identity), []);
  for (const key of Object.keys(identity)) assert.notDeepEqual(validateExactApproval({...identity, [key]:'wrong'}, identity), []);
});

test('freeze verifies recorded Git identity as well as source hashes', () => {
  const source = fs.readFileSync(new URL('../source-freeze.mjs', import.meta.url), 'utf8');
  const verification = source.slice(source.indexOf('export function verifySourceFreeze'), source.indexOf('const usage ='));
  assert.ok(verification.includes('validateExactApproval(manifest.approval, actual)'));
});

test('package pipeline verifies clean build and extracted installer before promotion', () => {
  const packageScript = fs.readFileSync(new URL('../package-windows.mjs', import.meta.url), 'utf8');
  assert.match(packageScript, /verifyCleanLauncher\(\)/);
  assert.match(packageScript, /verifySetupLauncher\(/);
});

test('a failed payload check prevents promotion', () => {
  const calls = [];
  assert.throws(() => runFreezeGatedPipeline({verify:()=>({ok:true}), stages:{workspaces:()=>calls.push('workspaces'), builder:()=>{calls.push('builder');assertExtractedLauncher(good, Buffer.from('old'));}, promote:()=>calls.push('promote')}}), /launcher.*payload/i);
  assert.deepEqual(calls, ['workspaces','builder']);
});

test('two clean native builds are byte-identical and carry the expected identity', {skip:process.platform !== 'win32', timeout:180000}, () => {
  const first = buildCleanLauncher();
  const second = buildCleanLauncher();
  assertRebuiltLauncher(first.bytes, second.bytes);
  assert.equal(inspectLauncher(first.bytes, first.version).ok, true);
});

test('changed C++ source invalidates a previously built launcher', {skip:process.platform !== 'win32', timeout:180000}, () => {
  fs.mkdirSync('output', {recursive:true});
  const fixture = fs.mkdtempSync(path.resolve('output/launcher-source-fixture-'));
  const copy = (src, dst) => { fs.mkdirSync(path.dirname(dst), {recursive:true}); fs.cpSync(src, dst, {recursive:true}); };
  copy('packages/native-engine/CMakeLists.txt', path.join(fixture, 'packages/native-engine/CMakeLists.txt'));
  copy('packages/native-engine/src', path.join(fixture, 'packages/native-engine/src'));
  copy('packages/native-engine/third-party/monocypher', path.join(fixture, 'packages/native-engine/third-party/monocypher'));
  copy('packages/desktop/src/updater/windows-handoff-script.ts', path.join(fixture, 'packages/desktop/src/updater/windows-handoff-script.ts'));
  copy('scripts/generate-update-launcher-program.mjs', path.join(fixture, 'scripts/generate-update-launcher-program.mjs'));
  copy('product-version.json', path.join(fixture, 'product-version.json'));
  const original = buildCleanLauncher({repo:fixture});
  const source = path.join(fixture, 'packages/native-engine/src/preview-parent.h');
  const before = fs.readFileSync(source, 'utf8');
  const after = before.replace('CyberSafe Assistant.exe', 'CyberSafe Mutation.exe');
  assert.notEqual(before, after);
  fs.writeFileSync(source, after);
  const changed = buildCleanLauncher({repo:fixture});
  assert.throws(() => assertRebuiltLauncher(original.bytes, changed.bytes), /launcher.*rebuild/i);
});

test('actual rejected RC8 Setup contains the old launcher, not the corrected build', { skip: process.platform !== 'win32' || !fs.existsSync('output/rc8-independent-verification/payload/resources/cybersafe-update-launcher.exe') || !fs.existsSync('packages/desktop/release/candidate-20261104-215211-87c3aaf9/CyberSafe Assistant-0.2.0-rc.8-candidate-20261104-215211-87c3aaf9-setup.exe') }, () => {
  const old = fs.readFileSync('output/rc8-independent-verification/payload/resources/cybersafe-update-launcher.exe');
  const setup = path.resolve('packages/desktop/release/candidate-20261104-215211-87c3aaf9/CyberSafe Assistant-0.2.0-rc.8-candidate-20261104-215211-87c3aaf9-setup.exe');
  assert.equal(inspectLauncher(old, '0.2.0-rc.8').ok, false);
  assert.doesNotThrow(() => verifySetupLauncher(setup, old));
  assert.throws(() => verifySetupLauncher(setup, good), /launcher.*payload/i);
});

test('packaged launcher must be byte-identical to the frozen input', () => {
  assert.doesNotThrow(() => assertExtractedLauncher(good, Buffer.from(good)));
  assert.throws(() => assertExtractedLauncher(good, Buffer.from('different')), /launcher.*payload/i);
  assert.throws(() => assertExtractedLauncher(good, Buffer.alloc(0)), /launcher.*payload/i);
});
