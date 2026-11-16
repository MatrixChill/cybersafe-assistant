import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('root staging binds exact signed bytes, rejects substitution and never trusts a client marker',{skip:process.platform!=='linux'},async()=>{
 const {stageVerifiedPackage}=await import('../linux-lite/arch/update-install-helper.mjs');
 const root=mkdtempSync(join(tmpdir(),'cs-stage-'));
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const body=Buffer.from('synthetic package, never installed');
 const digest=createHash('sha256').update(body).digest('hex');
 const file='cybersafe-assistant-linux-lite-0.2.5-1-x86_64.pkg.tar.zst';
 const manifest={schema:2,package:'cybersafe-assistant-linux-lite',edition:'arch-shared',channel:'experimental',arch:'x86_64',version:'0.2.5',pkgrel:1,minClient:'0.2.4-4',url:`https://github.com/MatrixChill/cybersafe-assistant/releases/download/linux-v0.2.5-arch-preview.1/${file}`,size:body.length,sha256:digest,publishedAt:'2026-11-16T00:00:00Z'};
 const manifestFile=join(root,'manifest.json'),signatureFile=join(root,'manifest.sig'),packageFile=join(root,file);
 const bytes=Buffer.from(JSON.stringify(manifest));
 for(const [path,data] of [[manifestFile,bytes],[signatureFile,sign(null,bytes,privateKey).toString('base64')],[packageFile,body]])writeFileSync(path,data,{mode:0o600});
 const config={schema:2,publicKeys:[publicKey.export({type:'spki',format:'pem'})],edition:'arch-shared'};
 const request={manifestFile,signatureFile,packageFile,expectedSha256:digest,uid:process.getuid(),config,stagingRoot:root};
 try{
  const staged=await stageVerifiedPackage(request);
  assert.deepEqual(readFileSync(staged.file),body);
  await assert.rejects(stageVerifiedPackage({...request,config:{...config,edition:'nigor'}}),/manifest-package/);
  writeFileSync(packageFile,'changed after download');
  assert.deepEqual(readFileSync(staged.file),body,'privileged copy is independent from user cache');
  await assert.rejects(stageVerifiedPackage(request),/package-integrity/);
  writeFileSync(packageFile,body);writeFileSync(signatureFile,'ed25519-verified');
  await assert.rejects(stageVerifiedPackage(request),/signature/);
  writeFileSync(signatureFile,sign(null,bytes,privateKey).toString('base64'));
  await assert.rejects(stageVerifiedPackage({...request,expectedSha256:'0'.repeat(64)}),/request-mismatch/);
  rmSync(packageFile);symlinkSync(manifestFile,packageFile);
  await assert.rejects(stageVerifiedPackage(request),/source-unsafe/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('metadata compatibility and dependency errors stop before invoking pacman installation',async()=>{
 const {validatePackageInfo}=await import('../linux-lite/arch/update-install-helper.mjs');
 const expected={version:'0.2.5',pkgrel:1,arch:'x86_64'};
 const info='pkgname = cybersafe-assistant-linux-lite\npkgver = 0.2.5-1\narch = x86_64\ndepend = nodejs>=22\n';
 assert.deepEqual(validatePackageInfo(info,expected).dependencies,['nodejs>=22']);
 for(const altered of [info.replace('linux-lite','other'),info.replace('x86_64','aarch64'),info.replace('0.2.5-1','0.2.4-1'),info+'pkgver = 0.2.5-1\n'])assert.throws(()=>validatePackageInfo(altered,expected),/package-identity/);
});

test('preflight refuses pacman lock, downgrade, missing dependencies and mismatched package metadata',async()=>{
 const {installationPreflight}=await import('../linux-lite/arch/update-install-helper.mjs');
 const root=mkdtempSync(join(tmpdir(),'cs-preflight-'));
 const lock=join(root,'db.lck');
 const staged={file:join(root,'package'),manifest:{version:'0.2.5',pkgrel:1,arch:'x86_64',parsedVersion:{major:0,minor:2,patch:5,pkgrel:1}}};
 const calls=[];let missing=false;
 const run=(binary,args)=>{
  calls.push({binary,args});
  if(args[0]==='-Q')return {status:0,stdout:'cybersafe-assistant-linux-lite 0.2.4-3\n'};
  if(binary==='/usr/bin/bsdtar')return {status:0,stdout:'pkgname = cybersafe-assistant-linux-lite\npkgver = 0.2.5-1\narch = x86_64\ndepend = nodejs>=22\n'};
  if(args[0]==='-T')return {status:missing?127:0,stdout:''};
  throw new Error('unexpected command');
 };
 try{
  writeFileSync(lock,'busy');assert.throws(()=>installationPreflight(staged,run,lock),/pacman-busy/);assert.equal(calls.length,0);
  rmSync(lock);installationPreflight(staged,run,lock);
  assert.deepEqual(calls.at(-1).args,['-T','--','nodejs>=22']);
  missing=true;assert.throws(()=>installationPreflight(staged,run,lock),/dependencies-unsatisfied/);
  const lower={...staged,manifest:{...staged.manifest,parsedVersion:{major:0,minor:2,patch:4,pkgrel:2}}};
  assert.throws(()=>installationPreflight(lower,run,lock),/downgrade-or-equal/);
  assert.equal(calls.some(c=>c.args.includes('-U')||c.args.includes('--noconfirm')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('running installed GUI or service blocks package replacement',{skip:process.platform!=='linux'},async()=>{
 const {assertProductStopped}=await import('../linux-lite/arch/update-install-helper.mjs');
 const root=mkdtempSync(join(tmpdir(),'cs-proc-')),proc=join(root,'99999');
 try{
  mkdirSync(proc);symlinkSync('/usr/bin/node',join(proc,'exe'));
  writeFileSync(join(proc,'cmdline'),'/usr/bin/node\0/opt/cybersafe-assistant-linux-lite/run-service.mjs\0');
  assert.throws(()=>assertProductStopped(root),/service-running/);
  writeFileSync(join(proc,'cmdline'),'/usr/bin/node\0/some/other/program\0');assertProductStopped(root);
  rmSync(join(proc,'exe'));symlinkSync('/opt/cybersafe-assistant-linux-lite/cybersafe-assistant-linux-lite',join(proc,'exe'));
  assert.throws(()=>assertProductStopped(root),/application-running/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
