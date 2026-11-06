import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeRecovery} from '../dist/realtime-recovery.js';
import {RealtimeFileQueue} from '../dist/realtime-file-queue.js';

/**
 * v0.2.1 — incidente de 06/11 (2 196 tentativas, 863 caminhos).
 *
 * A recuperação deitava fora tudo acima de 128 caminhos e media «recuperado»
 * só pelas suas próprias tentativas. Um caminho que voltava a ser observado e
 * admitido continuava contado como perdido; um caminho largado por orçamento
 * nunca era dito como lacuna. Aqui fixa-se:
 *  - o backlog guarda caminhos (não conteúdo) até um teto rígido maior;
 *  - `unrecovered` = caminhos afetados cuja versão mais recente nunca entrou;
 *  - uma admissão nova do mesmo caminho resolve-o;
 *  - depois de uma admissão aceite não há recuo cego; a fila acorda a recuperação.
 */
function harness(options={}) {
  let time=0; let seq=0; const timers=new Map(); const delays=[];
  const r=new RealtimeRecovery({...options,now:()=>time,
    setTimer:(fn,delay)=>{delays.push(delay);timers.set(++seq,fn);return seq;},
    clearTimer:id=>timers.delete(id)});
  return {r,timers,delays,advance:ms=>{time+=ms;},
    async tick(){const first=timers.entries().next().value;if(first){timers.delete(first[0]);first[1]();}for(let i=0;i<8;i++)await Promise.resolve();}};
}

test('rajada acima de 128 caminhos não é largada por orçamento', () => {
  const h=harness();
  for(let i=0;i<863;i++) h.r.defer(`C:/tmp/pkg-${i}`,'analysis',async()=>false);
  const s=h.r.snapshot();
  assert.equal(s.dropped,0);
  assert.equal(s.pending,863);
  assert.equal(s.distinctPaths,863);
  assert.equal(s.unrecovered,0, 'em espera não é perda');
});

test('acima do teto rígido, o excedente conta como não recuperado', () => {
  const h=harness({maxPaths:3});
  for(const p of ['a','b','c','d','e']) h.r.defer(p,'analysis',async()=>false);
  const s=h.r.snapshot();
  assert.equal(s.dropped,2);
  assert.equal(s.unrecovered,2);
});

test('admissão não é análise: só o veredicto da versão admitida confirma', () => {
  const h=harness({maxPaths:1});
  h.r.defer('a','analysis',async()=>false);
  h.r.defer('b','analysis',async()=>false); // largado por orçamento
  assert.equal(h.r.snapshot().unrecovered,1);
  h.r.noteAdmitted('B','v1');
  h.r.noteAdmitted('A','v1');
  let s=h.r.snapshot();
  assert.equal(s.unrecovered,0);
  assert.equal(s.pending,0);
  assert.equal(s.recovered,2,'admissões recuperadas');
  assert.equal(s.analysisPending,2,'admitido ainda não analisado');
  assert.equal(s.analysisConfirmed,0);
  h.r.noteAnalyzed('a','v1','verdict');
  h.r.noteAnalyzed('b','v1','inconclusive');
  s=h.r.snapshot();
  assert.equal(s.analysisConfirmed,1);
  assert.equal(s.inconclusive,1);
});

test('ficheiro alterado durante a espera: só a versão mais recente conta', () => {
  const h=harness();
  h.r.defer('a','analysis',async()=>false);
  h.r.noteAdmitted('a','v1');
  h.r.noteAdmitted('a','v2'); // a fila substituiu a versão em espera
  h.r.noteAnalyzed('a','v1','verdict'); // conclusão tardia da versão antiga
  assert.equal(h.r.snapshot().analysisConfirmed,0);
  assert.equal(h.r.snapshot().analysisPending,1);
  h.r.noteAnalyzed('a','v2','verdict');
  assert.equal(h.r.snapshot().analysisConfirmed,1);
});

