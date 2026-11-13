import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firewallStatus } from '../linux-lite/arch/firewall.mjs';

test('reports backend state only from recognizable successful output', async () => {
  const result = await firewallStatus(async (bin) => ({
    'firewall-cmd': { code: 0, stdout: 'running\n' },
    ufw: { code: 1, stderr: 'ERROR: You need to be root' },
    nft: { code: 0, stdout: '{"nftables":[{"rule":{}}]}' },
  })[bin]);
  assert.deepEqual(result, { firewalld: 'running', ufw: 'permission-denied', nftables: 'rules-present' });
});
test('absence, empty rules and failed commands never mean protection is off', async () => {
  assert.deepEqual(await firewallStatus(async (bin) => ({
    'firewall-cmd': { missing: true },
    ufw: { code: 0, stdout: 'unknown' },
    nft: { code: 0, stdout: '{"nftables":[]}' },
  })[bin]), { firewalld: 'unavailable', ufw: 'unknown', nftables: 'no-rules-reported' });
});
