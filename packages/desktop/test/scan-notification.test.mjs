import {test}from'node:test';import assert from'node:assert/strict';
import {scanCompletionNotification}from'../src/scan-notification.ts';
const state={status:'completed',filesTotal:1,filesScanned:1,filesAnalyzed:1,filesInconclusive:0,filesFailed:0,threatsFound:0};
test('a real inconclusive result is reported partial, never a complete clean result',()=>{
 const message=scanCompletionNotification({...state,filesInconclusive:1});
 assert.match(message,/Análise parcial/);assert.match(message,/1 verificação inconclusiva/);assert.match(message,/nenhuma ameaça detetada/);assert.doesNotMatch(message,/Análise concluída|seguro/);
});
test('partial result retains positive detections and failed files',()=>{
 const message=scanCompletionNotification({...state,filesTotal:3,filesScanned:3,filesAnalyzed:2,filesInconclusive:1,filesFailed:1,threatsFound:1});
 assert.match(message,/parcial/);assert.match(message,/1 ameaça detetada/);assert.match(message,/1 ficheiro não analisado/);
});
test('conclusive, failed and cancelled states remain distinct',()=>{
 assert.match(scanCompletionNotification(state),/Análise concluída/);
 assert.match(scanCompletionNotification({...state,status:'failed'}),/Não foi possível concluir/);
 assert.match(scanCompletionNotification({...state,status:'cancelled'}),/Análise cancelada/);
 assert.equal(scanCompletionNotification({...state,status:'running'}),null);
});
