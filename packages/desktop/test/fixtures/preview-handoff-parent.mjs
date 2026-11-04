import fs from 'node:fs';
import path from 'node:path';
import {createPreviewWindowsInstaller} from '../../src/updater/windows-installer.ts';
import {createEd25519ManifestVerifier} from '../../src/updater/crypto.ts';
import {canonicalManifestBytes} from '../../src/updater/manifest.ts';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const root=process.argv[2], fixture=JSON.parse(fs.readFileSync(path.join(root,'request.json'),'utf8'));
process.env.CYBERSAFE_LAB_INSTALL_EXIT=String(fixture.exitCode);
if(fixture.nativeRejection) {
  const stage=path.join(root,'native-refusal-'+fixture.nativeRejection);
  fs.mkdirSync(stage);
  const helper=path.join(stage,'launcher.exe');
  fs.copyFileSync(path.join(root,'installed/resources/cybersafe-update-launcher.exe'),helper);
  if(fixture.nativeRejection==='helper') fs.appendFileSync(helper,Buffer.from('modified inert LAB image'));
  const artifact=path.join(stage,'installer.exe');fs.copyFileSync(fixture.context.artifactPath,artifact);
  const manifest=fixture.context.manifest;
  const child=spawn(helper,['--preview-handoff',Buffer.from(canonicalManifestBytes(manifest)).toString('base64'),manifest.signature.value,artifact],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(exit,fixture.expectedNativeExit);
  assert.equal(fs.existsSync(path.join(stage,'result.json')),false);
  console.log('Native policy refused before execution: '+fixture.nativeRejection);
  process.exit(0);
}
const adapter=createPreviewWindowsInstaller({
  launcherPath:path.join(root,'installed/resources/cybersafe-update-launcher.exe'),
  stagingRoot:path.join(root,'staging'),journalFile:path.join(root,'operation.json'),
  signatureVerifier:createEd25519ManifestVerifier({publicKey:fixture.publicKey,pinnedFingerprint:fixture.fingerprint}),
  authorizeExecution:()=>true,confirmConsent:async()=>true,
  acquireScanLease:async()=>({renew:async()=>true,release:async()=>{}}),
  requestShutdown:async()=>{
    if(fixture.abort) throw Error('laboratory consent withdrawn before exit');
    fs.writeFileSync(path.join(root,'shutdown-ready'),'LAB only');
    setTimeout(()=>process.exit(0),100);
  },
});
const result=await adapter.install(fixture.context);
console.log(JSON.stringify(result));
process.exitCode=result.ok?0:1;
