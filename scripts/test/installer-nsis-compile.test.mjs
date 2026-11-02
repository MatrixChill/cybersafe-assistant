import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {LangConfigurator,createAddLangsMacro} from 'app-builder-lib/out/targets/nsis/nsisLang.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const explicitCompilerDir=process.env.ELECTRON_BUILDER_NSIS_DIR?.trim();
const compiler=explicitCompilerDir
 ? path.join(explicitCompilerDir,'Bin/makensis.exe')
 : path.join(process.env.LOCALAPPDATA??'', 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const evidenceDir=path.join(root,'output/nsis-contract');

test('production NSIS hooks compile against MUI without application payload or installation', {
 skip:!explicitCompilerDir&&!fs.existsSync(compiler), timeout:30000,
},t=>{
 assert.ok(fs.existsSync(compiler),`NSIS compiler missing: ${compiler}`);
 fs.mkdirSync(evidenceDir,{recursive:true});
 const dir=fs.mkdtempSync(path.join(evidenceDir,'compile-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const appDir=path.join(dir,'app');
 fs.mkdirSync(appDir,{recursive:true});
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'packages/desktop/package.json'),'utf8'));
 let languages;
 createAddLangsMacro({macro(_name,lines){languages=lines.join('\n');}},new LangConfigurator(pkg.build.nsis));
 const source=`Unicode true
RequestExecutionLevel user
Name "CyberSafe compile contract — not a candidate"
OutFile "${dir}/contract.exe"
!define BUILD_RESOURCES_DIR "${root}/packages/desktop/build"
!define PROJECT_DIR "${appDir}"
!define VERSION "0.0.0-contract"
!define APP_FILENAME "CyberSafe-contract"
!define PRODUCT_FILENAME "CyberSafe-contract"
!define MENU_FILENAME "CyberSafe-contract"
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
${languages}
!insertmacro customHeader
Section
 ; Compile the real shortcut hook too; this binary is NEVER executed.
 !insertmacro customInstall
SectionEnd
`;
 fs.writeFileSync(path.join(dir,'contract.nsi'),source.replaceAll('/', '\\'));
 const result=spawnSync(compiler,['/NOCONFIG','/INPUTCHARSET','UTF8','/V3',path.join(dir,'contract.nsi')],{encoding:'utf8',timeout:25000,windowsHide:true});
 const log=(result.stdout??'')+(result.stderr??'')+(result.error?.message??'');
 fs.writeFileSync(path.join(evidenceDir,'compile.log'),log);
 assert.equal(result.status,0,log);
 assert.doesNotMatch(log,/warning 6040:/,'every production language must have its MUI strings');
 assert.ok(fs.statSync(path.join(dir,'contract.exe')).size>0);
 // Compiler-only artifact is never executed, distributed or treated as payload proof.
});
