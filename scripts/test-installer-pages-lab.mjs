import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {LangConfigurator,createAddLangsMacro,addCustomMessageFileInclude} from 'app-builder-lib/out/targets/nsis/nsisLang.js';
import {NsisScriptGenerator} from 'app-builder-lib/out/targets/nsis/nsisScriptGenerator.js';

const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='win32')throw Error('Native Windows NSIS laboratory required');
const out=path.join(root,'output/installer-pages-lab');
const run=fs.mkdtempSync((fs.mkdirSync(out,{recursive:true}),path.join(out,'run-')));
const compiler=path.join(process.env.ELECTRON_BUILDER_NSIS_DIR??path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1'),'Bin/makensis.exe');
const resources=process.env.CYBERSAFE_TEST_NSIS_RESOURCES_DIR??path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-resources-3.4.1');
const templates=path.join(root,'node_modules/app-builder-lib/templates/nsis');
const win=p=>p.replaceAll('/','\\');
const payload=path.join(run,'benign.txt');
fs.writeFileSync(payload,'CyberSafe Orbital B native page fixture. No application installation.\r\n'.repeat(1024));
for(const mode of ['success','error','cancel']){
 const dir=path.join(run,mode);fs.mkdirSync(dir);
 const gen=new NsisScriptGenerator();
 gen.addIncludeDir(win(templates));gen.addIncludeDir(win(path.join(templates,'include')));
 gen.addPluginDir('x86-unicode',win(path.join(resources,'plugins/x86-unicode')));
 gen.include(win(path.join(templates,'include/StdUtils.nsh')));gen.flags(['updated','allusers','currentuser']);
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'packages/desktop/package.json'),'utf8'));
 const langs=new LangConfigurator(pkg.build.nsis);createAddLangsMacro(gen,langs);
 let n=0;const packager={getTempFile:async()=>path.join(dir,`messages-${n++}.nsh`)};
 await addCustomMessageFileInclude('messages.yml',packager,gen,langs);
 await addCustomMessageFileInclude('assistedMessages.yml',packager,gen,langs);
 const exe=path.join(dir,'orbital-pages-lab.exe');
 const target=path.join(dir,'fixture-output');
 const source=`Unicode true
ManifestDPIAware true
RequestExecutionLevel user
Name "CyberSafe Orbital B — LAB (não instala a aplicação)"
Caption "CyberSafe Orbital B — LAB ${mode}"
OutFile "${win(exe)}"
!define BUILD_RESOURCES_DIR "${win(path.join(root,'packages/desktop/build'))}"
!define VERSION "0.2.0-rc.1-LAB"
!define PRODUCT_NAME "CyberSafe-Orbital-LAB"
!define APP_FILENAME "CyberSafe-Orbital-LAB"
!define PRODUCT_FILENAME "CyberSafe-Orbital-LAB"
!define APP_GUID "CyberSafeOrbitalBenignPagesOnly"
!define UNINSTALL_APP_KEY "CyberSafeOrbitalBenignPagesOnly"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define HIDE_RUN_AFTER_FINISH
Var newStartMenuLink
Var newDesktopLink
Var launchLink
${gen.build()}
!include "${win(path.join(root,'packages/desktop/build/installer/cybersafe-installer.nsh'))}"
!include common.nsh
!include MUI2.nsh
!include "${win(path.join(templates,'multiUser.nsh'))}"
!include assistedInstaller.nsh
!insertmacro addLangs
!insertmacro customHeader
Function .onInit
 StrCpy $LANGUAGE 2070
 ; No registry, shortcut, service, app payload or personal install destination.
 StrCpy $INSTDIR "${win(target)}\\CyberSafe-Orbital-LAB"
FunctionEnd
Section "Benign file extraction only"
 StrCmp $INSTDIR "${win(target)}\\CyberSafe-Orbital-LAB" +2
 Abort "LAB destination changed; refused: $INSTDIR"
 SetOutPath "$INSTDIR"
 ${Array.from({length:20},(_,i)=>`File "/oname=benign-${i}.txt" "${win(payload)}"\n Sleep 150`).join('\n')}
 ${mode==='error'?'Abort "LAB: falha deliberada após extração benigna; não é uma instalação concluída."':'DetailPrint "LAB: extração benigna concluída; aplicação não instalada."'}
SectionEnd
`;
 const nsi=path.join(dir,'pages.nsi');fs.writeFileSync(nsi,source);
 const result=spawnSync(compiler,['/NOCONFIG','/INPUTCHARSET','UTF8','/V4',nsi],{cwd:templates,encoding:'utf8',windowsHide:true,timeout:30000});
 fs.writeFileSync(path.join(dir,'compile.log'),(result.stdout??'')+(result.stderr??''));
 if(result.status!==0)throw Error(`NSIS ${mode}: ${result.error?.message??result.status}; see ${dir}/compile.log`);
 console.log(JSON.stringify({mode,exe,target,bytes:fs.statSync(exe).size}));
}
fs.writeFileSync(path.join(out,'latest.json'),JSON.stringify({run,scope:'production page hooks; benign files only; not a candidate or installed app'},null,2));
console.log('LAB_READY '+run);
