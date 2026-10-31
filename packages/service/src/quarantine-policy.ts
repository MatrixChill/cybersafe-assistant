import fs from 'node:fs/promises';
import type {AnalysisResult} from '@cybersafe/shared-types';
export type QuarantinePolicy='warn'|'ask'|'automatic-high-confidence';
/** No configuration is written or enabled by this loader. Invalid/missing means warn. */
export async function loadQuarantinePolicy(file:string):Promise<QuarantinePolicy>{
  try{const p=JSON.parse(await fs.readFile(file,'utf8')).quarantinePolicy;return p==='ask'||p==='automatic-high-confidence'?p:'warn';}catch{return 'warn';}
}
export function canAutoQuarantine(policy:QuarantinePolicy,analysis:AnalysisResult):boolean{
  return policy==='automatic-high-confidence' && analysis.severity==='critical' && analysis.verdict==='malicious' && analysis.confidence>=0.99
    && analysis.rulesTriggered.some(rule=>rule==='known_bad_hash');
}
