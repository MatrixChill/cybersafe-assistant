import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {WINDOWS_HANDOFF_SCRIPT} from './windows-handoff-script.js';
import {canonicalManifestBytes} from './manifest.js';
import {atomicWriteJsonSync} from '../atomic-json.js';
import {UpdateJournal} from './install-journal.js';
import type {Installer, ManifestSignatureVerifier, PublisherVerifier, ValidatedManifest} from './types.js';

interface Locked { sha256:string; size:number; fileIdentity:string; }
export interface Handoff { locked:Locked; commit(operation:string):Promise<void>; abort():Promise<void>; detach():void; }
interface HelperFailure { phase?:string; reason?:string; exitCode?:number; }
class HandoffError extends Error {
  constructor(readonly code:string, readonly helperFailure?:HelperFailure) { super(code); this.name='HandoffError'; }
}
function safeToken(value:unknown):string|undefined {
  return typeof value==='string'&&value.length<=80&&/^[A-Za-z0-9_.-]+$/.test(value)?value:undefined;
}
function readHelperFailure(stage:string):HelperFailure|undefined {
  try {
    const file=path.join(stage,'failure.json');
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)return undefined;
    const value=JSON.parse(fs.readFileSync(file,'utf8')) as Record<string,unknown>;
    return {phase:safeToken(value.phase),reason:safeToken(value.reason)};
  } catch { return undefined; }
}
/** Native helper owns file/directory locks and outlives its original parent. */
export async function lockPreparedArtifact(stage:string, operation:string, authorized=false, launcherPath=path.join(process.resourcesPath ?? path.dirname(process.execPath),'cybersafe-update-launcher.exe'), preview?:ValidatedManifest):Promise<Handoff> {
  if(process.platform!=='win32') throw Error('Windows required');
  if(!path.isAbsolute(launcherPath)||!fs.lstatSync(launcherPath).isFile()||fs.lstatSync(launcherPath).isSymbolicLink())throw Error('trusted native launcher required');
  const stagedLauncher=path.join(stage,'handoff-launcher.exe');
  fs.copyFileSync(launcherPath,stagedLauncher,fs.constants.COPYFILE_EXCL);
  const modules=path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules');
  const args=preview?['--preview-handoff',Buffer.from(canonicalManifestBytes(preview),'utf8').toString('base64'),preview.signature.value,path.join(stage,'installer.exe')]
    :[Buffer.from(WINDOWS_HANDOFF_SCRIPT,'utf16le').toString('base64')];
  const child=spawn(stagedLauncher,args,{
    windowsHide:true,stdio:['pipe','pipe','pipe'],
    env:{...process.env,PSModulePath:modules,CS_UPDATE_STAGE:stage,CS_UPDATE_PARENT:String(process.pid),CS_UPDATE_OPERATION:operation,CS_UPDATE_RESULT:path.join(stage,'result.json'),CS_UPDATE_EXECUTION:authorized?'authorized':'blocked'},
  });
  let dead=false,commitRequested=false,buffer='',exitCode:number|undefined;
  let closePromise:Promise<void>|undefined;
  const queue:Record<string,unknown>[]=[];
  let pending:{name:string;resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void}|undefined;
  const fail=(error:Error=new Error('external helper failed'))=>{dead=true;pending?.reject(error);pending=undefined;};
  closePromise=new Promise(resolve=>child.once('close',()=>resolve()));
  const closeOwnedHelper=async()=>{
    child.stdin.destroy();
    const closed=await Promise.race([closePromise!.then(()=>true),new Promise<boolean>(resolve=>{const timer=setTimeout(()=>resolve(false),5000);timer.unref?.()})]);
    if(!closed&&child.exitCode===null){child.kill();await Promise.race([closePromise, new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);timer.unref?.()})]);}
  };
  child.on('error',()=>fail(new HandoffError('launcher-process-error')));child.on('exit',code=>{exitCode=code??undefined;if(code!==0)fail(new HandoffError('launcher-exited'))});
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
    const timer=setTimeout(()=>{pending=undefined;child.stdin.destroy();reject(new HandoffError('launcher-handshake-timeout'));},30000);
    pending={name,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
  });
  try{
    const locked=await wait('locked');
    if(typeof locked.fileIdentity!=='string'||! /^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{8}$/.test(locked.fileIdentity)||typeof locked.sha256!=='string'||!/^[a-f0-9]{64}$/.test(locked.sha256)||!Number.isSafeInteger(locked.size))throw Error('invalid locked identity');
    return {
      locked:{sha256:locked.sha256,size:locked.size as number,fileIdentity:locked.fileIdentity as string},
      async commit(operation){const accepted=wait('armed');commitRequested=true;child.stdin.write(JSON.stringify({command:'COMMIT',operation})+'\n');await accepted;},
      async abort(){
        // A lost acknowledgement does not prove the helper never armed itself.
        if(commitRequested)atomicWriteJsonSync(path.join(stage,'abort.json'),{abort:true});
        await closeOwnedHelper();
      },
      detach(){child.stdin.end();child.stdout.destroy();child.stderr.destroy();child.unref();},
    };
  }catch(error){await closeOwnedHelper();throw new HandoffError(error instanceof HandoffError?error.code:'launcher-handshake-failed',{...readHelperFailure(stage),exitCode});}
}

