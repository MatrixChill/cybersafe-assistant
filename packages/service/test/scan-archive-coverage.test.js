import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { ScanManager } from '../dist/scan-manager.js';

// Small inert fixtures, engine double only: no ClamAV/native/service/quarantine.
for (const kind of ['bounded-entry', 'malformed', 'inner-inconclusive', 'complete']) {
  test(`archive coverage is honest: ${kind}`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-archive-coverage-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'fixture.zip');
    if (kind === 'malformed') await fs.writeFile(file, 'not a zip');
    else {
      const zip = new AdmZip();
      zip.addFile('benign.txt', Buffer.alloc(kind === 'bounded-entry' ? 410000 : 5, 65));
      zip.writeZip(file);
    }
    const manager = new ScanManager({
      emitScanProgress() {},
      async scanArtifact(target) {
        const incomplete = kind === 'inner-inconclusive' && target !== file;
        return { highRiskCount: 0, overallSeverity: 'low', results: [{ analysisState: incomplete ? 'inconclusive' : 'completed', verdict: incomplete ? 'inconclusive' : 'safe' }] };
      },
    });
    const id = await manager.startScan('custom', file);
    const deadline = Date.now() + 5000;
    while (manager.currentScanPromise && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(manager.currentScanPromise, null, 'work must finish within fixture deadline');
    const result = manager.getScan(id);
    assert.equal(result.filesAnalyzed, 1, 'outer ZIP remains one candidate');
    assert.equal(result.filesInconclusive, kind === 'complete' ? 0 : 1);
    if (kind !== 'complete') assert.ok(result.inconclusiveByReason.some(r => r.reason === 'coverage-incomplete' && r.count === 1));
  });
}
