// Native Preview execution with an inert EXE, public RFC test key and isolated
// registry namespace. Never edits the real CyberSafe registration or profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildSignedManifest} from './release-signing.mjs';
import {canonicalManifestBytes} from './release-signing.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='win32')throw Error('Windows laboratory required');
function run(program,args){const r=spawnSync(program,args,{cwd:repo,windowsHide:true,encoding:'utf8',timeout:120000});if(r.error||r.status!==0)throw Error(r.error?.message||r.stdout+r.stderr);return r.stdout;}
run('cmake',['-S','packages/native-engine','-B','packages/native-engine/build']);
run('cmake',['--build','packages/native-engine/build','--config','Release','--target','cybersafe-update-launcher-lab']);
run('cmake',['-S','packages/desktop/test/fixtures/handoff-simulator','-B','output/handoff-lab/simulator-build']);
run('cmake',['--build','output/handoff-lab/simulator-build','--config','Release']);
const launcher=path.join(repo,'packages/native-engine/build/lab/cybersafe-update-launcher-lab.exe');
const simulator=path.join(repo,'output/handoff-lab/simulator-build/Release/benign-installer.exe');
const productVersion=JSON.parse(fs.readFileSync(path.join(repo,'product-version.json'))).version;
const parsed=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/.exec(productVersion);
if(!parsed)throw new Error('Preview laboratory requires a stable or rc product version');
const [major,minor,patch,rcNumber]=[parsed[1],parsed[2],parsed[3],parsed[4]];
// The native Preview parser only accepts an installed rc version. The lab
// therefore exercises a synthetic rc when the product itself is stable; the
// distribution launcher still carries productVersion.
const installedVersion=rcNumber?productVersion:`${major}.${minor}.${patch}-rc.1`;
const installedRc=Number(rcNumber??1);
const target=`${major}.${minor}.${patch}-rc.${installedRc+1}`;
const downgradeVersion=installedRc>1?`${major}.${minor}.${patch}-rc.${installedRc-1}`:
  Number(patch)>0?`${major}.${minor}.${Number(patch)-1}-rc.1`:
  Number(minor)>0?`${major}.${Number(minor)-1}.0-rc.1`:
  Number(major)>0?`${Number(major)-1}.0.0-rc.1`:null;
