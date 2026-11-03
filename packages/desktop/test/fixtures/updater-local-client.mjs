import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createUpdater} from '../../src/updater/updater.ts';
import {resolveUpdaterConfig} from '../../src/updater/config.ts';
import {HttpsFeedSource} from '../../src/updater/sources.ts';
import {createNodeHttpsOpener,createHttpsFeedFetcher,createHttpsArtifactDownloader} from '../../src/updater/node-transport.ts';
import {createNodeCacheFileSystem} from '../../src/updater/node-cache-fs.ts';
import {createEd25519ManifestVerifier} from '../../src/updater/crypto.ts';

const [origin,root,pem,fingerprint] = process.argv.slice(2);
const cases=[];
for (const scenario of ['valid','bad-signature','tamper','cancel']) {
  const cacheDir=path.join(root,scenario);
  await fs.mkdir(cacheDir);
  const resolved=resolveUpdaterConfig({channel:'stable',feedManifestUrl:`${origin}/manifest/${scenario}`,originAllowlist:[new URL(origin).host],pinnedKeyFingerprint:fingerprint,expectedPublisherName:'Synthetic test only',cacheDir,timeoutMs:10000,maxDownloadBytes:1024*1024,automaticCheckEnabled:false});
  assert.equal(resolved.ok,true);
  const config=resolved.config, opener=createNodeHttpsOpener();
  let installs=0,publishers=0,maxProgress=0;
  const updater=createUpdater({config:resolved,runtimeSupported:true,manualDownloadOnly:true,installed:{version:'0.1.0'},
    source:new HttpsFeedSource(config,createHttpsFeedFetcher(config,opener)),
    downloader:createHttpsArtifactDownloader(config,opener),cacheFs:createNodeCacheFileSystem(cacheDir),
    signatureVerifier:createEd25519ManifestVerifier({publicKey:pem,pinnedFingerprint:fingerprint}),
    publisherVerifier:{async verify(){publishers++;return {ok:false};}},
    installer:{async install(){installs++;throw Error('installer must never execute');}},scanProbe:async()=> 'idle'});
  let cancelled=false;
  const off=updater.onState(snapshot=>{
    maxProgress=Math.max(maxProgress,snapshot.progress?.downloadedBytes??0);
    if(scenario==='cancel'&&!cancelled&&maxProgress>0){cancelled=true;void updater.cancel();}
  });
  const checked=await updater.check();
  if(scenario==='bad-signature') {
    assert.equal(checked.ok,false);assert.equal(checked.snapshot.error.code,'untrusted-metadata');
  }else {
    assert.equal(checked.ok,true,JSON.stringify(checked));
    const downloaded=await updater.download();
    if(scenario==='valid') {
      assert.equal(downloaded.ok,true,JSON.stringify(downloaded));
      assert.equal(downloaded.snapshot.phase,'downloaded');assert.equal(downloaded.snapshot.canInstall,false);
      assert.equal(maxProgress,128*1024);
      const revealed=[];assert.equal((await updater.revealVerifiedDownload(p=>revealed.push(p))).ok,true);
      assert.equal(revealed.length,1);
      assert.equal((await updater.install({confirmed:true,expectedVersion:'0.2.0'})).ok,false);
    }else {
      assert.equal(downloaded.ok,false);
      assert.equal(downloaded.snapshot.error.code,scenario==='tamper'?'integrity':'cancelled');
      assert.deepEqual(await fs.readdir(cacheDir),[],'failed downloads leave no cache files');
    }
  }
  off();assert.equal(installs,0);assert.equal(publishers,0,'manual mode never pretends Authenticode was checked');
  cases.push({scenario,maxProgress,executed:false});
}
console.log(JSON.stringify({scope:'local HTTPS, ephemeral Ed25519, real transport/cache; no installer or upgrade',cases}));
