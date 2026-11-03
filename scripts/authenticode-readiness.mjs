#!/usr/bin/env node
/** Read-only signing gate; never signs, installs, publishes or enables trust. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createWindowsPublisherVerifier} from '../packages/desktop/src/updater/windows-publisher.ts';

export async function auditAuthenticode(file, publisher, verifier=createWindowsPublisherVerifier()) {
  const blocked=reason=>({ok:false,productionEnabled:false,reason});
  if(typeof publisher!=='string'||!publisher.trim()||/academic unsigned/i.test(publisher)) return blocked('Approved publisher required');
  try {
    const absolute=path.resolve(file);
    const stat=await fs.lstat(absolute);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||await fs.realpath(absolute)!==absolute) return blocked('Regular canonical artifact required');
    const digest=async()=>{const h=createHash('sha256');const handle=await fs.open(absolute,'r');try {for await(const chunk of handle.createReadStream())h.update(chunk);}finally{await handle.close();}return h.digest('hex');};
    const before=await digest();
    const signature=await verifier.verify(absolute,publisher);
    if(!signature.ok)return blocked(signature.reason??'Authenticode refused');
    const after=await digest();const current=await fs.lstat(absolute);
    if(before!==after||stat.ino!==current.ino||stat.size!==current.size||stat.mtimeMs!==current.mtimeMs||stat.ctimeMs!==current.ctimeMs) return blocked('Artifact changed during verification');
    return {ok:true,productionEnabled:false,artifact:absolute,publisher,size:current.size,sha256:after};
  }catch{return blocked('Artifact or signature verification unavailable');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(args.length!==3||args[1]!=='--publisher'){console.error('Usage: node scripts/authenticode-readiness.mjs <artifact.exe> --publisher <approved exact SimpleName>');process.exitCode=2;}
  else{const result=await auditAuthenticode(args[0],args[2]);console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;}
}
