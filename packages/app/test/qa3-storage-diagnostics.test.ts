import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiskSnapshot } from '@cybersafe/shared-types';
import { StorageHealthPanel } from '../src/components/StorageHealthPanel';
import { redactDiagnostic } from '../src/components/TechnicalDiagnostic';

const secret = 'qa3-fixture-not-a-real-secret';
const longError = `Get-PhysicalDisk failed: C:\\fixture\\${'disk'.repeat(300)} token=${secret}\n`.repeat(20);
const snapshot = (extra: Partial<DiskSnapshot> = {}) => ({ readStatus: 'unavailable', reason: longError, volumes: [], primary: null, usagePercent: null, usedGb: null, totalGb: null, fsType: null, lastGoodAt: null, physical: [], physicalStatus: 'unavailable', physicalDetail: longError, physicalErrorDetail: longError, ...extra }) as DiskSnapshot;
const render = (disk: DiskSnapshot, mode: 'full' | 'summary' | 'details' = 'full') => renderToStaticMarkup(createElement(StorageHealthPanel, { disk, mode }));

test('QA3: compact summary never prints raw PowerShell output or credentials', () => {
  const html = render(snapshot(), 'summary');
  assert.doesNotMatch(html, /Get-PhysicalDisk|qa3-fixture-not-a-real-secret/);
  assert.match(html, /indisponível/i);
  assert.doesNotMatch(html, /Windows: saudável|0%/);
});

test('QA3: full diagnostic is collapsed, bounded and redacted, not discarded', () => {
  const html = render(snapshot());
  assert.match(html, /Ver mais detalhes/);
  assert.match(html, /<details[^>]*data-testid="technical-diagnostic"/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /max-h-48/);
  assert.match(html, /overflow-y-auto/);
  assert.match(html, /\[overflow-wrap:anywhere\]/);
  assert.match(html, /Copiar detalhes/);
  assert.match(html, /Get-PhysicalDisk/);
  assert.doesNotMatch(html, new RegExp(secret));
});

test('QA3: display and copy redaction covers labelled credentials, bearer, URLs and private keys', () => {
  for (const text of [
    'password="fixture password with spaces"',
    "palavra-passe='fixture password with spaces'",
    'token=fixture-secret',
    'api_key: fixture-secret',
    'Authorization: Bearer fixture-secret',
    'https://fixture-user:fixture-secret@example.invalid/path',
    '-----BEGIN PRIVATE KEY-----\nfixture-secret\n-----END PRIVATE KEY-----',
    'sk-fixturesecret123456789',
    'ghp_fixturesecret123456789',
    'eyJfixture.payload.signature',
  ]) {
    assert.doesNotMatch(redactDiagnostic(text), /fixture-secret|fixture password|fixturesecret|eyJfixture/);
  }
  assert.equal(redactDiagnostic('Get-PhysicalDisk: Access denied C:\\fixture\\disk'), 'Get-PhysicalDisk: Access denied C:\\fixture\\disk');
});

test('QA3: no reading stays distinct from failed reading and input remains unchanged', () => {
  const disk = snapshot();
  render(disk);
  assert.equal(disk.physicalErrorDetail, longError);
  const html = render(snapshot({ physical: undefined, physicalStatus: undefined, physicalDetail: undefined, physicalErrorDetail: undefined }));
  assert.match(html, /Ainda não há leitura/);
  assert.doesNotMatch(html, /Copiar detalhes/);
});
