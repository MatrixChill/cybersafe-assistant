import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {path7za} from '7zip-bin';
import {LangConfigurator,createAddLangsMacro,addCustomMessageFileInclude} from 'app-builder-lib/out/targets/nsis/nsisLang.js';
import {NsisScriptGenerator} from 'app-builder-lib/out/targets/nsis/nsisScriptGenerator.js';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='win32') throw Error('Native Windows required');
const out=path.join(root,'output/orbital-full-lab');fs.mkdirSync(out,{recursive:true});
const dir=fs.mkdtempSync(path.join(out,'run-'));
const compiler=path.join(process.env.ELECTRON_BUILDER_NSIS_DIR??path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1'),'Bin/makensis.exe');
const resources=process.env.CYBERSAFE_TEST_NSIS_RESOURCES_DIR??path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-resources-3.4.1');
const templates=path.join(root,'node_modules/app-builder-lib/templates/nsis');
const win=p=>p.replaceAll('/','\\');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const name='CyberSafe-Orbital-Benign-LAB';
const id=`CyberSafeOrbitalBenign-${randomUUID()}`;
const initial=path.join(dir,'offered',name),target=path.join(dir,'selected',name);
const payloadDir=path.join(dir,'payload'),archive=path.join(dir,'benign.7z');
fs.mkdirSync(path.join(payloadDir,'resources'),{recursive:true});
// Disposable executable: records its own image path and exits.
const markerSource=path.join(dir,'open-marker.cs');
fs.writeFileSync(markerSource,`using System; using System.IO; using System.Reflection;
class Marker { static void Main() {
  string image = Assembly.GetExecutingAssembly().Location;
  File.WriteAllText(Path.Combine(Path.GetDirectoryName(image), "lab-opened.txt"), image);
} }`);
const csc=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const markerBuild=spawnSync(csc,['/nologo','/target:winexe',`/out:${path.join(payloadDir,`${name}.exe`)}`,markerSource],{encoding:'utf8',windowsHide:true});
if(markerBuild.status!==0) throw Error(`Marker compilation failed: ${markerBuild.stdout??''}${markerBuild.stderr??''}`);
fs.writeFileSync(path.join(payloadDir,'resources/app.asar'),'BENIGN LAB ASAR MARKER');
for(let i=0;i<20;i++) fs.writeFileSync(path.join(payloadDir,`benign-${i}.txt`),`Benign full-template file ${i}\r\n`.repeat(4096));
const zip=spawnSync(path7za,['a','-t7z',archive,'.'],{cwd:payloadDir,encoding:'utf8',windowsHide:true,timeout:30000});
fs.writeFileSync(path.join(dir,'archive.log'),(zip.stdout??'')+(zip.stderr??''));if(zip.status!==0)throw Error('Archive build failed');
const gen=new NsisScriptGenerator();
gen.addIncludeDir(win(path.join(templates,'include')));
gen.addPluginDir('x86-unicode',win(path.join(resources,'plugins/x86-unicode')));
gen.include(win(path.join(templates,'include/StdUtils.nsh')));
gen.flags(['updated','force-run','keep-shortcuts','no-desktop-shortcut','delete-app-data','allusers','currentuser']);
const config=new LangConfigurator({installerLanguages:['pt_PT']});createAddLangsMacro(gen,config);
let n=0;const packager={getTempFile:async()=>path.join(dir,`messages-${n++}.nsh`)};
await addCustomMessageFileInclude('messages.yml',packager,gen,config);
await addCustomMessageFileInclude('assistedMessages.yml',packager,gen,config);
const uninstaller=path.join(dir,'uninstaller-generated.exe'),exe=path.join(dir,'Orbital-B-Full-NSIS-LAB.exe');
const base=`Unicode true
ManifestDPIAware true
InstallDir "${win(initial)}"
!define BUILD_RESOURCES_DIR "${win(path.join(root,'packages/desktop/build'))}"
!define PROJECT_DIR "${win(dir)}"
!define APP_ID "com.cybersafe.orbital.benign-lab"
!define APP_GUID "${id}"
!define UNINSTALL_APP_KEY "${id}"
!define PRODUCT_NAME "${name}"
!define PRODUCT_FILENAME "${name}"
!define APP_FILENAME "${name}"
!define APP_DESCRIPTION "BENIGN LAB ONLY, NOT CYBERSAFE APPLICATION"
!define APP_PACKAGE_NAME "${id}"
!define APP_INSTALLER_STORE_FILE "${id}.exe"
!define SHORTCUT_NAME "${id}"
!define UNINSTALL_DISPLAY_NAME "${name}"
!define VERSION "0.2.0-rc.1-LAB"
!define APP_64 "${win(archive)}"
!define APP_64_UNPACKED_SIZE 2300
!define UNINSTALLER_OUT_FILE "${win(uninstaller)}"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define COMPRESSION_METHOD "7z"
!define DO_NOT_CREATE_DESKTOP_SHORTCUT
!define DO_NOT_CREATE_START_MENU_SHORTCUT
${gen.build()}
!macro customCheckAppRunning
 ; Fixture-only independent guard BEFORE uninstall/copy operations.
 StrCmp $INSTDIR "${win(target)}" +2
 Abort "LAB refused destination outside the exact selected output path."
!macroend
!include "${win(path.join(root,'packages/desktop/build/installer/orbital-installer.nsh'))}"
`;
function compile(source,label){
 fs.writeFileSync(path.join(dir,`${label}.nsi`),source);
 const result=spawnSync(compiler,['/NOCONFIG','/INPUTCHARSET','UTF8','/V3','-'],{input:source,cwd:templates,encoding:'utf8',windowsHide:true,timeout:30000});
 const log=(result.stdout??'')+(result.stderr??'');fs.writeFileSync(path.join(dir,`${label}.log`),log);
 if(result.status!==0 || /warning \d+:/.test(log)) throw Error(`Full-template ${label} failed; see ${dir}/${label}.log`);
}
compile(`OutFile "${win(path.join(dir,'generate-uninstaller.exe'))}"\n!define BUILD_UNINSTALLER\n${base}\n!include "${win(path.join(templates,'installer.nsi'))}"\n`,'uninstaller');
// Only execute the BUILD_UNINSTALLER stub: stock .onInit writes the uninstaller
// in this LAB directory and quits; its install section has no mutation code.
const generated=spawnSync(path.join(dir,'generate-uninstaller.exe'),[],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:15000});
if(generated.status!==0 || !fs.existsSync(uninstaller))throw Error('Uninstaller generation failed');
compile(`OutFile "${win(exe)}"\n${base}\n!include "${win(path.join(templates,'installer.nsi'))}"\n`,'installer');
const files=fs.readdirSync(payloadDir).filter(p=>p!=='resources').map(p=>({relative:p,sha256:sha(path.join(payloadDir,p))}));
files.push({relative:'resources/app.asar',sha256:sha(path.join(payloadDir,'resources/app.asar'))});
// Same unique product identity: B must find A's registered custom destination.
fs.writeFileSync(path.join(payloadDir,'benign-0.txt'),'Benign version B replaces version A.\r\n'.repeat(4096));
fs.writeFileSync(path.join(payloadDir,'resources/app.asar'),'BENIGN LAB ASAR MARKER VERSION B');
const archiveB=path.join(dir,'benign-B.7z'),exeB=path.join(dir,'Orbital-B-Full-NSIS-LAB-B.exe');
const zipB=spawnSync(path7za,['a','-t7z',archiveB,'.'],{cwd:payloadDir,encoding:'utf8',windowsHide:true,timeout:30000});
if(zipB.status!==0)throw Error('Version B archive failed');
const uninstallerB=path.join(dir,'uninstaller-generated-B.exe');
const baseB=base.replaceAll(win(archive),win(archiveB)).replaceAll(win(uninstaller),win(uninstallerB)).replaceAll('0.2.0-rc.1-LAB','0.2.0-rc.2-LAB');
compile(`OutFile "${win(path.join(dir,'generate-uninstaller-B.exe'))}"\n!define BUILD_UNINSTALLER\n${baseB}\n!include "${win(path.join(templates,'installer.nsi'))}"\n`,'uninstaller-B');
const generatedB=spawnSync(path.join(dir,'generate-uninstaller-B.exe'),[],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:15000});
if(generatedB.status!==0 || !fs.existsSync(uninstallerB))throw Error('Version B uninstaller generation failed');
compile(`OutFile "${win(exeB)}"\n${baseB}\n!include "${win(path.join(templates,'installer.nsi'))}"\n`,'installer-B');
const filesB=files.map(file=>({...file,sha256:sha(path.join(payloadDir,file.relative))}));
const manifest={dir,exe,exeB,sha256B:sha(exeB),initial,target,id,name,files,filesB,sha256:sha(exe),scope:'Complete stock electron-builder NSIS + original Orbital B. Benign payload, unique registry identity. NOT a candidate.'};
fs.writeFileSync(path.join(out,'latest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
