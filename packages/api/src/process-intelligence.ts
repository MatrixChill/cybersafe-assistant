import type { ProcessIntelligenceContext } from '@cybersafe/shared-types';
type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: RecordValue, allowed: string[]) => Object.keys(v).every(k=>allowed.includes(k)) && allowed.every(k=>k in v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const measurement = (v: unknown) => v === null || (number(v) && v >= 0);
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const pid = (v: unknown) => number(v) && Number.isInteger(v) && v > 0 && v <= 0xffffffff;
const percent = (v: unknown) => v === null || (number(v) && v >= 0 && v <= 100);
function entry(v: unknown): boolean {
  return record(v) && keys(v,['pid','name','startedAt','cpuPercent','workingSetMb']) && pid(v.pid)
    && typeof v.name === 'string' && /^[^\\/\u0000-\u001f]{1,80}$/.test(v.name) && v.name.trim().length > 0
    && (v.startedAt === null || timestamp(v.startedAt)) && percent(v.cpuPercent) && measurement(v.workingSetMb);
}
export function validateProcessIntelligencePayload(v: unknown): v is ProcessIntelligenceContext {
  if(!record(v) || !keys(v,['version','measuredAt','ram','cpuPercent','topProcesses','selectedProcess','trends','limitations']) || v.version!==1 || !timestamp(v.measuredAt)) return false;
  const ram=v.ram;
  if(!record(ram) || !keys(ram,['totalMb','usedMb','availableMb']) || !Object.values(ram).every(measurement)) return false;
  if(number(ram.totalMb) && ((number(ram.usedMb) && ram.usedMb>ram.totalMb) || (number(ram.availableMb) && ram.availableMb>ram.totalMb))) return false;
  if(!percent(v.cpuPercent) || !Array.isArray(v.topProcesses) || v.topProcesses.length>5 || !v.topProcesses.every(entry) || !(v.selectedProcess===null || entry(v.selectedProcess))) return false;
  if(!Array.isArray(v.limitations) || v.limitations.length>8 || !v.limitations.every(s=>typeof s==='string' && s.length>0 && s.length<=240)) return false;
  if(!Array.isArray(v.trends) || v.trends.length>5) return false;
  const processes=[...v.topProcesses, ...(v.selectedProcess ? [v.selectedProcess] : [])] as RecordValue[];
  return v.trends.every(t=>record(t) && keys(t,['pid','startedAt','previousMb','currentMb','deltaMb','intervalMs','samples']) && pid(t.pid) && timestamp(t.startedAt)
    && measurement(t.previousMb) && t.previousMb!==null && measurement(t.currentMb) && t.currentMb!==null && number(t.deltaMb)
    && Math.abs((t.currentMb as number)-(t.previousMb as number)-t.deltaMb)<0.001 && number(t.intervalMs) && t.intervalMs>=30000 && t.intervalMs<=600000
    && number(t.samples) && Number.isInteger(t.samples) && t.samples>=3 && t.samples<=60
    && processes.some(p=>p.pid===t.pid && p.startedAt===t.startedAt));
}
export function hasProcessConsent(body: unknown): boolean { return record(body) && body.processConsent===true; }
/** Validated allowlist only; caller still runs the central credential guard. */
export function processContextForChat(body: unknown): string | null {
  if(!record(body) || body.processIntelligence===undefined) return null;
  if(!hasProcessConsent(body) || !validateProcessIntelligencePayload(body.processIntelligence)) throw new Error('invalid_process_context');
  return '[FACTO MEDIDO - PROCESS INTELLIGENCE]\n'+JSON.stringify(body.processIntelligence)+'\nDistinguir facto, hipótese, risco confirmado e informação insuficiente. Working Set não é memória privada. Não diagnosticar fugas nem executar ações. Não inferir segurança pelo consumo.';
}
