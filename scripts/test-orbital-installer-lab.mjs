import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {LangConfigurator,createAddLangsMacro,addCustomMessageFileInclude} from 'app-builder-lib/out/targets/nsis/nsisLang.js';
import {NsisScriptGenerator} from 'app-builder-lib/out/targets/nsis/nsisScriptGenerator.js';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='win32') throw Error('Native Windows laboratory required');
const out=path.join(root,'output/orbital-backend-lab');
fs.mkdirSync(out,{recursive:true});
const run=fs.mkdtempSync(path.join(out,'run-'));
const compiler=path.join(process.env.ELECTRON_BUILDER_NSIS_DIR??path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1'),'Bin/makensis.exe');
const resources=process.env.CYBERSAFE_TEST_NSIS_RESOURCES_DIR??path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-resources-3.4.1');
const templates=path.join(root,'node_modules/app-builder-lib/templates/nsis');
const win=p=>p.replaceAll('/','\\');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const payload=path.join(run,'benign.txt');
fs.writeFileSync(payload,'CyberSafe Orbital B embedded frontend LAB. Benign fixture; NOT the application.\r\n'.repeat(1024));
const fixtures=[];
for(const mode of ['success','error','cancel','invalid','occupied','wrongname','tampered','corrupt','quit','unverified','silent']) {
 const dir=path.join(run,mode);fs.mkdirSync(dir);
 const gen=new NsisScriptGenerator();
 gen.addIncludeDir(win(templates));gen.addIncludeDir(win(path.join(templates,'include')));
 gen.addPluginDir('x86-unicode',win(path.join(resources,'plugins/x86-unicode')));
 gen.include(win(path.join(templates,'include/StdUtils.nsh')));gen.flags(['updated','allusers','currentuser']);
 const config=new LangConfigurator({}); createAddLangsMacro(gen,config);
 let n=0;const packager={getTempFile:async()=>path.join(dir,`messages-${n++}.nsh`)};
 await addCustomMessageFileInclude('messages.yml',packager,gen,config);
 const exe=path.join(dir,'orbital-embedded-lab.exe');
 // User changes from offered default to another exact target; guard expects that.
 const initial=path.join(dir,'offered','CyberSafe-Orbital-LAB');
 const target=path.join(dir,'selected',mode==='wrongname'?'Unrelated-Documents':'CyberSafe-Orbital-LAB');
 if(mode==='occupied'){fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'preserve.txt'),'Unrelated existing data; must never be installed over.');}
 const reference=path.join(dir,'reference'); fs.mkdirSync(reference);
 for(let i=0;i<20;i++) fs.copyFileSync(payload,path.join(reference,`benign-${i}.txt`));
 const source=`Unicode true
ManifestDPIAware true
RequestExecutionLevel user
Name "CyberSafe Orbital B — LAB (nao instala a aplicacao)"
OutFile "${win(exe)}"
!define BUILD_RESOURCES_DIR "${win(path.join(root,'packages/desktop/build'))}"
!define VERSION "0.2.0-rc.1-LAB"
!define APP_FILENAME "CyberSafe-Orbital-LAB"
!define UNINSTALL_REGISTRY_KEY "Software\\CyberSafeOrbitalFixtureNeverRegistered"
!define CS_ORBITAL_LAB
!define CS_ORBITAL_LAB_PAYLOAD "${win(reference)}"
${gen.build()}
!include "${win(path.join(root,'packages/desktop/build/installer/orbital-installer.nsh'))}"
!include MUI2.nsh
!insertmacro MUI_PAGE_INSTFILES
!insertmacro addLangs
Function .onInit
 StrCpy $INSTDIR "${win(mode==='silent'?target:initial)}"
 !insertmacro customInit
FunctionEnd
Section "Benign extraction only"
 ${mode==='tampered'?`StrCpy $INSTDIR "${win(initial)}"`:''}
 FileOpen $9 "${win(path.join(dir,'section-trace.txt'))}" w
 FileWrite $9 "actual=$INSTDIR$\\r$\\nexpected=${win(target)}$\\r$\\nsaved=$CSOrbitalSavedDir$\\r$\\ndesktop=$CSOrbitalDesktop menu=$CSOrbitalMenu$\\r$\\n"
 FileClose $9
 StrCmp $INSTDIR "${win(target)}" +2
 Abort "LAB guard: selected destination not propagated."
 SetOutPath "$INSTDIR"
 ${Array.from({length:20},(_,i)=>`File "/oname=benign-${i}.txt" "${win(payload)}"\n Sleep 100`).join('\n')}
 ${mode==='corrupt'?'FileOpen $9 "$INSTDIR\\\\benign-0.txt" w\nFileWrite $9 "corrupt fixture"\nFileClose $9':''}
 ${mode==='error'?'Abort "LAB: deliberate engine failure after benign extraction."':mode==='quit'?'Quit':mode==='unverified'?'DetailPrint "Deliberately omit completion proof"':'!insertmacro customInstall'}
SectionEnd
`;
 const nsi=path.join(dir,'embedded.nsi');fs.writeFileSync(nsi,source);
 const result=spawnSync(compiler,['/NOCONFIG','/INPUTCHARSET','UTF8','/V3',nsi],{cwd:templates,encoding:'utf8',windowsHide:true,timeout:30000});
 fs.writeFileSync(path.join(dir,'compile.log'),(result.stdout??'')+(result.stderr??''));
 if(result.status!==0) throw Error(`NSIS ${mode}: ${result.error?.message??result.status}; see ${dir}/compile.log`);
 fixtures.push({mode,exe,initial,target,bytes:fs.statSync(exe).size,sha256:sha(exe)});
}
const manifest={run,scope:'embedded original Orbital B, production hooks; benign payload only, NOT a release candidate',payloadSha256:sha(payload),pluginSha256:sha(path.join(root,'packages/desktop/build/x86-unicode/OrbitalSetup.dll')),fixtures};
fs.writeFileSync(path.join(out,'latest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