interface Options {
  stagingRoot:string; journalFile:string; expectedPublisher:string; launcherPath?:string;
  signatureVerifier:ManifestSignatureVerifier; publisherVerifier:PublisherVerifier;
  requestShutdown:()=>Promise<void>;
  /** Absent/false by default. Production must not enable before explicit approval. */
  authorizeExecution?:()=>boolean;
  confirmConsent?:(context: import('./types.js').InstallGateContext)=>Promise<boolean>;
  /** Persistent, privacy-safe lifecycle diagnostics. Values contain no paths or raw errors. */
  onDiagnostic?:(event:'updater-handoff-started'|'updater-handoff-armed'|'updater-handoff-failed',details:Record<string,string|number|boolean|null>)=>void;
}
export function createWindowsInstaller(options:Options):Installer {
  return createInstaller(options,'stable');
}

export interface ScanLease { renew():Promise<boolean>; release():Promise<void>; }
type PreviewOptions=Omit<Options,'publisherVerifier'|'expectedPublisher'> & {
  /** Service-owned exclusion, covering every scan entry point until shutdown. */
  acquireScanLease:()=>Promise<ScanLease|null>;
};
export function createPreviewWindowsInstaller(options:PreviewOptions):Installer {
  return createInstaller(options,'preview');
}

