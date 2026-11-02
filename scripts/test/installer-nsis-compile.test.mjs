import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {LangConfigurator,createAddLangsMacro,addCustomMessageFileInclude} from 'app-builder-lib/out/targets/nsis/nsisLang.js';
import {NsisScriptGenerator} from 'app-builder-lib/out/targets/nsis/nsisScriptGenerator.js';

const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const explicitCompilerDir=process.env.ELECTRON_BUILDER_NSIS_DIR?.trim();
const compiler=explicitCompilerDir
 ? path.join(explicitCompilerDir,'Bin/makensis.exe')
 : path.join(process.env.LOCALAPPDATA??'', 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const resources=process.env.CYBERSAFE_TEST_NSIS_RESOURCES_DIR?.trim()
 ?? path.join(process.env.LOCALAPPDATA??'', 'electron-builder/Cache/nsis/nsis-resources-3.4.1');
const evidenceDir=path.join(root,'output/nsis-contract');
const templates=path.join(root,'node_modules/app-builder-lib/templates/nsis');
const win=p=>p.replaceAll('/','\\');

for (const mode of ['per-user','with-license','all-users']) {
 test(`production hooks compile with electron-builder assisted pages: ${mode}`, {
  skip:!explicitCompilerDir&&!fs.existsSync(compiler), timeout:30000,
 },async t=>{
  assert.ok(fs.existsSync(compiler),`NSIS compiler missing: ${compiler}`);
  assert.ok(fs.existsSync(path.join(resources,'plugins/x86-unicode/UAC.dll')),'set CYBERSAFE_TEST_NSIS_RESOURCES_DIR to electron-builder nsis-resources-3.4.1');
  fs.mkdirSync(evidenceDir,{recursive:true});
  const dir=fs.mkdtempSync(path.join(evidenceDir,'compile-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'packages/desktop/package.json'),'utf8'));
  const generator=new NsisScriptGenerator();
  const config=new LangConfigurator(pkg.build.nsis);
  generator.addIncludeDir(win(templates));
  generator.addIncludeDir(win(path.join(templates,'include')));
  generator.addPluginDir('x86-unicode',win(path.join(resources,'plugins/x86-unicode')));
  generator.include(win(path.join(templates,'include/StdUtils.nsh')));
  generator.flags(['updated','allusers','currentuser']);
  createAddLangsMacro(generator,config);
  let message=0;
  const packager={getTempFile:async()=>path.join(dir,`messages-${message++}.nsh`)};
  await addCustomMessageFileInclude('messages.yml',packager,generator,config);
  await addCustomMessageFileInclude('assistedMessages.yml',packager,generator,config);
  const source=`Unicode true
RequestExecutionLevel user
OutFile "${win(path.join(dir,'contract.exe'))}"
!define BUILD_RESOURCES_DIR "${win(path.join(root,'packages/desktop/build'))}"
!define VERSION "0.0.0-contract"
!define PRODUCT_NAME "CyberSafe-contract"
!define APP_FILENAME "CyberSafe-contract"
!define PRODUCT_FILENAME "CyberSafe-contract"
!define MENU_FILENAME "CyberSafe-contract"
!define APP_GUID "CyberSafeContractNeverExecuted"
!define UNINSTALL_APP_KEY "CyberSafeContractNeverExecuted"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
${mode==='all-users'?'!define INSTALL_MODE_PER_ALL_USERS':''}
Var newStartMenuLink
Var newDesktopLink
Var launchLink
${generator.build()}
!include "${win(path.join(root,'packages/desktop/build/installer/cybersafe-installer.nsh'))}"
!include common.nsh
!include MUI2.nsh
!include "${win(path.join(templates,'multiUser.nsh'))}"
${mode==='with-license'?`!macro licensePage
 !insertmacro MUI_PAGE_LICENSE "${win(path.join(root,'assets/licenses/THIRD-PARTY-NOTICES.txt'))}"
!macroend`:''}
!include assistedInstaller.nsh
!insertmacro addLangs
!insertmacro customHeader
Section
 ; Real shortcut hook; compiler-only binary is NEVER executed.
 !insertmacro customInstall
SectionEnd
`;
  fs.writeFileSync(path.join(dir,'contract.nsi'),source);
  const result=spawnSync(compiler,['/NOCONFIG','/INPUTCHARSET','UTF8','/V4',path.join(dir,'contract.nsi')],{encoding:'utf8',timeout:25000,windowsHide:true,cwd:templates});
  const log=(result.stdout??'')+(result.stderr??'')+(result.error?.message??'');
  fs.writeFileSync(path.join(evidenceDir,`compile-${mode}.log`),log);
  assert.equal(result.status,0,log);
  assert.doesNotMatch(log,/warning 6040:/,'all production languages must have their MUI strings');
  if (mode !== 'all-users') assert.match(log,/Call "CS_InstallModeShow"/,'builder must consume the theme callback');
  assert.ok(fs.statSync(path.join(dir,'contract.exe')).size>0);
  // No application payload, install, screenshots or candidate claim.
 });
}
