import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarHistoricoProcessos } from '../src/lib/processIntelligence.ts';
const proc = (pid = 500, startedAt = '2026-10-14T10:00:00.000Z', memoryMb = 100) => ({pid, startedAt, name:'chrome.exe', cpu:30, memoryMb}) as any;
test('uses measured global CPU/RAM, excludes idle, and never sums working sets', () => {
  const h=criarHistoricoProcessos();const ps=[proc(),proc(0,undefined,9000)];h.registar(ps,100000);
  const d=h.diagnosticar({cpu:{usage:5},ram:{totalGb:16,usedGb:8}} as any,ps,100000);
  assert.equal(d.cpuPercent,5);assert.equal(d.ram.usedMb,8192);assert.equal(d.topProcesses.length,1);
  assert.match(d.limitations.join(' '),/Working Set/);
});
test('trend requires three timed samples of same instance and is bounded to current processes',()=>{
  const h=criarHistoricoProcessos();h.registar([proc()],100000);h.registar([proc(500,undefined,150)],115000);h.registar([proc(500,undefined,200)],130000);
  const d=h.diagnosticar(null,[proc(500,undefined,200)],130000);assert.equal(d.trends[0].deltaMb,100);
  assert.equal(d.trends[0].samples,3);assert.equal(h.diagnosticar(null,[proc(500,'2026-10-14T11:00:00.000Z')],130000).trends.length,0);
  assert.equal(h.diagnosticar(null,[],130000).trends.length,0);
});
test('missing identity, duplicate timestamp, stale data and invalid values cannot invent trends',()=>{
  const h=criarHistoricoProcessos();for(const t of [100000,115000,130000])h.registar([{...proc(),startedAt:''}],t);
  assert.equal(h.diagnosticar(null,[{...proc(),startedAt:''}],130000).trends.length,0);
  h.limpar();for(let i=0;i<3;i++)h.registar([proc()],100000);
  assert.equal(h.diagnosticar(null,[proc()],130000).trends.length,0);
  const d=h.diagnosticar(null,[{...proc(),cpu:NaN,memoryMb:-1}],500000);
  assert.equal(d.topProcesses.length,0);assert.equal(d.cpuPercent,null);
});
test('protected processes never receive a termination recommendation',()=>{
  const h=criarHistoricoProcessos();const p={...proc(),name:'lsass.exe'};h.registar([p],100000);
  const d=h.diagnosticar(null,[p],100000);assert.match(d.recommendations.join(' '),/críticos|protegidos/);
  assert.doesNotMatch(d.recommendations.join(' '),/terminar lsass|encerrar lsass/);
});

 test('frequent updates retain enough elapsed time for a measured trend',()=>{
  const h=criarHistoricoProcessos();
  for(let t=100000;t<=160000;t+=100) h.registar([proc(500,undefined,(t-100000)/1000+100)],t);
  const d=h.diagnosticar(null,[proc(500,undefined,160)],160000);
  assert.equal(d.trends.length,1);
  assert.ok(d.trends[0].intervalMs>=30000);
  assert.ok(d.trends[0].samples<=30);
 });
