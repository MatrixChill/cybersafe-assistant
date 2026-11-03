import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../vm-acceptance-preflight.ps1',import.meta.url));
test('VM preflight refuses mismatched hash/version before host collection, without executing an installer',{skip:process.platform!=='win32'},()=>{
 const root=mkdtempSync(path.join(tmpdir(),'cs-preflight-refusal-'));
 try{
  const fixture=path.join(root,'inert.txt'),out=path.join(root,'evidence.json');
  writeFileSync(fixture,'not executable');
  const run=(hash,version)=>spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-InstallerPath',fixture,'-OutFile',out,'-ExpectedVersion',version,'-ExpectedSha256',hash],{encoding:'utf8',windowsHide:true,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')}});
  const hashFailure=run('0'.repeat(64),'0.2.0-rc.1');
  assert.notEqual(hashFailure.status,0);assert.match(hashFailure.stderr,/SHA-256 divergente/);
  const versionFailure=run(createHash('sha256').update('not executable').digest('hex'),'invalid-version');
  assert.notEqual(versionFailure.status,0);assert.match(versionFailure.stderr,/PRODUCT_VERSION_MISMATCH/);
  assert.equal(existsSync(out),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
