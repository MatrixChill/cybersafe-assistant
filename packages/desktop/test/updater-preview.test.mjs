import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { buildSignedManifest } from '../../../scripts/release-signing.mjs';
import { canonicalManifestBytes, validateManifest } from '../src/updater/manifest.ts';
import { createEd25519ManifestVerifier, fingerprintFromPublicKey } from '../src/updater/crypto.ts';
import {createUpdater} from '../src/updater/updater.ts';
import {createHash} from 'node:crypto';
import path from 'node:path';

test('explicit assisted Preview verifies signature and bytes, requires consent and dispatches only to its adapter',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const pin=fingerprintFromPublicKey(publicKey), bytes=Buffer.from('inert Preview test');
  const signed=buildSignedManifest({schema:'cybersafe-release/1',channel:'preview',version:'0.2.0-rc.6',
    publishedAt:'2026-11-04T00:00:00Z',notes:'Fixture',requiresElevation:false,
    file:{url:'https://github.com/MatrixChill/cybersafe-assistant/releases/download/v0.2.0-rc.6/setup.exe',sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length},
    publisher:{name:'CyberSafe Preview (sem Authenticode)'},sourceCommit:'b'.repeat(40),compatibility:{minWindowsBuild:19045}},privateKey,pin).signed;
  const files=new Map();let installs=0;
  const updater=createUpdater({config:{ok:true,config:{channel:'preview',feedManifestUrl:'https://github.com/MatrixChill/cybersafe-assistant/releases/download/channel-preview/update-manifest.json',originAllowlist:['github.com'],pinnedKeyFingerprint:pin,expectedPublisherName:signed.publisher.name,cacheDir:path.resolve('fixture-preview-cache'),timeoutMs:5000,maxDownloadBytes:1000,automaticCheckEnabled:false}},
    runtimeSupported:true,installed:{version:'0.2.0-rc.5'},previewWindowsBuild:26100,previewAssistedInstallation:true,
    source:{fetchLatest:async()=>({kind:'latest',manifest:signed})},
    signatureVerifier:createEd25519ManifestVerifier({publicKey,pinnedFingerprint:pin}),
    publisherVerifier:{verify:async()=>{throw Error('Stable publisher path must not be used for Preview')}},
    downloader:{download:async(url,destination)=>{files.set(destination,bytes);return {path:destination,bytes:bytes.length}}},
    cacheFs:{ensureDir:async()=>{},statFile:async p=>files.has(p)?{size:files.get(p).length}:null,readFile:async p=>files.get(p)??null,removePath:async p=>files.delete(p),writeAtomic:async(p,suffix,data)=>files.set(p.replace(/\.tmp$/,suffix),data)},
    scanProbe:async()=> 'idle',installer:{install:async context=>{installs++;assert.equal(context.manifest.channel,'preview');return {ok:true}}},
  });
  assert.equal((await updater.check()).ok,true);
  assert.equal((await updater.download()).ok,true);
  assert.equal(updater.snapshotCopy().canInstall,true);
  assert.equal((await updater.install({confirmed:true,expectedVersion:'0.2.0-rc.6'})).ok,true);
  assert.equal(installs,1);
});

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
