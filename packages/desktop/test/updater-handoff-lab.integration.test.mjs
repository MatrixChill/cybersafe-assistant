import {lockPreparedArtifact,createWindowsInstaller} from '../src/updater/windows-installer.ts';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {canonicalManifestBytes,validateManifest} from '../src/updater/manifest.ts';import {fingerprintFromPublicKey} from '../src/updater/crypto.ts';import {UpdateJournal} from '../src/updater/install-journal.ts';
const REPO_ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const launcher=path.join(REPO_ROOT,'packages/native-engine/build/Release/cybersafe-update-launcher.exe');
const simulator=path.join(REPO_ROOT,'output/handoff-lab/simulator-build/Release/benign-installer.exe');
test('real helper outlives laboratory parent, executes inert simulator and records unconfirmed result',{skip:process.platform!=='win32'||!fs.existsSync(simulator),timeout:45000},async()=>{
 for(const exitCode of [0,7]){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cs-handoff-e2e-'));
 // Evidence directory retained for review; no personal data or setup executable.
 const pair=generateKeyPairSync('ed25519'),fingerprint=fingerprintFromPublicKey(pair.publicKey),bytes=fs.readFileSync(simulator);
 const raw={schema:'cybersafe-release/1',channel:'stable',version:'0.2.0',publishedAt:'2026-11-03T00:00:00Z',notes:'Inert simulator',file:{url:'https://github.com/MatrixChill/cybersafe-assistant/releases/download/lab/simulator.exe',sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length},signature:{algorithm:'ed25519',value:'AAAA',signedByFingerprint:fingerprint},publisher:{name:'LABORATORY SIMULATOR'}};
 const parsed=validateManifest(raw);assert.equal(parsed.ok,true);const manifest=parsed.manifest;manifest.signature.value=sign(null,Buffer.from(canonicalManifestBytes(manifest)),pair.privateKey).toString('base64');
 fs.writeFileSync(path.join(root,'database.fixture'),'unchanged user data');
 fs.writeFileSync(path.join(root,'request.json'),JSON.stringify({exitCode,publicKey:pair.publicKey.export({type:'spki',format:'pem'}),fingerprint,context:{confirmed:true,scanState:'idle',artifactPath:simulator,manifest,expectedVersion:'0.2.0'}}));
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/updater-handoff-parent.mjs',import.meta.url)),root],{cwd:REPO_ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});assert.equal(exit,0,output);
 const journal=new UpdateJournal(path.join(root,'operation.json'));const deadline=Date.now()+15000;let operation;
 do{operation=journal.reconcileHandoff();if(operation?.stage==='awaiting-start'||operation?.stage==='recovery-required')break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
 assert.equal(operation?.stage,exitCode===0?'awaiting-start':'recovery-required');assert.equal(fs.readFileSync(path.join(root,'database.fixture'),'utf8'),'unchanged user data');assert.ok(fs.existsSync(path.join(root,'shutdown-ready')));
 if(exitCode===0)assert.equal(journal.confirmStartup(operation.id,operation.startupToken,'0.1.0',true).stage,'recovery-required');
 console.log('LABORATORY evidence: '+root);
 }
});

test('real Windows helper holds native file/ancestor locks; abort never executes fixture',{skip:process.platform!=='win32',timeout:40000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cs-lock-proof-'));const stage=path.join(root,'stage');fs.mkdirSync(stage);const artifact=path.join(stage,'installer.exe');const bytes=Buffer.from('Not an executable: read-lock fixture only');fs.writeFileSync(artifact,bytes);
 let helper;
 try{
 helper=await lockPreparedArtifact(stage,'lock-proof',false,launcher);
 assert.equal(helper.locked.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal(helper.locked.size,bytes.length);
 assert.throws(()=>fs.writeFileSync(artifact,'replacement'));
 assert.throws(()=>fs.renameSync(artifact,path.join(stage,'swapped.exe')));
 assert.throws(()=>fs.renameSync(stage,path.join(root,'swapped-stage')));
 }finally{
 await helper?.abort();
 for(const file of fs.readdirSync(stage))fs.unlinkSync(path.join(stage,file));fs.rmdirSync(stage);fs.rmdirSync(root);
 }
});

test('real locked staging rejects tamper, wrong publisher, consent withdrawal and shutdown failure',{skip:process.platform!=='win32'||!fs.existsSync(simulator),timeout:45000},async()=>{
 for(const scenario of ['hash','publisher','consent','shutdown']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cs-handoff-refusal-'));const source=path.join(root,'source.exe');const bytes=Buffer.from('Inert non-executable staging fixture');fs.writeFileSync(source,bytes);
 const raw={schema:'cybersafe-release/1',channel:'stable',version:'0.2.0',publishedAt:'2026-11-03T00:00:00Z',notes:'Refusal fixture',file:{url:'https://github.com/MatrixChill/cybersafe-assistant/releases/download/lab/simulator.exe',sha256:scenario==='hash'?'a'.repeat(64):createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length},signature:{algorithm:'ed25519',value:'AAAA',signedByFingerprint:'a'.repeat(64)},publisher:{name:'LABORATORY SIMULATOR'}};
 const parsed=validateManifest(raw);assert.equal(parsed.ok,true);let consent=0,shutdown=0,authorizations=0;
 const adapter=createWindowsInstaller({stagingRoot:path.join(root,'staging'),journalFile:path.join(root,'operation.json'),launcherPath:launcher,expectedPublisher:'LABORATORY SIMULATOR',authorizeExecution:()=>scenario!=='consent'||++authorizations===1,confirmConsent:async()=>{consent++;return true},signatureVerifier:{verify:async()=>({ok:true})},publisherVerifier:{verify:async artifact=>{assert.throws(()=>fs.writeFileSync(artifact,'swapped'));return {ok:scenario!=='publisher'}}},requestShutdown:async()=>{shutdown++;throw Error('controlled shutdown refusal; parent never exits')}});
 const result=await adapter.install({confirmed:true,expectedVersion:'0.2.0',scanState:'idle',artifactPath:source,manifest:parsed.manifest});assert.equal(result.ok,false);assert.equal(consent,1,`${scenario}: exactly one native consent prompt`);assert.equal(shutdown,scenario==='shutdown'?1:0);assert.deepEqual(fs.readFileSync(source),bytes);
 if(scenario==='shutdown')assert.equal(new UpdateJournal(path.join(root,'operation.json')).read().stage,'recovery-required');
 }
});
