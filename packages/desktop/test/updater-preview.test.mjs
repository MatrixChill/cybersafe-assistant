import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { buildSignedManifest } from '../../../scripts/release-signing.mjs';
import { canonicalManifestBytes, validateManifest } from '../src/updater/manifest.ts';
import { createEd25519ManifestVerifier, fingerprintFromPublicKey } from '../src/updater/crypto.ts';

test('Preview signing and client validation agree, and Stable refuses the signed Preview', async () => {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({format:'pem', type:'spki'});
  const pin = fingerprintFromPublicKey(publicPem);
  const input = {
    schema:'cybersafe-release/1', channel:'preview', version:'0.2.0-rc.6',
    publishedAt:'2026-11-04T00:00:00Z', notes:'Fixture only',
    file:{url:'https://github.com/MatrixChill/cybersafe-assistant/releases/download/v0.2.0-rc.6/setup.exe',sha256:'a'.repeat(64),sizeBytes:123},
    publisher:{name:'CyberSafe Preview (sem Authenticode)'}, requiresElevation:false,
    sourceCommit:'b'.repeat(40), compatibility:{minWindowsBuild:19045},
  };
  const signed = buildSignedManifest(input, privateKey, pin).signed;
  assert.equal(validateManifest(signed).ok,false);
  const parsed = validateManifest(signed,'preview');
  assert.equal(parsed.ok,true);
  const verifier = createEd25519ManifestVerifier({publicKey:publicPem,pinnedFingerprint:pin});
  assert.equal((await verifier.verify(canonicalManifestBytes(parsed.manifest),signed.signature.value,pin)).ok,true);
  for (const bad of [
    {...signed,requiresElevation:true},
    {...signed,sourceCommit:'b'.repeat(7)},
    {...signed,file:{...signed.file,url:signed.file.url+'?x=1'}},
    {...signed,version:'0.2.0'},
  ]) assert.equal(validateManifest(bad,'preview').ok,false);
});
