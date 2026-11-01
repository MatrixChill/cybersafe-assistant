import fs from 'node:fs/promises';
import path from 'node:path';
import type {AnalysisResult} from '@cybersafe/shared-types';
export type QuarantinePolicy='warn'|'ask'|'automatic-high-confidence';
/** No configuration is written or enabled by this loader. Invalid/missing means warn. */
export async function loadQuarantinePolicy(file:string):Promise<QuarantinePolicy>{
  try{const p=JSON.parse(await fs.readFile(file,'utf8')).quarantinePolicy;return p==='ask'||p==='automatic-high-confidence'?p:'warn';}catch{return 'warn';}
}
export function isQuarantinePolicy(value: unknown): value is QuarantinePolicy {
  return value === 'warn' || value === 'ask' || value === 'automatic-high-confidence';
}
/** Escrita atomica da preferencia. Um pedido automatico exige consentimento literal. */
export async function saveQuarantinePolicy(file:string,policy:unknown,consent?:unknown):Promise<{ok:boolean;policy:QuarantinePolicy;error?:string}>{
  const atual=await loadQuarantinePolicy(file);
  if(!isQuarantinePolicy(policy))return {ok:false,policy:atual,error:'policy_invalid'};
  if(policy==='automatic-high-confidence'&&consent!==true)return {ok:false,policy:atual,error:'consent_required'};
  const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
  try{
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(tmp,JSON.stringify({quarantinePolicy:policy},null,2)+'\n',{encoding:'utf8',mode:0o600});
    await fs.rename(tmp,file);
    return {ok:true,policy};
  }catch{
    await fs.rm(tmp,{force:true}).catch(()=>{});
    return {ok:false,policy:atual,error:'write_failed'};
  }
}
export function canAutoQuarantine(policy:QuarantinePolicy,analysis:AnalysisResult):boolean{
  return policy==='automatic-high-confidence' && analysis.severity==='critical' && analysis.verdict==='malicious' && analysis.confidence>=0.99
    && analysis.rulesTriggered.some(rule=>rule==='known_bad_hash');
}
