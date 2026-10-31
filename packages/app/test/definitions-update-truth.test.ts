import { it } from 'node:test';
import assert from 'node:assert/strict';
import { definitionUpdatePresentation, definitionUpdateCard } from '../src/lib/definitionUpdateResult';
const all={success:true,updatedAt:'2026-10-18T20:00:00.000Z',yaraUpdated:true,clamUpdated:true,hashesUpdated:true,errors:[],warnings:[]};
it('success:true legado não prova que as definições foram atualizadas',()=>{const p=definitionUpdatePresentation({success:true,updatedAt:all.updatedAt});assert.equal(p.status,'unverified');assert.equal(p.confirmed,false);assert.doesNotMatch(p.message,/^Definições atualizadas/);});
it('falha YARA com outro motor atualizado é parcial e nunca sucesso integral',()=>{const p=definitionUpdatePresentation({...all,yaraUpdated:false,errors:['YARA source: HTTP404']});assert.equal(p.status,'partial');assert.equal(p.confirmed,false);assert.match(p.message,/parcial/i);assert.match(p.details,/YARA: não atualizado/);});
it('todos falham: falha sem data fictícia de conclusão',()=>{const p=definitionUpdatePresentation({...all,yaraUpdated:false,clamUpdated:false,hashesUpdated:false,errors:['erro']});assert.equal(p.status,'failed');assert.equal(p.confirmed,false);assert.equal(p.updatedAt,null);});
it('só todos os componentes confirmados sem erros/avisos são sucesso integral',()=>{const p=definitionUpdatePresentation(all);assert.equal(p.status,'updated');assert.equal(p.confirmed,true);assert.equal(p.updatedAt,all.updatedAt);});
it('avisos e payloads inválidos não podem dar sucesso integral',()=>{assert.equal(definitionUpdatePresentation({...all,warnings:['cobertura limitada']}).confirmed,false);for(const value of [null,[],true,{success:true,yaraUpdated:'true'}]) assert.equal(definitionUpdatePresentation(value).confirmed,false);});
it('success:false prevalece mesmo com flags contraditórias',()=>{assert.equal(definitionUpdatePresentation({...all,success:false}).status,'failed');});

import { cartoesIniciais } from '../src/lib/optimizeModel';
it('cartão usado pelo clique real não fica corrigido em legado/parcial/falha',()=>{
 const card=cartoesIniciais().find(x=>x.id==='update')!;
 for(const result of [{success:true,updatedAt:all.updatedAt},{...all,yaraUpdated:false,errors:['falha']},{...all,success:false}]) {
  const next=definitionUpdateCard(card,result);assert.notEqual(next.estado,'corrigido');assert.notEqual(next.resultado,'sem-problema');
 }
 assert.equal(definitionUpdateCard(card,all).estado,'corrigido');
});
it('detalhes do cliente não ecoam caminhos ou segredos de erros',()=>{
 const p=definitionUpdatePresentation({...all,yaraUpdated:false,errors:['segredo-test-token caminho-pessoal']});
 assert.doesNotMatch(p.details+p.message,/segredo-test-token|caminho-pessoal/);
});
