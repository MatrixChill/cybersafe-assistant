import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,lstat,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
// Run only with the installed Electron in an explicitly disposable Arch lab.
// This checks packaged service/filesystem behaviour, not detection or the UI.
if (process.platform !== 'linux' || process.getuid() === 0 || process.argv[2] !== '--disposable-fixture') {
 console.error('Use o Electron instalado, sem privilégios, com --disposable-fixture num laboratório descartável.');
 process.exit(2);
}
const {ProtectionEngineService}=await import('/opt/cybersafe-assistant-linux-lite/resources/app.asar/node_modules/@cybersafe/service/dist/engine.js');
const root=await mkdtemp(join(tmpdir(),'cs-installed-quarantine-'));
const base=join(root,'service');
const file=join(root,'benign-fixture.txt');
await mkdir(base);
const engine=new ProtectionEngineService(base);
try {
 await mkdir(join(base,'logs'));
 await engine.quarantine.init();
 const content=Buffer.from('Benign disposable quarantine and restore acceptance fixture.');
 const digest=createHash('sha256').update(content).digest('hex');
 await writeFile(file,content,{mode:0o600});
 const events=[];engine.eventBus.on('event',e=>events.push(e.type));
 // Synthetic positive result: this tests containment, not malware detection.
 const analysis={artifactPath:file,fileName:'benign-fixture.txt',sha256:digest,size:content.length,
 verdict:'malicious',severity:'critical',riskScore:100,confidence:1,rulesTriggered:['known_bad_hash'],
 factors:[],recommendedAction:'quarantined',scanTimestamp:new Date().toISOString()};
 assert.equal((await engine.requestQuarantine(analysis,'manual')).success,true);
 await assert.rejects(stat(file),{code:'ENOENT'});
 const entry=engine.quarantine.list()[0];
 assert.equal(entry.isolationStatus,'confirmed');
 assert.equal((await lstat(entry.quarantinePath)).mode & 0o777,0);
 await writeFile(file,'Replacement must survive',{mode:0o600});
 assert.equal((await engine.restoreQuarantine(entry.id,false)).success,false);
 assert.equal(await readFile(file,'utf8'),'Replacement must survive');
 await unlink(file);
 assert.equal((await engine.restoreQuarantine(entry.id,false)).success,true);
 assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),digest);
 assert.equal((await lstat(file)).mode & 0o777,0o600);
 assert.ok(events.includes('quarantine.added'));
 assert.ok(events.includes('quarantine.restored'));
} finally {
 await engine.dispose();
 // Keep the fixture and audit files: log writers may finish after dispose.
 // Deleting here races those writes and would destroy useful test evidence.
 console.log('Disposable fixture and audit retained:',root);
}
console.log('INSTALLED_QUARANTINE_RESTORE: PASS; replacement preserved, SHA-256 and permissions verified; synthetic positive fixture only');
