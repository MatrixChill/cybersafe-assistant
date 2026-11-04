// No application installation or registry mutation. Exercise the actual x86
// NSIS plugin ABI with disposable filesystem fixtures, including a junction.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'output/destination-contract');
fs.mkdirSync(out,{recursive:true});
const dir=fs.mkdtempSync(path.join(out,'run-'));
const product='CyberSafe Benign LAB';
const occupied=path.join(dir,'registered',product);
fs.mkdirSync(occupied,{recursive:true});
fs.writeFileSync(path.join(occupied,'document.txt'),'preserve this benign document');
const junction=path.join(dir,'junction');
fs.symlinkSync(occupied,junction,'junction');
const cases=[
 ['registered',occupied,occupied,product,'ok'],
 ['fresh',path.join(dir,'fresh',product),'',product,'ok'],
 ['missing-registration',occupied,'',product,'unregistered-occupied-directory'],
 ['different-registration',occupied,path.join(dir,'other',product),product,'registered-path-mismatch'],
 ['arbitrary-documents',occupied,'','Other Product','product-leaf-mismatch'],
 ['reparse',junction,junction,product,'invalid-path'],
 ['trailing-separator',occupied+'\\',occupied,product,'invalid-path'],
 ['relative','relative','',product,'invalid-path'],
];
const legacy=process.argv.includes('--rc3');
let plugin=path.join(root,'packages/desktop/build/x86-unicode');
if(legacy){
 plugin=path.join(dir,'rc3');fs.mkdirSync(plugin);
 const binary=spawnSync('git',['show','fef2faa:packages/desktop/build/x86-unicode/OrbitalSetup.dll'],{cwd:root,maxBuffer:10*1024*1024});
 assert.equal(binary.status,0);fs.writeFileSync(path.join(plugin,'OrbitalSetup.dll'),binary.stdout);
}
const source=`Unicode true
SilentInstall silent
RequestExecutionLevel user
OutFile "${path.join(dir,'probe.exe')}"
!addplugindir /x86-unicode "${plugin}"
!addplugindir /x86-unicode "${path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-resources-3.4.1/plugins/x86-unicode')}"
!include "${path.join(root,'node_modules/app-builder-lib/templates/nsis/include/StdUtils.nsh')}"
Section
FileOpen $9 "$EXEDIR\\results.txt" w
StrCmp $INSTDIR "${occupied}" 0 +2
FileWrite $9 "native-parser=exact$\\r$\\n"
\${StdUtils.GetParameter} $R0 "D" ""
StrCmp $R0 "${occupied.split(' ')[0]}" 0 +2
FileWrite $9 "stdutils-parser=truncated$\\r$\\n"
${cases.map(([name,p,r,prod])=>`OrbitalSetup::Validate "${p}" "${r}" "${prod}"
Pop $0
FileWrite $9 "${name}=$0$\\r$\\n"`).join('\n')}
FileClose $9
SectionEnd`;
const script=path.join(dir,'probe.nsi');fs.writeFileSync(script,source);
const compiler=path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const built=spawnSync(compiler,['/V2',script],{encoding:'utf8',windowsHide:true});
assert.equal(built.status,0,built.stdout+built.stderr);
// /D must be last and unquoted per NSIS; verbatim avoids Node adding quotes.
const run=spawnSync(path.join(dir,'probe.exe'),['/D='+occupied],{timeout:15000,windowsHide:true,windowsVerbatimArguments:true});assert.equal(run.status,0);
const results=fs.readFileSync(path.join(dir,'results.txt'),'utf8');
assert.ok(results.includes('native-parser=exact\r\n'),results);
assert.ok(results.includes('stdutils-parser=truncated\r\n'),results);
for(const [name,,,,expected] of cases) assert.ok(results.includes(`${name}=${legacy&&expected!=='ok'?'invalid':expected}\r\n`),results);
assert.equal(fs.readFileSync(path.join(occupied,'document.txt'),'utf8'),'preserve this benign document');
console.log(JSON.stringify({status:'PASS',legacy,cases:cases.length,evidence:dir,preserved:true}));
