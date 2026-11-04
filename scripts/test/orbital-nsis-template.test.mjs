import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {LangConfigurator,createAddLangsMacro,addCustomMessageFileInclude} from 'app-builder-lib/out/targets/nsis/nsisLang.js';
import {NsisScriptGenerator} from 'app-builder-lib/out/targets/nsis/nsisScriptGenerator.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const compiler=path.join(process.env.ELECTRON_BUILDER_NSIS_DIR??path.join(process.env.LOCALAPPDATA??'','electron-builder/Cache/nsis/nsis-3.0.4.1'),'Bin/makensis.exe');
const resources=process.env.CYBERSAFE_TEST_NSIS_RESOURCES_DIR??path.join(process.env.LOCALAPPDATA??'','electron-builder/Cache/nsis/nsis-resources-3.4.1');
const templates=path.join(root,'node_modules/app-builder-lib/templates/nsis');
const win=p=>p.replaceAll('/','\\');
for(const mode of ['per-user','all-users','uninstaller']) {
 test(`complete electron-builder template with embedded Orbital: ${mode}`,{skip:process.platform!=='win32',timeout:30000},async()=>{
  const out=path.join(root,'output/orbital-template-contract');fs.mkdirSync(out,{recursive:true});
  const dir=fs.mkdtempSync(path.join(out,`${mode}-`));
  const gen=new NsisScriptGenerator();
  gen.addIncludeDir(win(templates));gen.addIncludeDir(win(path.join(templates,'include')));
  gen.addPluginDir('x86-unicode',win(path.join(resources,'plugins/x86-unicode')));
  gen.include(win(path.join(templates,'include/StdUtils.nsh')));gen.flags(['updated','force-run','keep-shortcuts','no-desktop-shortcut','delete-app-data','allusers','currentuser']);
  const config=new LangConfigurator({});createAddLangsMacro(gen,config);
  let index=0;const packager={getTempFile:async()=>path.join(dir,`messages-${index++}.nsh`)};
  await addCustomMessageFileInclude('messages.yml',packager,gen,config);
  await addCustomMessageFileInclude('assistedMessages.yml',packager,gen,config);
  const payload=path.join(dir,'benign.7z'),uninstaller=path.join(dir,'uninstaller-fixture.exe');
  // Compiler-only inputs. Neither these nor the resulting Setup is executed.
  fs.writeFileSync(payload,'benign compiler fixture, not an archive to execute');
  fs.writeFileSync(uninstaller,'MZ compiler fixture, not executable');
  const nsi=path.join(dir,'contract.nsi');
  fs.writeFileSync(nsi,`Unicode true
OutFile "${win(path.join(dir,'contract-never-executed.exe'))}"
!define BUILD_RESOURCES_DIR "${win(path.join(root,'packages/desktop/build'))}"
!define PROJECT_DIR "${win(dir)}"
!define APP_ID "com.cybersafe.orbital.compile-only"
!define APP_GUID "CyberSafeOrbitalCompileNeverExecuted"
!define UNINSTALL_APP_KEY "CyberSafeOrbitalCompileNeverExecuted"
!define PRODUCT_NAME "CyberSafe Orbital compile-only"
!define PRODUCT_FILENAME "CyberSafe-Orbital-compile-only"
!define APP_FILENAME "CyberSafe-Orbital-compile-only"
!define APP_DESCRIPTION "Compiler contract only"
!define APP_PACKAGE_NAME "cybersafe-orbital-contract"
!define APP_INSTALLER_STORE_FILE "cybersafe-orbital-contract.exe"
!define SHORTCUT_NAME "CyberSafe Orbital compile-only"
!define UNINSTALL_DISPLAY_NAME "CyberSafe Orbital compile-only"
!define VERSION "0.2.0-rc.1"
!define APP_64 "${win(payload)}"
!define APP_64_UNPACKED_SIZE 1000
!define UNINSTALLER_OUT_FILE "${win(uninstaller)}"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define COMPRESSION_METHOD "7z"
${mode==='all-users'?'!define INSTALL_MODE_PER_ALL_USERS':''}
${mode==='uninstaller'?'!define BUILD_UNINSTALLER':''}
${gen.build()}
!include "${win(path.join(root,'packages/desktop/build/installer/orbital-installer.nsh'))}"
!include "${win(path.join(templates,'installer.nsi'))}"
`);
  const result=spawnSync(compiler,['/NOCONFIG','/INPUTCHARSET','UTF8','/V3','-'],{input:fs.readFileSync(nsi,'utf8'),cwd:templates,encoding:'utf8',windowsHide:true,timeout:25000});
  const log=(result.stdout??'')+(result.stderr??'')+(result.error?.message??'');
  fs.writeFileSync(path.join(dir,'compile.log'),log);
  assert.equal(result.status,0,log);
  assert.doesNotMatch(log,/warning 6040|warning 6000|warning 6010/,'no undefined language strings, unknown variables or unreferenced callbacks');
  assert.ok(fs.statSync(path.join(dir,'contract-never-executed.exe')).size>0);
 });
}
