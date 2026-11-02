import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const root=process.cwd();
const compiler=path.join(process.env.LOCALAPPDATA??'', 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
test('production NSIS hooks compile against MUI without application payload or installation', {skip:!fs.existsSync(compiler)},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cybersafe-nsis-contract-'));
 const appDir=path.join(dir,'app');
 fs.mkdirSync(appDir,{recursive:true});
 const source=`Unicode true
RequestExecutionLevel user
Name "CyberSafe compile contract — not a candidate"
OutFile "${dir}/contract.exe"
!define BUILD_RESOURCES_DIR "${root}/packages/desktop/build"
!define PROJECT_DIR "${appDir}"
!define VERSION "0.0.0-contract"
!define APP_FILENAME "CyberSafe-contract"
!define PRODUCT_FILENAME "CyberSafe-contract"
!define UNINSTALL_REGISTRY_KEY "Software\\CyberSafeContractNeverExecuted"
Var newStartMenuLink
Var newDesktopLink
Var launchLink
!include LogicLib.nsh
!macro ContractShell OUT FILE VERB ARGS
 StrCpy \${OUT} "compile-only"
!macroend
!define StdUtils.ExecShellAsUser "!insertmacro ContractShell"
!macro isUpdated OUT
 StrCpy \${OUT} 0
!macroend
!define isUpdated \`\u0022\u0022 == \u0022updated\u0022\`
!include "${root}/packages/desktop/build/installer/cybersafe-installer.nsh"
!include MUI2.nsh
!insertmacro customWelcomePage
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "Portuguese"
!insertmacro customHeader
Section
 ; No application files, no service, no registry and no launch.
SectionEnd
`;
 fs.writeFileSync(path.join(dir,'contract.nsi'),source.replaceAll('/', '\\'));
 const result=spawnSync(compiler,['/V2',path.join(dir,'contract.nsi')],{encoding:'utf8'});
 fs.writeFileSync(path.join(root,'output/setup-refined-20261102/nsis-contract-compile.log'),result.stdout+result.stderr);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.ok(fs.statSync(path.join(dir,'contract.exe')).size>0);
 // Compiler-only artifact is never executed, distributed or treated as payload proof.
 fs.rmSync(dir,{recursive:true,force:true});
});
