import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {canonicalManifestBytes,validateManifest} from '../src/updater/manifest.ts';
import {fingerprintFromPublicKey} from '../src/updater/crypto.ts';

const openssl=process.env.CYBERSAFE_TEST_OPENSSL || (process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
test('local HTTPS feed -> Ed25519 -> download -> SHA256/cache, invalid metadata, tamper and cancellation',{timeout:30000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cs-update-local-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const keyFile=path.join(root,'tls.key'),certFile=path.join(root,'tls.crt');
  const generated=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore',windowsHide:true,timeout:10000});
  assert.equal(generated.status,0,'requires OpenSSL (CYBERSAFE_TEST_OPENSSL), creates only ephemeral TLS material');
  const signing=generateKeyPairSync('ed25519'),fingerprint=fingerprintFromPublicKey(signing.publicKey);
  const payload=Buffer.alloc(128*1024,0x41),sha=createHash('sha256').update(payload).digest('hex');
  const counts={manifests:0,artifacts:0};let origin;
  const server=https.createServer({key:await fs.readFile(keyFile),cert:await fs.readFile(certFile)},(req,res)=>{
    const route=new URL(req.url,origin);
    if(route.pathname.startsWith('/manifest/')){
      counts.manifests++;
      const mode=route.pathname.split('/').at(-1);
      const raw={schema:'cybersafe-release/1',channel:'stable',version:'0.2.0',publishedAt:'2026-11-02T00:00:00Z',notes:'Synthetic local release',file:{url:`${origin}/artifact/${mode}`,sha256:sha,sizeBytes:payload.length},signature:{algorithm:'ed25519',value:'AAAA',signedByFingerprint:fingerprint},publisher:{name:'Synthetic test only'}};
      const parsed=validateManifest(raw);assert.equal(parsed.ok,true);
      raw.signature.value=sign(null,Buffer.from(canonicalManifestBytes(parsed.manifest)),signing.privateKey).toString('base64');
      if(mode==='bad-signature')raw.notes='modified after signing';
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(raw));return;
    }
    counts.artifacts++;
    const bytes=route.pathname.endsWith('/tamper')?Buffer.alloc(payload.length,0x42):payload;
    res.writeHead(200,{'content-length':bytes.length});
    if(route.pathname.endsWith('/cancel')){
      res.write(bytes.subarray(0,1024));
      const timer=setTimeout(()=>res.end(bytes.subarray(1024)),1500);
      res.once('close',()=>clearTimeout(timer));
    }else res.end(bytes);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`https://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const cache=path.join(root,'cache');await fs.mkdir(cache);
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/updater-local-client.mjs',import.meta.url)),origin,cache,signing.publicKey.export({type:'spki',format:'pem'}).toString(),fingerprint],{
    env:{...process.env,NODE_EXTRA_CA_CERTS:certFile},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(exit,0,output+'\n'+errors);
  assert.equal(counts.manifests,4);assert.equal(counts.artifacts,3,'invalid signed metadata never downloads');
  console.log(output.trim());
});
