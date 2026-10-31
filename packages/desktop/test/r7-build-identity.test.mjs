import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBuildIdentity, readBuildIdentity } from '../src/build-identity.ts';

test('R7: o carimbo do build fornece build e commit reais', () => {
  assert.deepEqual(
    parseBuildIdentity({ version: '0.1.10-internal.pap-r7.20261031', buildId: '20261031-231500', commit: '2dae912' }),
    { version: '0.1.10-internal.pap-r7.20261031', build: '20261031-231500', commit: '2dae912' },
  );
});

test('R7: campos ausentes não são inventados (UI diz desconhecida)', () => {
  assert.deepEqual(parseBuildIdentity({ version: '0.1.10' }), { version: '0.1.10', build: undefined, commit: undefined });
  assert.deepEqual(parseBuildIdentity(null), {});
  assert.deepEqual(parseBuildIdentity({ version: '0.1.10', buildId: '', commit: 'desconhecido' }), { version: '0.1.10', build: undefined, commit: undefined });
});

test('R7: ficheiro de identidade em falta devolve vazio sem lançar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r7-identity-'));
  try {
    assert.deepEqual(readBuildIdentity(dir), {});
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'build-identity.json'), '{not json');
    assert.deepEqual(readBuildIdentity(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R7: carimbo válido em dist/ é lido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r7-identity-'));
  try {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'build-identity.json'), JSON.stringify({ version: '0.1.10', buildId: 'b1', commit: 'abcdef1' }));
    assert.deepEqual(readBuildIdentity(dir), { version: '0.1.10', build: 'b1', commit: 'abcdef1' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