function createInstaller(options:Options|PreviewOptions,channel:'stable'|'preview'):Installer {
  let busy=false;
  return {async install(context){
    const diagnostic=(event:'updater-handoff-started'|'updater-handoff-armed'|'updater-handoff-failed',details:Record<string,string|number|boolean|null>)=>{try{options.onDiagnostic?.(event,details)}catch{/* diagnostics must not affect the install gate */}};
    const refused=(code:string,phase:string,message=`external installation handoff refused (${code})`)=>{diagnostic('updater-handoff-failed',{channel,phase,reasonCode:code,journalStarted:false,helperAttempted:false});return {ok:false,message}};
    if(process.platform!=='win32')return refused('windows-required','entry-gate');
    if(busy)return refused('operation-busy','entry-gate');
    if(options.authorizeExecution?.()!==true)return refused('execution-not-authorized','entry-gate');
    if(context.manifest.channel!==channel)return refused('channel-mismatch','entry-gate',channel==='stable'?'Stable installer refuses non-Stable manifests':'Preview installer refuses non-Preview manifests');
    if(context.confirmed!==true||context.scanState!=='idle'||context.expectedVersion!==context.manifest.version)return refused('installation-gate-refused','entry-gate');
    busy=true;
    let helper:Handoff|undefined;
    const journal=new UpdateJournal(options.journalFile);
    let journalStarted=false;
    let lease:ScanLease|null=null;
    let handedOff=false;
    let helperAttempted=false;
    let phase='journal-read';
    let failureCode='handoff-failed';
    let observedJournalStage:string|null=null;
    diagnostic('updater-handoff-started',{channel});
    try{
      context=structuredClone(context);
      let previous:ReturnType<UpdateJournal['read']>;
      try{previous=journal.read()}catch{failureCode='journal-invalid-or-unreadable';observedJournalStage='unreadable';throw new HandoffError(failureCode)}
      observedJournalStage=previous?.stage??null;
      if(previous&&previous.stage!=='completed'){failureCode='recovery-required';throw new HandoffError(failureCode)}
      phase='consent';
      if(context.manifest.requiresElevation){failureCode='elevation-not-authorized';throw new HandoffError(failureCode)}
      if(await options.confirmConsent?.(context)!==true){failureCode='consent-refused';throw new HandoffError(failureCode)}
      if(channel==='preview') {
        phase='scanner-lease';
        lease=await (options as PreviewOptions).acquireScanLease();
        if(!lease){failureCode='scanner-lease-refused';throw new HandoffError(failureCode)}
      }
      phase='manifest-verification';
      const signature=context.manifest.signature;
      if(!(await options.signatureVerifier.verify(canonicalManifestBytes(context.manifest),signature.value,signature.signedByFingerprint)).ok){failureCode='manifest-signature-refused';throw new HandoffError(failureCode)}
      if(channel==='stable'&&context.manifest.publisher.name!==(options as Options).expectedPublisher){failureCode='publisher-identity-mismatch';throw new HandoffError(failureCode)}
      phase='artifact-validation';
      const stat=fs.lstatSync(context.artifactPath);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==context.manifest.file.sizeBytes){failureCode='artifact-metadata-invalid';throw new HandoffError(failureCode)}
      if(!path.isAbsolute(options.stagingRoot)){failureCode='staging-root-not-absolute';throw new HandoffError(failureCode)}
      phase='staging-copy';
      fs.mkdirSync(options.stagingRoot,{recursive:true});
      const stage=fs.mkdtempSync(path.join(options.stagingRoot,'update-'));
      const artifact=path.join(stage,'installer.exe');
      fs.copyFileSync(context.artifactPath,artifact,fs.constants.COPYFILE_EXCL);
      phase='launcher-lock';
      helperAttempted=true;
      helper=await lockPreparedArtifact(stage,path.basename(stage),true,options.launcherPath,channel==='preview'?context.manifest:undefined);
      phase='staged-validation';
      if(helper.locked.sha256!==context.manifest.file.sha256||helper.locked.size!==context.manifest.file.sizeBytes){failureCode='staged-integrity-mismatch';throw new HandoffError(failureCode)}
      if(!(await options.signatureVerifier.verify(canonicalManifestBytes(context.manifest),signature.value,signature.signedByFingerprint)).ok){failureCode='staged-manifest-signature-refused';throw new HandoffError(failureCode)}
      if(channel==='stable') {
        const stable=options as Options;
        if(!(await stable.publisherVerifier.verify(artifact,stable.expectedPublisher)).ok){failureCode='staged-authenticode-refused';throw new HandoffError(failureCode)}
      }
      phase='consent-revalidation';
      if(await options.confirmConsent?.(context)!==true||options.authorizeExecution?.()!==true){failureCode='consent-withdrawn';throw new HandoffError(failureCode)}
      phase='scanner-lease-renewal';
      if(lease && await lease.renew()!==true){failureCode='scanner-lease-expired';throw new HandoffError(failureCode)}
      phase='journal-prepare';
      const operation=journal.prepare(context);journalStarted=true;
      observedJournalStage='prepared';
      journal.attachHandoff(operation.id,path.join(stage,'result.json'),helper.locked.fileIdentity);
      journal.advance(operation.id,'shutdown');
      observedJournalStage='shutdown';
      phase='launcher-commit';
      await helper.commit(operation.id);
      phase='application-shutdown';
      await options.requestShutdown();
      helper.detach();
      handedOff=true;
      diagnostic('updater-handoff-armed',{channel,phase:'handoff-armed',reasonCode:null,journalStarted:true,journalStage:'shutdown',helperAttempted:true});
      return {ok:true,message:'handoff armed; installation and startup are not confirmed'};
    }catch(error){
      const handoffError=error instanceof HandoffError?error:undefined;
      if(handoffError?.helperFailure?.phase){failureCode=`launcher-${safeToken(handoffError.helperFailure.phase)??'failure'}-${safeToken(handoffError.helperFailure.reason)??'unknown'}`.slice(0,100);}
      else if(handoffError?.helperFailure?.exitCode!==undefined)failureCode=`launcher-exit-${handoffError.helperFailure.exitCode}`;
      else if(handoffError?.code)failureCode=handoffError.code;
      else failureCode=`${phase}-failed`;
      try{await helper?.abort();}catch{/* persistent journal stays fail-closed */}
      if(journalStarted){try{const recovered=journal.recoverInterrupted();observedJournalStage=recovered?.stage??null;}catch{observedJournalStage='unreadable';}}
      diagnostic('updater-handoff-failed',{channel,phase,reasonCode:failureCode,journalStarted,journalStage:observedJournalStage,helperAttempted,helperExitCode:handoffError?.helperFailure?.exitCode??null});
      return {ok:false,message:`external installation handoff failed (${failureCode}); recovery may be required`};
    }finally{
      if(!handedOff) { try { await lease?.release(); } catch { /* service expiry remains fail-closed */ } }
      busy=false;
    }
  }};
}
