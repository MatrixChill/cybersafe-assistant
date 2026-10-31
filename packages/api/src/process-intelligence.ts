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
/**
 * PORQUE DOIS CÓDIGOS (TP-MATRIX-ROOT-CAUSE-20261023): um único 400 dizia
 * «inválido OU sem consentimento» e mandava o utilizador à procura do defeito
 * errado. «Sem autorização» é uma decisão que a pessoa toma; «payload inválido»
 * é um defeito da app. São dois caminhos diferentes e passam a ter dois códigos
 * estáveis — o validador continua exactamente igual, nada foi aliviado.
 */
export type ProcessContextRefusalCode = 'process_consent_missing' | 'process_context_invalid' | 'process_consent_ambiguous';
const MENSAGEM_RECUSA: Record<ProcessContextRefusalCode, string> = {
  process_consent_missing: 'Faltam as autorizações explícitas para enviar as medições deste alvo.',
  process_context_invalid: 'O contexto de processos medido não tem a forma esperada.',
  process_consent_ambiguous: 'O pedido traz duas autorizações diferentes: envia só uma.',
};
export class ProcessContextRefusal extends Error {
  readonly code: ProcessContextRefusalCode;
  constructor(code: ProcessContextRefusalCode) {
    super(MENSAGEM_RECUSA[code]);
    this.name = 'ProcessContextRefusal';
    this.code = code;
  }
}
/**
 * TP-MATRIX-R2-CONSENT: o bloco validado, sem decidir autorização.
 *
 * Este é o ÚNICO construtor do texto que chega ao fornecedor, e de propósito não
 * olha a `processConsent`: uma flag enviada pelo cliente não é uma autorização, e
 * enquanto a decisão vivia aqui dentro (`processContextForChat`) bastava o cliente
 * escrever `true` para a telemetria sair. Quem chama é que tem de apresentar uma
 * autorização que o SERVIDOR validou (grant persistente ou autorização única
 * emitida por `/api/ai/process-consent/one-shot`) — e é isso que a rota faz antes
 * de pedir este bloco. Um payload mal formado continua a ser recusado aqui.
 */
export function processContextBlock(body: unknown): string | null {
  if(!record(body) || body.processIntelligence===undefined) return null;
  if(!validateProcessIntelligencePayload(body.processIntelligence)) throw new ProcessContextRefusal('process_context_invalid');
  return '[FACTO MEDIDO - PROCESS INTELLIGENCE]\n'+JSON.stringify(body.processIntelligence)+'\nDistinguir facto, hipótese, risco confirmado e informação insuficiente. Working Set não é memória privada. Não diagnosticar fugas nem executar ações. Não inferir segurança pelo consumo.';
}

/**
 * Forma histórica (flag `processConsent` no corpo). Mantém-se exportada porque é
 * contrato de `matrix-origin-contract`/`process-intelligence` e porque descreve a
 * regra do validador puro. A rota do chat NÃO a usa para decidir: ver acima.
 * Validated allowlist only; caller still runs the central credential guard.
 */
export function processContextForChat(body: unknown): string | null {
  if(!record(body) || body.processIntelligence===undefined) return null;
  if(!hasProcessConsent(body)) throw new ProcessContextRefusal('process_consent_missing');
  return processContextBlock(body);
}
