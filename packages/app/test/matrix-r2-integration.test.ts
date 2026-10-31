import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {codigoDeConsentimentoRecusado, CODIGOS_AUTORIZACAO_UNICA} from '../src/lib/matrixExternalConsent';
import {estadoDoPedido} from '../src/lib/matrixRequestMachine';

test('o envio recebe o token capturado mesmo depois de a referencia reutilizavel ser limpa', async () => {
  const source=readFileSync(new URL('../src/components/AIAssistant.tsx',import.meta.url),'utf8');
  const start=source.indexOf('      let attempts = 0');
  const end=source.indexOf('          if (deveDescartarResposta()) return',start);
  assert.ok(start>=0 && end>start,'bloco de envio real presente');
  // Execute the actual component dispatch, including clearing its shared ref.
  // A helper-only payload test did not catch passing ref.current after clearing it.
  const body=source.slice(start,end)+'return result; } catch(error) {throw error;} }';
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const names=['modoDoEnvio','isRetry','MAX_RETRIES','autorizacoesOneShotRef',
    'chaveConsentimento','autorizacaoUnicaRef','setAutorizacoes','revogarAlvo',
    'alvoConsentimento','controller','sendToServer','payloadHistory','deveDescartarResposta',
    'setPhase','consentimentoProcesso','alvoDoHistorico','anexarContexto'];
  const authorization={token:'fixture-token',target:{pid:123,startedAt:'2026-10-24T10:00:00.000Z'}};
  const ref={current:authorization as typeof authorization|null};
  const permission={current:new Set(['target'])};
  const sent:unknown[]=[];
  const send=async (...args:unknown[])=>{sent.push(args.at(-1));return {ok:true,content:'fixture'};};
  await new AsyncFunction(...names,body)('uma-vez',false,2,permission,'target',ref,
    (fn:(p:unknown[])=>unknown)=>fn([]),(p:unknown)=>p,authorization.target,
    new AbortController(),send,[],()=>false,()=>{},true,authorization.target,true);
  assert.equal(sent.length,1);
  assert.equal(sent[0],authorization,'capacidade deste envio nao pode ser null');
  assert.equal(ref.current,null,'referencia reutilizavel consumida antes do envio');
  assert.equal(permission.current.size,0);
});

test('todas as recusas R2 fecham como consentimento recusado, sem retry de fornecedor',()=>{
  for(const code of CODIGOS_AUTORIZACAO_UNICA){
    assert.equal(codigoDeConsentimentoRecusado(code),true,code);
    assert.equal(estadoDoPedido({motivo:null,pediuProvider:true,ok:false,code}),'pedido-recusado',code);
  }
});
