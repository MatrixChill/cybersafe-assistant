import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBuildIdentity, readBuildIdentity } from '../src/build-identity.ts';

const VERSAO = '0.1.11-internal.pap-r7.20261031';

test('R7: o carimbo do build fornece build e commit reais', () => {
  assert.deepEqual(
    parseBuildIdentity({ version: VERSAO, buildId: '20261031-231500', commit: '2dae912' }, VERSAO),
    { version: VERSAO, build: '20261031-231500', commit: '2dae912' },
  );
});

test('R7: carimbo de OUTRA versão não descreve esta instalação', () => {
  assert.deepEqual(parseBuildIdentity({ version: '0.1.10-internal.pap-r6.20261031', buildId: 'b', commit: 'abcdef1' }, VERSAO), {});
});

test('R7: build inválido (espaços, símbolos ou >64) não é aceite', () => {
  assert.equal(parseBuildIdentity({ version: VERSAO, buildId: 'a b' }, VERSAO).build, undefined);
  assert.equal(parseBuildIdentity({ version: VERSAO, buildId: 'x'.repeat(65) }, VERSAO).build, undefined);
  assert.equal(parseBuildIdentity({ version: VERSAO, buildId: '20261031-231500' }, VERSAO).build, '20261031-231500');
});

test('R7: commit só é aceite como SHA hexadecimal de 7–40', () => {
  assert.equal(parseBuildIdentity({ version: VERSAO, commit: 'desconhecido' }, VERSAO).commit, undefined);
  assert.equal(parseBuildIdentity({ version: VERSAO, commit: 'XYZ' }, VERSAO).commit, undefined);
  assert.equal(parseBuildIdentity({ version: VERSAO, commit: 'a'.repeat(41) }, VERSAO).commit, undefined);
  assert.equal(parseBuildIdentity({ version: VERSAO, commit: '3595e2d' }, VERSAO).commit, '3595e2d');
});

test('R7: campos ausentes não são inventados', () => {
  assert.deepEqual(parseBuildIdentity({ version: VERSAO }), { version: VERSAO, build: undefined, commit: undefined });
  assert.deepEqual(parseBuildIdentity(null), {});
});

test('R7: ficheiro em falta, inválido ou de outra versão devolve vazio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r7-identity-'));
  try {
    assert.deepEqual(readBuildIdentity(dir, VERSAO), {});
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'build-identity.json'), '{not json');
    assert.deepEqual(readBuildIdentity(dir, VERSAO), {});
    fs.writeFileSync(path.join(dir, 'dist', 'build-identity.json'), JSON.stringify({ version: '0.1.9', buildId: 'b', commit: 'abcdef1' }));
    assert.deepEqual(readBuildIdentity(dir, VERSAO), {});
    fs.writeFileSync(path.join(dir, 'dist', 'build-identity.json'), JSON.stringify({ version: VERSAO, buildId: 'b1', commit: 'abcdef1' }));
    assert.deepEqual(readBuildIdentity(dir, VERSAO), { version: VERSAO, build: 'b1', commit: 'abcdef1' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