if(!downgradeVersion)throw new Error('Cannot derive a lower Preview version');
// Public RFC 8032 vector. This is NOT a credential or product signing key.
const key=createPrivateKey({key:Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex'),format:'der',type:'pkcs8'});
const publicKey=createPublicKey(key).export({format:'pem',type:'spki'});
const fingerprint=createHash('sha256').update(createPublicKey(key).export({format:'der',type:'spki'})).digest('hex').toUpperCase();
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cybersafe-preview-native-lab-'));
const installed=path.join(root,'installed');fs.mkdirSync(path.join(installed,'resources'),{recursive:true});
fs.copyFileSync(process.execPath,path.join(installed,'CyberSafe Assistant.exe'));
fs.copyFileSync(launcher,path.join(installed,'resources/cybersafe-update-launcher.exe'));
function ps(code){return run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')]);}
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const registry='HKCU:\\Software\\CyberSafeLauncherLabOnly';
ps(`if(Test-Path -LiteralPath ${quote(registry)}){throw 'existing laboratory registry must be reviewed first'}`);
const installRegistry=registry+'-Install';
ps(`if(Test-Path -LiteralPath ${quote(installRegistry)}){throw 'existing laboratory install registry must be reviewed first'}`);
let created=false;
try{
  ps(`$ErrorActionPreference='Stop'; New-Item -Path ${quote(registry)} | Out-Null; New-Item -Path ${quote(installRegistry)} | Out-Null; New-ItemProperty -LiteralPath ${quote(installRegistry)} -Name InstallLocation -Value ${quote(installed)} -PropertyType String | Out-Null; New-ItemProperty -LiteralPath ${quote(registry)} -Name DisplayVersion -Value ${quote(installedVersion)} -PropertyType String | Out-Null`);created=true;
  for(const scenario of [{exitCode:0},{exitCode:7},{exitCode:0,abort:true},
    {nativeRejection:'hash',expectedNativeExit:9},{nativeRejection:'signature',expectedNativeExit:7},
    {nativeRejection:'downgrade',expectedNativeExit:8},{nativeRejection:'windows',expectedNativeExit:8},
    {nativeRejection:'missing-location',expectedNativeExit:10},{nativeRejection:'wrong-location',expectedNativeExit:10},
    {nativeRejection:'helper',expectedNativeExit:10},{nativeRejection:'registration',expectedNativeExit:10}]){
    ps(`Set-ItemProperty -LiteralPath ${quote(installRegistry)} -Name InstallLocation -Value ${quote(installed)}`);
    if(scenario.nativeRejection==='missing-location') ps(`Remove-ItemProperty -LiteralPath ${quote(installRegistry)} -Name InstallLocation`);
    if(scenario.nativeRejection==='wrong-location') ps(`Set-ItemProperty -LiteralPath ${quote(installRegistry)} -Name InstallLocation -Value ${quote(path.join(root,'unrelated'))}`);
    const bytes=fs.readFileSync(simulator);
    const releaseVersion=scenario.nativeRejection==='downgrade'?downgradeVersion:target;
    const manifest=buildSignedManifest({schema:'cybersafe-release/1',channel:'preview',version:releaseVersion,publishedAt:'2026-11-04T00:00:00Z',notes:'Inert LAB; never publish',
      file:{url:`https://github.com/MatrixChill/cybersafe-assistant/releases/download/v${releaseVersion}/never-publish-lab.exe`,sha256:scenario.nativeRejection==='hash'?'f'.repeat(64):createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length},
      publisher:{name:'CyberSafe Preview (sem Authenticode)'},requiresElevation:false,sourceCommit:'a'.repeat(40),compatibility:{minWindowsBuild:scenario.nativeRejection==='windows'?99999999:19045}},key,fingerprint).signed;
    if(scenario.nativeRejection==='signature') manifest.signature.value=Buffer.alloc(64).toString('base64');
    if(scenario.exitCode===0&&!scenario.abort) {
      const production=spawnSync(path.join(repo,'packages/native-engine/build/Release/cybersafe-update-launcher.exe'),
        ['--verify-preview-signature',Buffer.from(canonicalManifestBytes(manifest)).toString('base64'),manifest.signature.value],{windowsHide:true,timeout:5000});
      assert.ifError(production.error);
      assert.equal(production.status,7,'distribution launcher must reject the public laboratory key');
    }
    fs.writeFileSync(path.join(root,'request.json'),JSON.stringify({...scenario,publicKey,fingerprint,context:{confirmed:true,scanState:'idle',expectedVersion:target,artifactPath:simulator,manifest}}));
    if(scenario.nativeRejection==='registration') ps(`Set-ItemProperty -LiteralPath ${quote(registry)} -Name DisplayVersion -Value '0.0.0-rc.1'`);
    const child=spawn(path.join(installed,'CyberSafe Assistant.exe'),['--import','tsx',path.join(repo,'packages/desktop/test/fixtures/preview-handoff-parent.mjs'),root],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
    assert.equal(exit,scenario.abort?1:0,output);
    if(scenario.nativeRejection){console.log('PASS native refusal '+scenario.nativeRejection);continue;}
    const journal=JSON.parse(fs.readFileSync(path.join(root,'operation.json')));
    const deadline=Date.now()+15000;let result;
    do{if(fs.existsSync(journal.handoffResult)){result=JSON.parse(fs.readFileSync(journal.handoffResult));if(result.stage==='awaiting-start'||result.stage==='recovery-required')break;}await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
    assert.equal(result?.stage,scenario.exitCode===0&&!scenario.abort?'awaiting-start':'recovery-required');
    if(!scenario.abort)assert.equal(result.installerExit,scenario.exitCode);
    fs.renameSync(path.join(root,'operation.json'),path.join(root,`operation-${scenario.exitCode}-${Boolean(scenario.abort)}.json`));
    console.log('PASS native Preview LAB '+JSON.stringify(scenario));
  }
}finally{
  if(created)ps(`Remove-Item -LiteralPath ${quote(registry)} -ErrorAction Stop; Remove-Item -LiteralPath ${quote(installRegistry)} -ErrorAction Stop`);
}
console.log('LAB evidence: '+root);
