import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {interpretProtectionToggle,requestProtectionToggle} from '../src/protection-toggle-result.ts';
test('OFF vivo confirmado não esconde falha da revogação persistida',()=>{
 const r=interpretProtectionToggle({ok:true,protectionEnabled:false,revogacaoRetoma:'nao_confirmada',motivoRevogacao:'escrita_falhou'},'stop');
 assert.equal(r.ok,true);assert.equal(r.protectionEnabled,false);assert.equal(r.revogacaoRetoma,'nao_confirmada');assert.match(r.reason,/voltar a iniciar/);
});
test('revogação confirmada atravessa a ponte sem inventar aviso',()=>{
 const r=interpretProtectionToggle({ok:true,protectionEnabled:false,revogacaoRetoma:'confirmada'},'stop');assert.equal(r.revogacaoRetoma,'confirmada');assert.equal(r.reason,undefined);
});
test('serviço antigo ou flag inválida não comprovam revogação',()=>{
 for(const flag of [undefined,'yes',true]){const r=interpretProtectionToggle({ok:true,protectionEnabled:false,revogacaoRetoma:flag},'stop');assert.equal(r.ok,true);assert.match(r.reason,/não foi confirmada/);assert.equal(r.revogacaoRetoma,undefined);}
});
test('pedido real conserva as duas dimensões sem transportar motivo privado',async()=>{
 const r=await requestProtectionToggle(async()=>({ok:true,protectionEnabled:false,revogacaoRetoma:'nao_confirmada',motivoRevogacao:'C:/Users/private/file-secret'}),false);
 assert.equal(r.protectionEnabled,false);assert.equal(r.revogacaoRetoma,'nao_confirmada');assert.doesNotMatch(JSON.stringify(r),/private|file-secret/);
});
test('ativação não recebe aviso de revogação',()=>{
 const r=interpretProtectionToggle({ok:true,protectionEnabled:true},'start');assert.equal(r.reason,undefined);assert.equal(r.revogacaoRetoma,undefined);
});

test('payload de toggle não booleano nunca chega ao serviço',async()=>{
 for(const enabled of ['false','true',0,1,null,undefined,{},[]]){
  let calls=0;const r=await requestProtectionToggle(async()=>{calls++;return {ok:true,protectionEnabled:true};},enabled);
  assert.equal(calls,0);assert.equal(r.ok,false);assert.equal(r.protectionEnabled,null);
 }
});

test('main não converte strings em booleans antes da guarda executada',()=>{
 const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/setProtectionEnabled\(Boolean\(enabled\)\)/);
});
