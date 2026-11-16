import test from 'node:test';
import assert from 'node:assert/strict';
import * as n from '../../packages/desktop/src/nigor-status.ts';

test('Nigor process projection keeps freshness and removes command lines and private paths', () => {
  assert.equal(typeof n.projectNigorProcesses, 'function');
  const result = n.projectNigorProcesses({
    truth: { state: 'failed', enumeratedAt: 1000, servedFrom: 'cache', asOf: 2000, attempt: null },
    processes: Array.from({ length: 60 }, (_, i) => ({
      pid: i + 1, name: 'worker\nname', cpu: i === 0 ? NaN : 0,
      memoryMb: i === 0 ? -1 : 3, path: '/private/user/file',
      commandLine: '--token=secret', user: 'private-user',
    })),
  });
  assert.equal(result.version, 1);
  assert.equal(result.state, 'failed');
  assert.equal(result.servedFrom, 'cache');
  assert.equal(result.enumeratedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(result.total, 60);
  assert.equal(result.processes.length, 50);
  assert.deepEqual(result.processes[0], { pid: 1, name: 'worker name', cpuPercent: null, memoryMb: null });
  assert.equal(result.processes[1].cpuPercent, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|token/);
});

test('unknown process freshness never becomes a successful enumeration', () => {
  assert.equal(typeof n.projectNigorProcesses, 'function');
  const result = n.projectNigorProcesses({ processes: [], truth: { state: 'invented', enumeratedAt: NaN, servedFrom: 'invented' } });
  assert.equal(result.state, null);
  assert.equal(result.enumeratedAt, null);
  assert.equal(result.servedFrom, null);
});
