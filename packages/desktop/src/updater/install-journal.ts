import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWriteJsonSync} from '../atomic-json.js';
import type {InstallGateContext} from './types.js';
type Stage = 'prepared'|'shutdown'|'installing'|'awaiting-start'|'completed'|'recovery-required';
interface Operation { schema:1;id:string;startupToken:string;expectedVersion:string;sha256:string;stage:Stage;updatedAt:string;reason?:string;installerExit?:number; handoffResult?:string; artifactIdentity?:string; }
const stages: Stage[]=['prepared','shutdown','installing','awaiting-start','completed','recovery-required'];
/** Durable protocol state only. Does not execute installers, migrate data or claim rollback. */
export class UpdateJournal {
  constructor(private readonly file:string) {}
  read(): Operation|null {
    let stat:fs.Stats;
    try { stat=fs.lstatSync(this.file); } catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e; }
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('invalid operation journal');
    const v=JSON.parse(fs.readFileSync(this.file,'utf8')) as Operation;
    if(v.schema!==1||!stages.includes(v.stage)||typeof v.id!=='string'||typeof v.startupToken!=='string'||typeof v.expectedVersion!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256))throw Error('invalid operation journal');
    return v;
  }
  private write(v:Operation):Operation { atomicWriteJsonSync(this.file,v);return v; }
  private operation(id:string):Operation {const v=this.read();if(!v||v.id!==id)throw Error('operation identity mismatch');return v;}
  prepare(context:InstallGateContext):Operation {
    if(context.confirmed!==true||context.scanState!=='idle'||context.expectedVersion!==context.manifest.version||!context.expectedVersion||!/^[a-f0-9]{64}$/.test(context.manifest.file.sha256))throw Error('installation consent or manifest invalid');
    const previous=this.read();if(previous&&previous.stage!=='completed')throw Error('pending operation requires recovery');
    return this.write({schema:1,id:randomUUID(),startupToken:randomUUID(),expectedVersion:context.expectedVersion,sha256:context.manifest.file.sha256,stage:'prepared',updatedAt:new Date().toISOString()});
  }
  attachHandoff(id:string,resultFile:string,artifactIdentity?:string):Operation {
    const v=this.operation(id);
    if(v.stage!=='prepared'||!path.isAbsolute(resultFile)||path.basename(resultFile)!=='result.json')throw Error('invalid handoff evidence path');
    if(artifactIdentity!==undefined&&!/^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{8}$/.test(artifactIdentity))throw Error('invalid artifact identity');
    return this.write({...v,handoffResult:resultFile,artifactIdentity});
  }
  reconcileHandoff():Operation|null {
    const v=this.read();
    if(!v||v.stage==='completed'||v.stage==='recovery-required'||!v.handoffResult)return v;
    if(!fs.existsSync(v.handoffResult))return v;
    const stat=fs.lstatSync(v.handoffResult);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('invalid handoff evidence');
    const result=JSON.parse(fs.readFileSync(v.handoffResult,'utf8'));
    if(result.sha256!==v.sha256||(v.artifactIdentity!==undefined&&result.fileIdentity!==v.artifactIdentity))throw Error('handoff artifact identity mismatch');
    if(result.schema!==1||result.operation!==v.id)throw Error('handoff evidence identity mismatch');
    if(result.stage==='awaiting-start'&&result.installerExit===0){
      if(v.stage!=='shutdown'&&v.stage!=='installing'&&v.stage!=='awaiting-start')throw Error('invalid handoff result transition');
      return this.write({...v,stage:'awaiting-start',installerExit:0,updatedAt:new Date().toISOString()});
    }
    if(result.stage==='recovery-required')return this.write({...v,stage:'recovery-required',reason:'external-installer-failed',updatedAt:new Date().toISOString()});
    if(result.stage==='installing'&&v.stage==='shutdown')return this.write({...v,stage:'installing',updatedAt:new Date().toISOString()});
    return v;
  }
  advance(id:string,next:'shutdown'|'installing'):Operation {
    const v=this.operation(id);
    if(!((v.stage==='prepared'&&next==='shutdown')||(v.stage==='shutdown'&&next==='installing')))throw Error('invalid installation transition');
    return this.write({...v,stage:next,updatedAt:new Date().toISOString()});
  }
  installerExited(id:string,exit:number):Operation {
    const v=this.operation(id);if(v.stage!=='installing'||!Number.isSafeInteger(exit))throw Error('unexpected installer result');
    return this.write({...v,installerExit:exit,stage:exit===0?'awaiting-start':'recovery-required',reason:exit===0?undefined:'installer-failed',updatedAt:new Date().toISOString()});
  }
  confirmStartup(id:string,token:string,actualVersion:string,dataReady:boolean):Operation {
    const v=this.operation(id);if(v.stage!=='awaiting-start')throw Error('startup not expected');
    const reason=token!==v.startupToken?'startup-identity':actualVersion!==v.expectedVersion?'version-mismatch':dataReady!==true?'data-not-ready':undefined;
    return this.write({...v,stage:reason?'recovery-required':'completed',reason,updatedAt:new Date().toISOString()});
  }
  recoverInterrupted():Operation|null {
    const v=this.read();if(!v||v.stage==='completed'||v.stage==='recovery-required')return v;
    return this.write({...v,stage:'recovery-required',reason:`interrupted-${v.stage}`,updatedAt:new Date().toISOString()});
  }
}
