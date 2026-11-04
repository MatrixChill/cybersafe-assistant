import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './source-freeze.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const launcherPath = path.join(root, 'packages/native-engine/build/Release/cybersafe-update-launcher.exe');
const installKey = String.raw`Software\7f4c0981-4cbf-53f9-af6e-a266427c7961`;
const uninstallKey = String.raw`Software\Microsoft\Windows\CurrentVersion\Uninstall\7f4c0981-4cbf-53f9-af6e-a266427c7961`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wide = text => Buffer.from(text + '\0', 'utf16le');

// Strings are supplementary diagnostics, not a proof of behaviour or origin.
// That proof requires a fresh build compared byte-for-byte plus the LAB tests.
export function inspectLauncher(bytes, version) {
  const required = [version, installKey, uninstallKey, 'InstallLocation', 'DisplayVersion'];
  const missing = required.filter(s => !s || bytes.indexOf(wide(s)) < 0);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0;
  const x64 = bytes.length >= pe + 6 && pe >= 64 && bytes.subarray(pe, pe + 4).equals(Buffer.from([80, 69, 0, 0])) && bytes.readUInt16LE(pe + 4) === 0x8664;
  if (bytes.length < 64 || bytes[0] !== 77 || bytes[1] !== 90 || !x64) missing.push('invalid PE x64');
  return { ok: missing.length === 0, missing, sha256: hash(bytes) };
}
export function assertRebuiltLauncher(actual, rebuilt) {
  if (!actual.length || !rebuilt.length || !actual.equals(rebuilt)) throw new Error('launcher differs from clean rebuild; refusing packaging');
}
export function assertExtractedLauncher(approved, extracted) {
  if (!approved.length || !extracted.length || !approved.equals(extracted)) throw new Error('launcher payload differs from frozen input');
}

// Fresh directories, same checkout/toolchain and release flags. /Brepro is
// undocumented by Microsoft: verify equality every time and fail closed.
export function buildCleanLauncher({ repo = root } = {}) {
  if (process.platform !== 'win32') throw new Error('launcher proof requires Windows MSVC');
  const parent = path.join(repo, 'output', 'launcher-proof-builds');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'build-'));
  const source = path.join(repo, 'packages/native-engine');
  const options = [
    '-DCMAKE_CXX_FLAGS_RELEASE=/O2 /Ob2 /DNDEBUG /Brepro',
    '-DCMAKE_C_FLAGS_RELEASE=/O2 /Ob2 /DNDEBUG /Brepro',
    '-DCMAKE_EXE_LINKER_FLAGS=/Brepro',
  ];
  const log = path.join(dir, 'build.log');
  const run = args => {
    const result = spawnSync('cmake', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    fs.appendFileSync(log, `\n$ cmake ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (result.error || result.status !== 0) throw new Error(`clean launcher build failed: ${result.error?.message ?? result.status}; ${log}`);
  };
  run(['-S', source, '-B', dir, ...options]);
  run(['--build', dir, '--config', 'Release', '--target', 'cybersafe-update-launcher']);
  const binary = path.join(dir, 'Release', 'cybersafe-update-launcher.exe');
  const bytes = fs.readFileSync(binary);
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'product-version.json'), 'utf8')).version;
  const inspection = inspectLauncher(bytes, version);
  if (!inspection.ok) throw new Error(`launcher identity or NSIS contract missing: ${inspection.missing.join(', ')}`);
  return { binary, bytes, version, sha256: inspection.sha256, log };
}

export function verifyCleanLauncher() {
  const current = fs.readFileSync(launcherPath);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'product-version.json'), 'utf8')).version;
  const inspection = inspectLauncher(current, version);
  if (!inspection.ok) throw new Error(`launcher identity or NSIS contract missing: ${inspection.missing.join(', ')}`);
  // Snapshot every frozen input before/after the build. A source edit during
  // compilation must not be accepted even when the new binary is identical.
  const before = buildManifest({ approval: null }).digest;
  const rebuilt = buildCleanLauncher();
  const after = buildManifest({ approval: null }).digest;
  if (before !== after) throw new Error('frozen inputs changed during launcher rebuild');
  assertRebuiltLauncher(current, rebuilt.bytes);
  assertRebuiltLauncher(fs.readFileSync(launcherPath), rebuilt.bytes);
  return rebuilt;
}

export function verifySetupLauncher(setup, approvedBytes) {
  const seven = requireSevenZip();
  const result = spawnSync(seven, ['x', '-so', setup, 'resources/cybersafe-update-launcher.exe'], { cwd: root, windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`launcher payload extraction failed: ${result.error?.message ?? result.status} ${String(result.stderr ?? '').slice(0, 400)}`);
  assertExtractedLauncher(approvedBytes, result.stdout);
}
function requireSevenZip() {
  // Already a transitive dependency of electron-builder; no new dependency.
  return execFileSync(process.execPath, ['-p', "require('7zip-bin').path7za"], { cwd: root, encoding: 'utf8' }).trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === '--prepare') {
      const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
      if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('tracked worktree must be clean before preparing launcher');
      const head = git('rev-parse', 'HEAD');
      const gitTree = git('rev-parse', 'HEAD^{tree}');
      const priorDigest = buildManifest({ approval: null }).digest;
      const first = buildCleanLauncher(), second = buildCleanLauncher();
      if (priorDigest !== buildManifest({ approval: null }).digest) throw new Error('frozen inputs changed during launcher preparation');
      if (head !== git('rev-parse', 'HEAD') || gitTree !== git('rev-parse', 'HEAD^{tree}') || git('status', '--porcelain', '--untracked-files=no')) throw new Error('source changed during launcher preparation');
      assertRebuiltLauncher(first.bytes, second.bytes);
      // Preserve the previous frozen input; preparation never writes approval.
      fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
      const prior = fs.readFileSync(launcherPath);
      const backup = path.join(path.dirname(first.binary), 'previous-launcher.exe');
      fs.writeFileSync(backup, prior, { flag: 'wx' });
      // Stage the candidate as the next freeze input, after preserving the old
      // bytes. This invalidates the old freeze and never writes an approval.
      fs.copyFileSync(first.binary, launcherPath);
      assertRebuiltLauncher(fs.readFileSync(launcherPath), second.bytes);
      console.log(JSON.stringify({ status: 'PREPARED_NOT_APPROVED', head, gitTree, version: first.version, sha256: first.sha256, candidate: first.binary, currentInput: launcherPath, previousSha256: hash(prior), previousBackup: backup, builds: [first.log, second.log] }, null, 2));
    } else if (command === '--verify') {
      const result = verifyCleanLauncher();
      console.log(JSON.stringify({ status: 'PASS', version: result.version, sha256: result.sha256, buildLog: result.log }, null, 2));
    } else {
      throw new Error('Usage: node scripts/windows-launcher-proof.mjs --prepare | --verify');
    }
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