test('ficheiro alterado durante a análise fica com versão não confirmada', () => {
  const h=harness();
  h.r.defer('a','analysis',async()=>false);
  h.r.noteAdmitted('a','v1');
  h.r.noteAnalyzed('a','v1','changed');
  assert.equal(h.r.snapshot().versionUnconfirmed,1);
  h.r.recordRejection('a','analysis'); // nova versão rejeitada numa repetição
  assert.equal(h.r.snapshot().versionUnconfirmed,0);
  assert.equal(h.r.snapshot().unrecovered,1,'sem repetição pendente: lacuna');
});

test('confirmado é reaberto por nova rejeição da mesma chave', () => {
  const h=harness();
  h.r.defer('a','analysis',async()=>false);
  h.r.noteAdmitted('a','v1'); h.r.noteAnalyzed('a','v1','verdict');
  assert.equal(h.r.snapshot().analysisConfirmed,1);
  h.r.defer('a','analysis',async()=>false);
  assert.equal(h.r.snapshot().analysisConfirmed,0);
});

test('ficheiro removido antes da análise não é dado como confirmado', () => {
  const h=harness();
  h.r.defer('a','analysis',async()=>false);
  h.r.noteVanished('a');
  assert.equal(h.r.snapshot().versionUnconfirmed,1);
  assert.equal(h.r.snapshot().pending,0);
});

test('caminhos não afetados não são seguidos', () => {
  const h=harness();
  h.r.noteAdmitted('livre','v1'); h.r.noteAnalyzed('livre','v1','verdict');
  assert.equal(h.r.snapshot().analysisConfirmed,0);
});

test('reinício (clear) apaga seguimento e não deixa timers', async () => {
  const h=harness();
  h.r.defer('a','analysis',async()=>false); h.r.noteAdmitted('a','v');
  h.r.defer('b','analysis',async()=>false);
  h.r.clear();
  const s=h.r.snapshot();
  assert.equal(s.pending,0); assert.equal(s.analysisPending,0); assert.equal(s.unrecovered,0); assert.equal(s.waiting,0);
  assert.equal(h.timers.size,0);
});

test('caminho esgotado e nunca admitido fica não recuperado', async () => {
  const h=harness({maxAttempts:2});
  h.r.defer('a','analysis',async()=>false);
  await h.tick(); await h.tick();
  const s=h.r.snapshot();
  assert.equal(s.exhausted,1);
  assert.equal(s.unrecovered,1);
});

test('depois de uma admissão aceite a próxima tentativa não espera recuo', async () => {
  const h=harness();
  h.r.defer('slow','analysis',async()=>false);
  h.r.defer('next','analysis',async()=>true);
  await h.tick();
  assert.ok(h.delays.at(-1)>0, 'recusa aplica recuo');
  await h.tick();
  assert.equal(h.r.snapshot().recovered,1);
  assert.equal(h.delays.at(-1),0, 'admissão aceite não deixa recuo para o seguinte');
});

test('nudge acorda a recuperação imediatamente', async () => {
  const h=harness();
  h.r.defer('a','analysis',async()=>false);
  await h.tick(); await h.tick(); await h.tick();
  assert.ok(h.delays.at(-1)>0);
  h.r.nudge();
  assert.equal(h.delays.at(-1),0);
  assert.equal(h.timers.size,1);
});

test('onIdle avisa quando o backlog esvazia', async () => {
  let idle=0;
  const h=harness({onIdle:()=>idle++});
  h.r.defer('a','analysis',async()=>true);
  await h.tick();
  assert.equal(idle,1);
  h.r.defer('b','analysis',async()=>false);
  h.r.noteAdmitted('b','v1');
  assert.equal(idle,2);
});

test('fila avisa quando abre espaço', async () => {
  let space=0;
  const q=new RealtimeFileQueue(2);
  q.onSpace(()=>space++);
  let release;
  q.enqueue('a','1',()=>new Promise(r=>release=r));
  q.enqueue('b','1',async()=>{});
  assert.equal(q.enqueue('c','1',async()=>{}),'queued');
  assert.equal(q.enqueue('d','1',async()=>{}),'full');
  release();
  for(let i=0;i<20;i++) await Promise.resolve();
  assert.ok(space>=1);
});
