import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../linux-lite/arch/diagnose.mjs';

test('diagnostics separates missing commands from engine health', () => {
  const result = diagnose({ platform: 'linux', uid: 1000, session: 'wayland',
    hasCommand: (name) => name === 'clamscan' || name === 'yara' });
  assert.equal(result.launchable, true);
  assert.equal(result.clamav.commandsPresent, true);
  assert.equal(result.clamav.health, 'unknown');
  assert.equal(result.yara.commandsPresent, false);
  assert.equal(result.yara.health, 'unknown');
});

test('root and non-Linux sessions cannot pass the launcher prerequisites', () => {
  for (const [platform, uid, session] of [['linux', 0, 'x11'], ['win32', 1000, 'x11'], ['linux', 1000, null]]) {
    assert.equal(diagnose({ platform, uid, session, hasCommand: () => true }).launchable, false);
  }
});

import { assistedInstallPlan, dependencyChecks } from '../linux-lite/arch/diagnose.mjs';

const fsProbe = (dbs, extra = []) => ({
  listDir: (p) => (p === '/var/lib/clamav' ? dbs : null),
  exists: (p) => extra.includes(p),
});
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

test('dependency checks name the missing engine and give the pacman remedy', () => {
  const c = byId(dependencyChecks({ platform: 'linux', uid: 1000, session: 'x11', arch: 'x64',
    hasCommand: () => false, fsProbe: fsProbe([]) }));
  assert.equal(c.clamav.status, 'missing');
  assert.deepEqual(c.clamav.remedy.command, ['pkexec', 'pacman', '-S', '--needed', 'clamav']);
  assert.equal(c.yara.status, 'missing');
  assert.equal(c['clamav-database'].status, 'unknown', 'no databases to check without ClamAV');
});

test('installed ClamAV without official databases is distinct from not installed', () => {
  const c = byId(dependencyChecks({ platform: 'linux', uid: 1000, session: 'x11', arch: 'x64',
    hasCommand: (n) => ['clamscan', 'freshclam'].includes(n), fsProbe: fsProbe(['bytecode.cvd']) }));
  assert.equal(c.clamav.status, 'ok');
  assert.equal(c['clamav-database'].status, 'missing');
  assert.deepEqual(c['clamav-database'].remedy.command, ['pkexec', 'freshclam']);
  const ok = byId(dependencyChecks({ platform: 'linux', uid: 1000, session: 'x11', arch: 'x64',
    hasCommand: () => true, fsProbe: fsProbe(['main.cvd', 'daily.cld']) }));
  assert.equal(ok['clamav-database'].status, 'ok');
});

test('root, non-x64 and headless sessions are reported, not hidden', () => {
  const c = byId(dependencyChecks({ platform: 'linux', uid: 0, session: null, arch: 'arm64',
    hasCommand: () => true, fsProbe: fsProbe(['main.cvd', 'daily.cvd']) }));
  assert.equal(c.permissions.status, 'missing');
  assert.equal(c.architecture.status, 'missing');
  assert.equal(c.graphics.status, 'warning');
});

test('assisted install requires consent, a user session and allow-listed packages', () => {
  assert.equal(assistedInstallPlan({ packages: ['clamav'], consent: false, uid: 1000, interactive: true }).error, 'consent-required');
  assert.equal(assistedInstallPlan({ packages: ['clamav'], consent: true, uid: 0, interactive: true }).error, 'run-as-user');
  assert.equal(assistedInstallPlan({ packages: ['clamav'], consent: true, uid: 1000, interactive: false }).error, 'interactive-session-required');
  assert.equal(assistedInstallPlan({ packages: ['clamav;rm -rf /'], consent: true, uid: 1000, interactive: true }).error, 'package-not-allowed');
  const plan = assistedInstallPlan({ packages: ['clamav', 'yara', 'clamav'], consent: true, uid: 1000, interactive: true });
  assert.deepEqual(plan.argv, ['pkexec', 'pacman', '-S', '--needed', 'clamav', 'yara']);
  assert.equal(plan.argv.includes('--noconfirm'), false);
});
