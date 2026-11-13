import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPanel } from '../linux-lite/arch/nigor-panel.mjs';

test('offline panel remains usable without inventing engine or protection states', () => {
  const panel = formatPanel(null);
  assert.match(panel, /Serviço: indisponível/);
  assert.match(panel, /Abra o CyberSafe/);
  assert.doesNotMatch(panel, /ClamAV: ativo|Monitorização: ativa|CPU: 0%/);
});

test('panel shows real zero, unknown engine states and inconclusive scan counts', () => {
  const panel = formatPanel({
    version: 1, serviceRunning: true, protection: { enabled: false },
    engines: { clamav: 'degraded', yara: null },
    latestScan: { status: 'completed', filesAnalyzed: 0, filesInconclusive: 1 },
    alerts: [], metrics: { cpuPercent: 0, ramPercent: null },
  });
  assert.match(panel, /Monitorização: desativada/);
  assert.match(panel, /ClamAV: degradado/);
  assert.match(panel, /YARA: sem leitura/);
  assert.match(panel, /CPU: 0%/);
  assert.match(panel, /RAM: sem leitura/);
  assert.match(panel, /Inconclusivos: 1/);
  assert.throws(() => formatPanel({ version: 2 }));
});
