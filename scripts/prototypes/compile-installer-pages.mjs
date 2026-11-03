// Preview build of the REAL installer pages.
//
// Uses the same electron-builder page order (assistedInstaller.nsh), the same
// CyberSafe theme include and the same branding bitmaps as production. The
// section is inert: it sleeps briefly so the native progress page can be
// captured and it writes nothing. customInstall is deliberately NOT inserted,
// so no shortcut or uninstall registry entry is ever touched.
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
const templates=path.join(root,'node_modules/app-builder-lib/templates/nsis');
const win=p=>p.replaceAll('/','\\');
const outDir=path.join(root,'output/installer-pages');

if(!fs.existsSync(compiler)) throw new Error(`NSIS compiler missing: ${compiler}`);
if(!fs.existsSync(path.join(resources,'plugins/x86-unicode/UAC.dll'))) throw new Error('missing nsis-resources-3.4.1');

fs.mkdirSync(outDir,{recursive:true});
const dir=fs.mkdtempSync(path.join(outDir,'build-'));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'packages/desktop/package.json'),'utf8'));
const version=JSON.parse(fs.readFileSync(path.join(root,'product-version.json'),'utf8')).version;

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
ManifestDPIAware true
RequestExecutionLevel user
!define BUILD_RESOURCES_DIR "${win(path.join(root,'packages/desktop/build'))}"
!define VERSION "${version}"
!define PRODUCT_NAME "CyberSafe Assistant"
!define APP_FILENAME "CyberSafe Assistant"
!define PRODUCT_FILENAME "CyberSafe Assistant"
!define MENU_FILENAME "CyberSafe Assistant"
!define APP_GUID "CyberSafePagesPreviewOnly"
!define UNINSTALL_APP_KEY "CyberSafePagesPreviewOnly"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
Name "CyberSafe Assistant"
Caption "CyberSafe Assistant — pré-visualização de páginas"
BrandingText "PRÉ-VISUALIZAÇÃO · NENHUMA INSTALAÇÃO"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${win(path.join(root,'packages/desktop/build/installer/installerHeader.bmp'))}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${win(path.join(root,'packages/desktop/build/installer/installerSidebar.bmp'))}"
ShowInstDetails nevershow
OutFile "${win(path.join(outDir,'CyberSafe-pages-preview.exe'))}"
Var newStartMenuLink
Var newDesktopLink
Var launchLink
${generator.build()}
!include "${win(path.join(root,'packages/desktop/build/installer/cybersafe-installer.nsh'))}"
!include common.nsh
!include MUI2.nsh
!include "${win(path.join(templates,'multiUser.nsh'))}"
!include assistedInstaller.nsh
!insertmacro addLangs
!insertmacro customHeader
Section
 ; Preview only. Nothing is extracted, created, registered or removed.
 Sleep 2600
 DetailPrint "Pré-visualização: nenhuma instalação executada."
SectionEnd
`;
fs.writeFileSync(path.join(dir,'pages.nsi'),source);
const result=spawnSync(compiler,['/NOCONFIG','/INPUTCHARSET','UTF8','/V4',path.join(dir,'pages.nsi')],{encoding:'utf8',timeout:60000,windowsHide:true,cwd:templates});
const log=(result.stdout??'')+(result.stderr??'')+(result.error?.message??'');
fs.writeFileSync(path.join(outDir,'compile.log'),log);
if(result.status!==0){ console.error(log.split('\n').slice(-25).join('\n')); process.exit(result.status??1); }
console.log(JSON.stringify({exe:path.join(outDir,'CyberSafe-pages-preview.exe'),bytes:fs.statSync(path.join(outDir,'CyberSafe-pages-preview.exe')).size,warnings:(log.match(/warning \d+/g)??[])}));
