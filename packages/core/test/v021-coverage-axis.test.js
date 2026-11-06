import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineIsDegraded } from '../dist/definitions.js';
import { clamavProbeMarker } from '../dist/clamav.js';

// v0.2.1: a perda de cobertura é um eixo próprio. Histórico RECUPERADO não pode
// deixar o motor «degradado» para o resto da sessão; perda não recuperada sim.
const health=(extra={})=>({serviceRunning:true,osLayerHealthy:true,degradedReasons:[],monitoredPaths:[],
  yara:{status:'active'},hashDb:{status:'active'},clamav:{status:'active'},nativeEngine:{status:'active'},wfp:{status:'active'},...extra});
const loss=(n)=>({queueRejections:n,queueDistinctPaths:n,queuePathsCapped:false,watcherSignals:0,watcherNamelessCallbacks:0,watcherCallbacksIndeterminate:false,raizesComPerda:[]});
const rec=(o)=>({metadataRejections:0,analysisRejections:5,pending:0,running:false,recovered:5,exhausted:0,expired:0,dropped:0,suppressed:0,cancelled:0,
  distinctPaths:5,pathsCapped:false,affectedPaths:[],lastEventAt:null,lastStage:'analysis',lastEventId:5,metadataInFlight:0,analysisQueueDepth:0,waiting:0,unrecovered:0,analysisPending:0,analysisConfirmed:5,inconclusive:0,versionUnconfirmed:0,trackedCapped:false,...o});

test('admitidos mas por analisar ainda não confirmam cobertura', () => {
  assert.equal(engineIsDegraded(health({realtimeLoss:loss(5),realtimeRecovery:rec({analysisPending:5,analysisConfirmed:0})})), true);
});
test('análise inconclusiva ou versão alterada mantém aviso', () => {
  assert.equal(engineIsDegraded(health({realtimeLoss:loss(5),realtimeRecovery:rec({inconclusive:1,analysisConfirmed:4})})), true);
  assert.equal(engineIsDegraded(health({realtimeLoss:loss(5),realtimeRecovery:rec({versionUnconfirmed:1,analysisConfirmed:4})})), true);
});
test('rejeições todas analisadas na versão atual não degradam o motor', () => {
  assert.equal(engineIsDegraded(health({realtimeLoss:loss(5),realtimeRecovery:rec({})})), false);
});
test('caminhos não recuperados continuam a degradar', () => {
  assert.equal(engineIsDegraded(health({realtimeLoss:loss(5),realtimeRecovery:rec({unrecovered:2,recovered:3})})), true);
});
test('recuperação em curso ainda não confirma cobertura', () => {
  assert.equal(engineIsDegraded(health({realtimeLoss:loss(5),realtimeRecovery:rec({pending:4,recovered:1})})), true);
});
test('serviço antigo sem desfecho de recuperação: conservador', () => {
  assert.equal(engineIsDegraded(health({realtimeLoss:loss(5)})), true);
});

test('prova a partir de degraded não publica unavailable', () => {
  const m = clamavProbeMarker({status:'degraded',detail:'Um scan do ClamAV excedeu o tempo limite e foi terminado.'});
  assert.equal(m.status,'degraded');
  assert.equal(m.busy,true);
  assert.match(m.detail,/A verificar/);
});
test('prova a partir de active mantém a última carga comprovada', () => {
  const m = clamavProbeMarker({status:'active',detail:'ok',coverage:'normal'});
  assert.equal(m.status,'active'); assert.equal(m.busy,true); assert.equal(m.coverage,'normal');
});
test('sem prova anterior nunca vira active', () => {
  const m = clamavProbeMarker({status:'unavailable',detail:'sem prova'});
  assert.equal(m.status,'unavailable'); assert.equal(m.busy,true);
});
