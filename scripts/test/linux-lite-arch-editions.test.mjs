import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { validateManifest, checkForUpdate, parseVersion } from '../linux-lite/arch/updater.mjs';

const generic = 'cybersafe-assistant-linux-lite';
const nigor = 'cybersafe-assistant-nigor';
const base = 'https://github.com/MatrixChill/cybersafe-assistant/releases/download';
const signedFields = {
  schema: 2, channel: 'experimental', arch: 'x86_64', version: '0.2.4', pkgrel: 2,
  minClient: '0.2.4-1', size: 1, sha256: 'f'.repeat(64), publishedAt: '2026-11-16T00:00:00Z',
};
const manifest = {
  ...signedFields, edition: 'nigor', package: nigor,
  url: `${base}/nigor-v0.2.4-preview.2/${nigor}-0.2.4-2-x86_64.pkg.tar.zst`,
};

test('v2 binds edition, package, tag and client floor', () => {
  assert.equal(validateManifest(manifest, {schema: 2, edition: 'nigor'}).ok, true);
  for (const change of [{schema: 1}, {edition: 'arch-shared'}, {package: generic}, {minClient: undefined}, {url: manifest.url.replace('/nigor-v', '/linux-v')}]) {
    assert.equal(validateManifest({...manifest, ...change}, {schema: 2, edition: 'nigor'}).ok, false);
  }
  assert.equal(validateManifest(manifest, {schema: 2, edition: 'arch-shared'}).ok, false);
});

test('packaged protected feeds have different routes and reject the historical route before network access', async () => {
  const config = JSON.parse(readFileSync(new URL('../linux-lite/arch/update-channel.json', import.meta.url)));
  assert.equal(config.schema, 2);
  const result = await checkForUpdate({installed: parseVersion('0.2.4-4'), config: {...config, manifestBase: `${base}/linux-update-channel`}, fetchImpl: () => assert.fail('legacy feed must not be queried')});
  assert.equal(result.reason, 'channel-route');
});

test('a signed Nigor offer goes only to a compatible v2 client', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const config = JSON.parse(readFileSync(new URL('../../integrations/nigor/packaging/update-channel.json', import.meta.url)));
  config.publicKeys = [publicKey.export({type:'spki',format:'pem'})];
  const bytes = Buffer.from(JSON.stringify(manifest));
  const sig = sign(null, bytes, privateKey).toString('base64');
  const fetchImpl = async url => new Response(url.endsWith('.sig') ? sig : bytes);
  const result = installed => checkForUpdate({installed:parseVersion(installed),config,fetchImpl});
  assert.equal((await result('0.2.4-1')).state,'available');
  assert.equal((await result('0.2.4-2')).state,'up-to-date');
  assert.equal((await result('0.2.4-3')).state,'downgrade-refused');
  assert.equal((await result('0.2.3-1')).reason,'client-floor');
  assert.equal(validateManifest(manifest).ok,false);
});
