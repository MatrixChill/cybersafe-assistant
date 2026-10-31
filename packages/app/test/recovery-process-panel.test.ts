import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import TaskManagerPage from '../src/pages/TaskManagerPage.tsx';
import {criarHistoricoProcessos} from '../src/lib/processIntelligence.ts';
(globalThis as any).React=React;
test('painel colapsado por defeito: resumo honesto, sem Top5 duplicado (PACOTE C)',()=>{
  const p={pid:500,ppid:0,name:'fixture.exe',cpu:5,memoryMb:100,startedAt:'2026-10-14T10:00:00.000Z',path:'',commandLine:'',trusted:'neutral'} as any;
  const h=criarHistoricoProcessos();h.registar([p],100000);
  const diagnostic=h.diagnosticar(null,[p],100000);
  const html=renderToStaticMarkup(React.createElement(TaskManagerPage,{processes:[p],diagnostic,onExplainProcess:()=>{}} as any));
  assert.match(html,/Diagnóstico inteligente/);
  assert.match(html,/aria-expanded="false"/,'o painel abriu-se por defeito');
  assert.match(html,/Ver explicação/);
  assert.match(html,/Medições a acumular/, 'uma amostra única não pode parecer tendência');
  assert.doesNotMatch(html,/Top 5 por RAM/, 'o painel voltou a duplicar o Top5 da tabela');
  assert.doesNotMatch(html,/fuga de memória confirmada/);
});

test('resumo distingue falta de identidade (PACOTE C, sem fabricar timer)',()=>{
  const semInstante={pid:501,ppid:0,name:'x.exe',cpu:0,memoryMb:200,startedAt:'',path:'',commandLine:'',trusted:'neutral'} as any;
  const h=criarHistoricoProcessos();h.registar([semInstante],100000);
  const diagnostic=h.diagnosticar(null,[semInstante],100000);
  const html=renderToStaticMarkup(React.createElement(TaskManagerPage,{processes:[semInstante],diagnostic} as any));
  assert.match(html,/sem instante de início/,'identidade ausente tem de se dizer, não esconder atrás de tempo');
});

test('before the first confirmed process sample the panel states data is loading',()=>{
 const html=renderToStaticMarkup(React.createElement(TaskManagerPage,{processes:[]}));
 assert.match(html,/Ainda não há uma amostra confirmada/);
});

test('any visible process can be explained without restoring the duplicated Top 5 panel',()=>{
 const processes=['chrome.exe','Memory Compression'].map((name,i)=>({pid:500+i,ppid:0,name,cpu:1,memoryMb:100,startedAt:'2026-10-14T10:00:00Z',path:'',commandLine:'',trusted:'neutral'}));
 const html=renderToStaticMarkup(React.createElement(TaskManagerPage,{processes,onExplainProcess:()=>{}} as any));
 assert.ok(html.includes('aria-label="Explicar Memory Compression na MATRIX"'));
 assert.ok(html.includes('aria-label="Explicar chrome.exe na MATRIX"'));
 assert.doesNotMatch(html,/Top 5 por RAM/);
});
