import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProcessMatrixContext, buildProcessLocalReply, isProcessQuestion, processPayload, processChatHistory, matrixTelemetryContext } from '../src/lib/processMatrix.ts';
import { buildMatrixContext } from '../src/lib/matrixContext.ts';

const diagnostic = {
  measuredAt: '2026-10-14T08:10:00.000Z',
  ram: {totalMb: 16000, usedMb: 12000, availableMb: 4000}, cpuPercent: 40,
  topProcesses: [{pid: 42,name: 'C:\\Users\\private\\chrome.exe',startedAt: '2026-10-14T07:00:00.000Z',cpuPercent: 20,workingSetMb: 900}],
  trends: [{pid: 42,startedAt: '2026-10-14T07:00:00.000Z',previousMb: 700,currentMb: 900,deltaMb: 200,intervalMs: 60000,samples: 3}],
  observations: ['RAM medida: 12000 MB.'], recommendations: ['Guardar o trabalho antes de fechar normalmente uma aplicação.'],
  limitations: ['Working Set não é memória privada.'],
};
test('all automatic PC telemetry requires consent, including general protection/CPU context',()=>{
  assert.equal(matrixTelemetryContext('CPU 70; protection on',false),'');
  assert.equal(matrixTelemetryContext('CPU 70; protection on',true),'CPU 70; protection on');
});
test('outbound trends must belong to an included measured process instance',()=>{
  const context=buildProcessMatrixContext({...diagnostic,trends:[{...diagnostic.trends[0],pid:999}]},42);
  assert.equal(context.trends.length,0);
});
test('general context never exports raw disk error text or folder mounts',()=>{
 const context=buildMatrixContext({protection:null,pcState:null,threats:[],hardware:{cpu:{usage:1},ram:{usagePercent:10},disk:{usagePercent:null,reason:'EACCES C:\\Users\\private\\report.docx',volumes:[{kind:'working',mount:'C:\\Users\\private',freeGb:1,usagePercent:50}]}} as any});
 assert.doesNotMatch(context,/Users|private|report.docx|EACCES/);
});

test('contexto de processos só é incluído com consentimento explícito', () => {
  const context = buildProcessMatrixContext(diagnostic, 42);
  assert.deepEqual(processPayload(context, false), {});
  assert.deepEqual(processPayload(context, true), {processIntelligence: context, processConsent: true});
});
test('contexto contém apenas contrato mínimo e nomes base, sem caminhos ou campos privados', () => {
  const context = buildProcessMatrixContext(diagnostic, 42);
  assert.equal(context.version, 1);
  assert.equal(context.selectedProcess?.name, 'chrome.exe');
  assert.equal(context.trends[0].deltaMb, 200);
  assert.doesNotMatch(JSON.stringify(context), /Users|private|commandLine|user|password/);
  assert.equal(buildProcessMatrixContext(diagnostic, 999).selectedProcess, null);
});
test('fallback usa factos medidos e identifica limites, não se apresenta como IA generativa', () => {
  const answer = buildProcessLocalReply(diagnostic, 42);
  assert.match(answer, /DIAGNÓSTICO BÁSICO OFFLINE/);
  assert.match(answer, /DADO OBSERVADO/);
  assert.match(answer, /900/);
  assert.match(answer, /200/);
  assert.match(answer, /FALTA MEDIR/);
  assert.match(answer, /RECOMENDAÇÃO/);
  assert.doesNotMatch(answer, /memória restante é cache|detetado um vírus|fuga de memória confirmada/);
});
test('perguntas de processos usam diagnóstico factual; ausência não inventa números', () => {
  for (const q of ['Porque está o meu PC a usar tanta RAM?', 'A memória deste processo está a aumentar?', 'O Chrome tem vários processos?', 'Este programa é seguro para encerrar?', 'O que está a deixar o meu PC lento?']) assert.equal(isProcessQuestion(q), true, q);
  assert.equal(isProcessQuestion('O que é phishing?'), false);
  assert.match(buildProcessLocalReply(null), /A recolher dados/);
});
test('revogar consentimento exclui mensagens com dados de processos do histórico enviado', () => {
  const history = [{role:'user',content:'O que é phishing?'}, {role:'assistant',content:'chrome.exe 900 MB',privateProcessData:true}];
  assert.deepEqual(processChatHistory(history, false), [{role:'user',content:'O que é phishing?'}]);
  assert.equal(processChatHistory(history, true).length, 2);
  assert.doesNotMatch(JSON.stringify(processChatHistory(history, true)), /privateProcessData/);
});
test('seleção ausente não se transforma silenciosamente noutro processo', () => {
  const reply = buildProcessLocalReply(diagnostic, 999);
  assert.doesNotMatch(reply, /chrome\.exe/);
  assert.match(reply, /processo selecionado não está/);
});
test('contexto geral não contorna consentimento com nomes de processos nos findings', () => {
  const context = buildMatrixContext({protection:null,hardware:null,threats:[],pcState:{overall:'attention',security:'unknown',performance:'attention',system:'unknown', findings:[{severity:'high',title:'chrome.exe usa RAM',evidence:{evidenceLines:['C:\\Users\\private\\chrome.exe 900MB']}}]} as never});
  assert.doesNotMatch(context, /chrome|Users|private/);
});

