import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNigorStatus } from '../../packages/desktop/src/nigor-status.ts';

test('v1 projects bounded diagnostics without exporting private paths or inventing measurements', () => {
  const result = projectNigorStatus({
    protection: { status: 'degraded', protectionEnabled: false, engine: { serviceRunning: true, clamav: { status: 'degraded', reason: '/private/secret' } } },
    scans: { entries: [{ status: 'completed', filesAnalyzed: 3, filesInconclusive: 1, target: '/private/secret' }] },
    events: [{ type: 'threat.detected', severity: 'high', timestamp: '2026-11-13T14:00:00Z', summary: '/private/secret' }],
    hardware: { cpu: { usage: 0 }, ram: { usagePercent: 0, usageStatus: 'available' } },
  });
  assert.equal(result.version, 1);
  assert.equal(result.protection.enabled, false);
  assert.equal(result.engines.clamav, 'degraded');
  assert.equal(result.engines.yara, null);
  assert.equal(result.history[0].filesInconclusive, 1);
  assert.equal(result.alerts[0].type, 'threat.detected');
  assert.equal(result.metrics.cpuPercent, null);
  assert.equal(result.metrics.ramPercent, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
});
