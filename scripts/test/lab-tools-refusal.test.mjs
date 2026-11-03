import {test} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('VM-only tools refuse before certificate, signing, benchmark or VM actions',{skip:process.platform!=='win32'},()=>{
 for(const name of ['lab-sign-artifact.ps1','vm-scanner-benchmark.ps1']){
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts',name)],{encoding:'utf8',windowsHide:true,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','Modules')}});
 assert.notEqual(result.status,0);assert.match(result.stderr,/LAB_EXECUTION_NOT_AUTHORIZED/,name);
 }
});
