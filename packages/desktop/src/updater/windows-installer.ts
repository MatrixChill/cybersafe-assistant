import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {WINDOWS_HANDOFF_SCRIPT} from './windows-handoff-script.js';
import {canonicalManifestBytes} from './manifest.js';
import {atomicWriteJsonSync} from '../atomic-json.js';
import {UpdateJournal} from './install-journal.js';
import type {Installer, ManifestSignatureVerifier, PublisherVerifier} from './types.js';

interface Locked { sha256:string; size:number; fileIdentity:string; }
export interface Handoff { locked:Locked; commit(operation:string):Promise<void>; abort():Promise<void>; detach():void; }
/** Native helper owns file/directory locks and outlives its original parent. */
export async function lockPreparedArtifact(stage:string, operation:string, authorized=false, launcherPath=path.join(process.resourcesPath ?? path.dirname(process.execPath),'cybersafe-update-launcher.exe')):Promise<Handoff> {
  if(process.platform!=='win32') throw Error('Windows required');
  if(!path.isAbsolute(launcherPath)||!fs.lstatSync(launcherPath).isFile()||fs.lstatSync(launcherPath).isSymbolicLink())throw Error('trusted native launcher required');
  const stagedLauncher=path.join(stage,'handoff-launcher.exe');
  fs.copyFileSync(launcherPath,stagedLauncher,fs.constants.COPYFILE_EXCL);
  const modules=path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules');
  const child=spawn(stagedLauncher,[Buffer.from(WINDOWS_HANDOFF_SCRIPT,'utf16le').toString('base64')],{
    windowsHide:true,stdio:['pipe','pipe','pipe'],
    env:{...process.env,PSModulePath:modules,CS_UPDATE_STAGE:stage,CS_UPDATE_PARENT:String(process.pid),CS_UPDATE_OPERATION:operation,CS_UPDATE_RESULT:path.join(stage,'result.json'),CS_UPDATE_EXECUTION:authorized?'authorized':'blocked'},
  });
  let dead=false,armed=false,buffer='';
  const queue:Record<string,unknown>[]=[];
  let pending:{name:string;resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void}|undefined;
  const fail=()=>{dead=true;pending?.reject(Error('external helper failed'));pending=undefined;};
  child.on('error',fail);child.on('exit',code=>{if(code!==0)fail();});
  child.stdin.on('error',fail);child.stderr.resume();
  child.stdout.setEncoding('utf8');child.stdout.on('end',fail);
  child.stdout.on('data',(chunk:string)=>{
    buffer+=chunk;
    if(buffer.length>16384){fail();child.stdin.destroy();return;}
    let newline:number;
    while((newline=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
      if(!line)continue;
      try{
        const value=JSON.parse(line) as Record<string,unknown>;
        if(pending&&value.event===pending.name){const request=pending;pending=undefined;request.resolve(value);}
        else if(queue.length<2)queue.push(value);
        else{fail();child.stdin.destroy();}
      }catch{fail();child.stdin.destroy();}
    }
  });
  const wait=(name:string):Promise<Record<string,unknown>>=>new Promise((resolve,reject)=>{
    const index=queue.findIndex(value=>value.event===name);
    if(index>=0){resolve(queue.splice(index,1)[0]);return;}
    if(dead){reject(Error('external helper unavailable'));return;}
    const timer=setTimeout(()=>{pending=undefined;child.stdin.destroy();reject(Error('external helper timeout'));},30000);
    pending={name,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
  });
  try{
    const locked=await wait('locked');
    if(typeof locked.fileIdentity!=='string'||! /^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{8}$/.test(locked.fileIdentity)||typeof locked.sha256!=='string'||!/^[a-f0-9]{64}$/.test(locked.sha256)||!Number.isSafeInteger(locked.size))throw Error('invalid locked identity');
    return {
      locked:{sha256:locked.sha256,size:locked.size as number,fileIdentity:locked.fileIdentity as string},
      async commit(operation){const accepted=wait('armed');child.stdin.write(JSON.stringify({command:'COMMIT',operation})+'\n');await accepted;armed=true;},
      async abort(){if(dead)return;const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));if(armed)atomicWriteJsonSync(path.join(stage,'abort.json'),{abort:true});child.stdin.destroy();await closed;},
      detach(){child.stdin.end();child.stdout.destroy();child.stderr.destroy();child.unref();},
    };
  }catch(error){child.stdin.destroy();throw error;}
}

