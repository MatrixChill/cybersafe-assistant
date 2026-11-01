import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasReparseFreePath, isProtectedQuarantinePath, protectedQuarantineRoots } from '../dist/quarantine-path-policy.js';

test('recusa Windows, Program Files, ProgramData e a raiz do servico', () => {
  const context = { baseDir: 'C:/ProgramData/CyberSafe', execPath: 'C:/Program Files/CyberSafe/service.exe', env: { WINDIR: 'C:/Windows', ProgramFiles: 'C:/Program Files', ProgramData: 'C:/ProgramData' } };
  for (const p of ['C:/Windows/System32/kernel32.dll', 'C:/Program Files/App/x.exe', 'C:/ProgramData/CyberSafe/quarantine/x', 'C:/Program Files/CyberSafe/service.exe'])
    assert.equal(isProtectedQuarantinePath(p, context), true, p);
  assert.equal(isProtectedQuarantinePath('C:/Users/alice/Downloads/fixture.txt', context), false);
  assert.equal(isProtectedQuarantinePath('relative.txt', context), true);
});

test('nao confunde prefixos parecidos com raizes protegidas', () => {
  const context = { baseDir: 'C:/ProgramData/CyberSafe', env: { WINDIR: 'C:/Windows' } };
  assert.equal(isProtectedQuarantinePath('C:/WindowsApps/fixture.txt', context), false);
  assert.equal(isProtectedQuarantinePath('C:/ProgramData/CyberSafe-old/fixture.txt', context), false);
});

test('realpath exige um caminho sem redirecionamento e falha fechado', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-qpath-'));
  try {
    const file = path.join(dir, 'fixture.txt');
    await fs.writeFile(file, 'benign');
    assert.equal(await hasReparseFreePath(file), true);
    assert.equal(await hasReparseFreePath(path.join(dir, 'missing.txt')), false);
    const roots = protectedQuarantineRoots({ baseDir: dir, env: {} });
    assert.ok(roots.includes(path.resolve(dir).toLowerCase()));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
