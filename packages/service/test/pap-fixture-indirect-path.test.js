import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCustomContido } from '../dist/dev-fixture-gate.js';

test('um junction interno não é um alvo de fixture autorizado', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-fixture-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, 'real'); fs.mkdirSync(child);
  const link = path.join(root, 'junction'); fs.symlinkSync(child, link, 'junction');
  const r = scanCustomContido({type:'custom', targetPath:link}, {root,real:fs.realpathSync(root)});
  assert.equal(r.ok, false);
  assert.equal(scanCustomContido({type:'custom', targetPath:root}, {root,real:fs.realpathSync(root)}).ok, false, 'recusa diretório que contém junction');
  assert.equal(scanCustomContido({type:'custom', targetPath:child}, {root,real:fs.realpathSync(root)}).ok, true, 'diretório comum permanece autorizado');
});