interface Options {
  stagingRoot:string; journalFile:string; expectedPublisher:string; launcherPath?:string;
  signatureVerifier:ManifestSignatureVerifier; publisherVerifier:PublisherVerifier;
  requestShutdown:()=>Promise<void>;
  /** Absent/false by default. Production must not enable before explicit approval. */
  authorizeExecution?:()=>boolean;
  confirmConsent?:(context: import('./types.js').InstallGateContext)=>Promise<boolean>;
}
export function createWindowsInstaller(options:Options):Installer {
  let busy=false;
  return {async install(context){
    if(process.platform!=='win32'||busy||options.authorizeExecution?.()!==true)return {ok:false,message:'installation execution is blocked'};
    if(context.confirmed!==true||context.scanState!=='idle'||context.expectedVersion!==context.manifest.version)return {ok:false,message:'installation gate refused'};
    busy=true;
    let helper:Handoff|undefined;
    const journal=new UpdateJournal(options.journalFile);
    let journalStarted=false;
    try{
      context=structuredClone(context);
      const previous=journal.read();
      if(previous&&previous.stage!=='completed')throw Error('previous operation requires recovery');
      if(context.manifest.requiresElevation)throw Error('elevated installation is not authorized');
      if(await options.confirmConsent?.(context)!==true)throw Error('consent refused');
      const signature=context.manifest.signature;
      if(!(await options.signatureVerifier.verify(canonicalManifestBytes(context.manifest),signature.value,signature.signedByFingerprint)).ok)throw Error('manifest signature refused');
      if(context.manifest.publisher.name!==options.expectedPublisher)throw Error('publisher identity mismatch');
      const stat=fs.lstatSync(context.artifactPath);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==context.manifest.file.sizeBytes)throw Error('invalid artifact');
      if(!path.isAbsolute(options.stagingRoot))throw Error('absolute private staging required');
      fs.mkdirSync(options.stagingRoot,{recursive:true});
      const stage=fs.mkdtempSync(path.join(options.stagingRoot,'update-'));
      const artifact=path.join(stage,'installer.exe');
      fs.copyFileSync(context.artifactPath,artifact,fs.constants.COPYFILE_EXCL);
      helper=await lockPreparedArtifact(stage,path.basename(stage),true,options.launcherPath);
      if(helper.locked.sha256!==context.manifest.file.sha256||helper.locked.size!==context.manifest.file.sizeBytes)throw Error('staged integrity mismatch');
      if(!(await options.signatureVerifier.verify(canonicalManifestBytes(context.manifest),signature.value,signature.signedByFingerprint)).ok)throw Error('staged manifest signature refused');
      if(!(await options.publisherVerifier.verify(artifact,options.expectedPublisher)).ok)throw Error('staged Authenticode refused');
      if(await options.confirmConsent?.(context)!==true||options.authorizeExecution?.()!==true)throw Error('consent withdrawn');
      const operation=journal.prepare(context);journalStarted=true;
      journal.attachHandoff(operation.id,path.join(stage,'result.json'),helper.locked.fileIdentity);
      journal.advance(operation.id,'shutdown');
      await helper.commit(operation.id);
      await options.requestShutdown();
      helper.detach();
      return {ok:true,message:'handoff armed; installation and startup are not confirmed'};
    }catch{
      try{await helper?.abort();}catch{/* persistent journal stays fail-closed */}
      if(journalStarted){try{journal.recoverInterrupted();}catch{/* unreadable state remains blocked */}}
      return {ok:false,message:'external installation handoff failed; recovery may be required'};
    }finally{busy=false;}
  }};
}
