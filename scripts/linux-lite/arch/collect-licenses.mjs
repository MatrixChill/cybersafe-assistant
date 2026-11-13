import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const own=new Set(['@cybersafe/core','@cybersafe/native-windows','@cybersafe/service','@cybersafe/shared-types','api']);
const allowed=new Set(['MIT','ISC','BSD-2-Clause','BSD-3-Clause','Apache-2.0','(MIT OR WTFPL)','(BSD-2-Clause OR MIT OR Apache-2.0)']);
const noticeName=/^(licen[sc]e|copying|notice|copyright)($|[._-])/i;
const hash=text=>createHash('sha256').update(text).digest('hex');

/** Read actual staged runtime modules. Under Electron, fs also reads app.asar. */
export function collectRuntimeLicenses(appRoot,ownLicense) {
  const packages=[];const sections=[];
  function inspect(directory) {
    if(!fs.existsSync(path.join(directory,'package.json')))return;
    const meta=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
    const license=meta.license ?? meta.licenses?.map(item=>item.type).join(' OR ');
    if(!allowed.has(license))throw new Error(`Unreviewed runtime license: ${meta.name}`);
    if(own.has(meta.name)&&meta.private!==true)throw new Error(`Unverified own-code package: ${meta.name}`);
    let source=directory;
    let names=fs.readdirSync(source).filter(name=>noticeName.test(name)&&fs.statSync(path.join(source,name)).isFile());
    // The platform binary is part of Koffi's identically versioned distribution.
    if(!names.length && meta.name==='@koromix/koffi-linux-x64') {
      source=path.join(appRoot,'node_modules','koffi');
      const parent=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
      if(parent.version!==meta.version||parent.license!=='MIT')throw new Error('Koffi license/version mismatch');
      names=fs.readdirSync(source).filter(name=>noticeName.test(name)&&fs.statSync(path.join(source,name)).isFile());
    }
    const texts=own.has(meta.name)?[{name:'CyberSafe LICENSE',text:ownLicense}]:names.map(name=>({name,text:fs.readFileSync(path.join(source,name),'utf8')}));
    if(!texts.length||texts.some(x=>!x.text.trim()))throw new Error(`Missing runtime notice: ${meta.name}`);
    packages.push({name:meta.name,version:meta.version,license,notices:texts.map(x=>({file:x.name,sha256:hash(x.text)}))});
    sections.push(`\n## ${meta.name}@${meta.version} (${license})\n`+texts.map(x=>`\n### ${x.name}\n\n${x.text}\n`).join(''));
    walk(path.join(directory,'node_modules'));
  }
  function walk(directory) {
    if(!fs.existsSync(directory))return;
    for(const name of fs.readdirSync(directory).sort()) {
      if(name.startsWith('.'))continue;
      const entry=path.join(directory,name);
      if(!fs.statSync(entry).isDirectory())continue;
      if(name.startsWith('@'))for(const child of fs.readdirSync(entry).sort())inspect(path.join(entry,child));
      else inspect(entry);
    }
  }
  walk(path.join(appRoot,'node_modules'));
  return {packages,notices:'# CyberSafe Linux — actual runtime package notices\n'+sections.join('\n')};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [appRoot,output,licenseFile]=process.argv.slice(2);
  if(!process.versions.electron||!appRoot||!output||!licenseFile)throw new Error('Use installed Electron RUN_AS_NODE: app-root output-dir approved-LICENSE');
  const ownLicense=fs.readFileSync(licenseFile,'utf8');
  const result=collectRuntimeLicenses(path.join(appRoot,'resources','app.asar'),ownLicense);
  const renderer=fs.readFileSync(path.join(appRoot,'resources','app.asar','dist','THIRD-PARTY-RENDERER.md'),'utf8');
  if(!renderer.includes('react')||/\(UNKNOWN\)|\(UNLICENSED\)/i.test(renderer))throw new Error('Renderer notices missing or unreviewed');
  const bundled=[...renderer.matchAll(/^## .*? - .*? \((.*?)\)$/gm)];
  if(!bundled.length||bundled.some(match=>!allowed.has(match[1])))throw new Error('Unreviewed renderer license');
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'LICENSE'),ownLicense);
  fs.writeFileSync(path.join(output,'RUNTIME-LICENSE-INVENTORY.json'),JSON.stringify(result.packages,null,2)+'\n');
  fs.writeFileSync(path.join(output,'THIRD-PARTY-NOTICES-LINUX.txt'),result.notices);
  fs.writeFileSync(path.join(output,'RENDERER-NOTICES.md'),renderer);
  for(const name of ['LICENSE.electron.txt','LICENSES.chromium.html'])fs.copyFileSync(path.join(appRoot,name),path.join(output,name));
  console.log(`Linux runtime notices: ${result.packages.length} packages; renderer and Electron/Chromium notices retained.`);
}
