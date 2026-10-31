import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProtectionEngineService } from '../dist/engine.js';

// The old handler acknowledged unknown/terminal IDs as successfully cancelled.
test('cancel RPC refuses an unknown scan instead of acknowledging an action that never happened', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cancel-rpc-'));
  const service = new ProtectionEngineService(root);
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const reply = await service.handleRequest({ id:'test', method:'scan.cancel', payload:{id:'00000000-0000-4000-8000-000000000001'} });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.success, false);
});

test('cancel RPC confirms a real active fixture scan and refuses a second terminal cancellation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cancel-active-'));
  const file = path.join(root, 'harmless.txt'); fs.writeFileSync(file, 'Harmless cancellation fixture');
  const service = new ProtectionEngineService(path.join(root, 'state'));
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const scan = await service.handleRequest({ id:'start', method:'scan.start', payload:{type:'custom', targetPath:file} });
  assert.ok(scan.result.id);
  const cancel = () => service.handleRequest({id:'cancel',method:'scan.cancel',payload:{id:scan.result.id}});
  assert.equal((await cancel()).result.success, true);
  assert.equal(service.scanManager.getLastScan(scan.result.id).status, 'cancelled');
  assert.equal((await cancel()).result.success, false);
});
