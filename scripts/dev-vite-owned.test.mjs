import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Vite owned process closes its listener and exits upon parent IPC request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vite-owned-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>controlled fixture</html>');
  const child = fork(new URL('./dev-vite-owned.mjs', import.meta.url), [], {
    env: { ...process.env, CS_OWNED_VITE_ROOT: root, CS_OWNED_VITE_TEST: '1' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const [ready] = await once(child, 'message');
  assert.equal(ready.type, 'ready');
  assert.equal((await fetch(`http://127.0.0.1:${ready.port}/`)).status, 200);
  const exited = once(child, 'exit');
  child.send({ type: 'cybersafe:dev:shutdown' });
  const [code] = await exited;
  assert.equal(code, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${ready.port}/`));
});