test('specific Windows process names select factual offline diagnosis',()=>{
 for(const name of ['Memory Compression','MsMpEng.exe','msedge.exe','firefox.exe']) assert.equal(isProcessQuestion(name),true);
 const selected={...diagnostic.topProcesses[0],name:'Memory Compression'};
 const compression=buildProcessLocalReply(diagnostic,42,selected);
  assert.match(compression,/comprime páginas de memória menos usadas/);
  assert.match(compression,/não encerrar/i);
  const defender=buildProcessLocalReply(diagnostic,42,{...selected,name:'MsMpEng.exe'});
  assert.match(defender,/Microsoft Defender/);
  assert.match(defender,/não confirma uma análise em curso/);
});

test('MemoryCompression offline reply has five deterministic blocks',()=>{
  const diag={...diagnostic,topProcesses:[{...diagnostic.topProcesses[0],name:'Memory Compression',pid:968}],selected:{...diagnostic.topProcesses[0],name:'Memory Compression',pid:968}};
  const reply=buildProcessLocalReply(diag,968,{pid:968,name:'Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpuPercent:3,workingSetMb:1950});
  assert.match(reply,/DIAGNÓSTICO BÁSICO OFFLINE/);
  assert.match(reply,/DADO OBSERVADO/);
  assert.match(reply,/HIPÓTESE \/ CONTEXTO/);
  assert.match(reply,/não concludente/);
  assert.match(reply,/AÇÕES SEGURAS/);
  assert.match(reply,/FALTA MEDIR/);
  assert.match(reply,/RECOMENDAÇÃO/);
});

test('MemoryCompression selected in top5 preserves PID and startedAt (no fallback to chrome)',()=>{
  const diag={...diagnostic,topProcesses:[{pid:968,name:'C:\\Windows\\System32\\Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpuPercent:3,workingSetMb:1950}]};
  const context=buildProcessMatrixContext(diag,968,{pid:968,name:'Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpu:3,memoryMb:1950,commandLine:'x',path:'p',ppid:588,user:'SYSTEM',hash:'h',trusted:{decided:true,determination:'trusted',category:'trust',confidence:0.9,evidence:[]} as never,signer:'Microsoft'});
  assert.equal(context.selectedProcess?.pid,968);
  assert.equal(context.selectedProcess?.startedAt,'2026-09-01T10:00:00.000Z');
  assert.equal(context.selectedProcess?.name,'Memory Compression');
});

test('MemoryCompression unavailable does not transform silently into another process',()=>{
  const reply=buildProcessLocalReply(diagnostic,999);
  assert.doesNotMatch(reply,/Memory Compression/);
  assert.match(reply,/processo selecionado não está/);
});

test('MemoryCompression reply never includes raw paths or private fields',()=>{
  const diag={...diagnostic,topProcesses:[{pid:968,name:'C:\\Users\\private\\Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpuPercent:3,workingSetMb:1950}]};
  const context=buildProcessMatrixContext(diag,968,{pid:968,name:'Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpu:3,memoryMb:1950,commandLine:'',path:'p',ppid:588,user:'SYSTEM',hash:'h',trusted:{decided:true,determination:'trusted',category:'trust',confidence:0.9,evidence:[]} as never,signer:'Microsoft'});
  assert.doesNotMatch(JSON.stringify(context),/Users|private|commandLine|user|password/);
});

test('MemoryCompression: WorkingSet grande nunca afirma Normal nem ameaca',()=>{
  const reply=buildProcessLocalReply({...diagnostic,ram:{totalMb:16000,usedMb:15700,availableMb:501}},968,{pid:968,name:'Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpuPercent:3,workingSetMb:1950});
  assert.match(reply,/Memory Compression/);
  assert.doesNotMatch(reply,/\bNormal\b|\bameaça confirmada\b|\bfuga de memória confirmada\b/);
});

test('MemoryCompression: RAM null nunca afirma RAM nao e baixa',()=>{
  const reply=buildProcessLocalReply({...diagnostic,ram:{totalMb:16000,usedMb:null,availableMb:null}},968,{pid:968,name:'Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpuPercent:3,workingSetMb:1950});
  assert.match(reply,/sem leitura de RAM disponível/);
  assert.doesNotMatch(reply,/RAM global não é baixa|não é baixa/);
});

test('MemoryCompression: nome com caminho usa basename, protecao texto honesto',()=>{
  const reply=buildProcessLocalReply({...diagnostic,topProcesses:[{pid:968,name:'C:\\Windows\\System32\\Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpuPercent:3,workingSetMb:1950}]},968,{pid:968,name:'C:\\Windows\\System32\\Memory Compression',startedAt:'2026-09-01T10:00:00.000Z',cpuPercent:3,workingSetMb:1950});
  assert.doesNotMatch(reply,/C:\\Windows|\\private/);
  assert.match(reply,/não encerrar.*componente/i);
  assert.doesNotMatch(reply,/protecção do sistema|não usar taskkill/i);
});
