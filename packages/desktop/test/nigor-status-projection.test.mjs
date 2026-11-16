import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNigorStatus } from '../src/nigor-status.ts';

const base = (events, engine = {}) => ({
  protection: {
    status: 'degraded', protectionEnabled: true,
    engine: { serviceRunning: true, clamav: { status: 'unavailable', reason: 'not-installed', detail: 'spawn clamscan ENOENT' },
      yara: { status: 'active' }, hashDb: { status: 'active' }, nativeEngine: { status: 'active' }, ...engine },
  },
  scans: { entries: [{ status: 'completed', endedAt: '2026-11-14T10:00:00Z', filesAnalyzed: 3, filesFailed: 0, filesInconclusive: 1, threatsFound: 1 }] },
  events,
  hardware: { cpu: { usage: 12, usageStatus: 'available' }, ram: { usagePercent: 40, usageStatus: 'available' } },
});

const ev = (n, type = 'threat.detected') => ({ type, severity: 'high', timestamp: new Date(Date.UTC(2026, 10, 14, 0, n)).toISOString() });

test('alertas: os cinco MAIS RECENTES do replay (que chega do mais antigo ao mais recente)', () => {
  const events = [...Array(8)].map((_, i) => ev(i));
  const s = projectNigorStatus(base(events));
  assert.equal(s.alerts.length, 5);
  assert.equal(s.alerts[0].timestamp, ev(7).timestamp);
  assert.equal(s.alerts[4].timestamp, ev(3).timestamp);
});

test('motivo do motor é exposto sem o detalhe técnico; desconhecido fica null', () => {
  const s = projectNigorStatus(base([], { yara: { status: 'unavailable', reason: 'invented' } }));
  assert.equal(s.engines.clamav, 'unavailable');
  assert.equal(s.engineReasons.clamav, 'not-installed');
  assert.equal(s.engineReasons.yara, null);
  assert.equal(s.engineReasons.hashDb, null);
  assert.doesNotMatch(JSON.stringify(s), /ENOENT|clamscan/);
});

test('ameaça no histórico sem alertas é explicada pelo âmbito dos alertas', () => {
  const s = projectNigorStatus(base([ev(1, 'scan.completed')]));
  assert.equal(s.latestScan.threatsFound, 1);
  assert.equal(s.latestScan.filesInconclusive, 1);
  assert.deepEqual(s.alerts, []);
  assert.equal(s.alertsScope, 'service-session');
});

test('Nigor distinguishes quarantine outcomes and reports post-write coverage without paths',()=>{
 const source=base([ev(1,'quarantine.added'),ev(2,'quarantine.failed')],{realtimeQueueDepth:3,monitoredPaths:['/private/user/Downloads']});
 source.scans.entries[0].id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
 const s=projectNigorStatus(source);
 assert.equal(s.monitoring.mode,'post-write');assert.equal(s.monitoring.preventionConfirmed,false);
 assert.equal(s.monitoring.queueDepth,3);assert.equal(s.monitoring.rootCount,1);
 assert.equal(s.latestScan.id,source.scans.entries[0].id);
 assert.deepEqual(s.alerts.map(e=>e.type),['quarantine.failed','quarantine.added']);
 assert.doesNotMatch(JSON.stringify(s),/private\/user/);
});
