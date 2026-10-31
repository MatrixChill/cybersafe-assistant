import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cybersafe-recovery-chat-'));
const bodies=[];
const provider=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);bodies.push(body);
  if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'Resposta sintética.'}}]})+'\n\ndata: [DONE]\n\n');}
  else {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'Resposta sintética.'}}]}));}
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
Object.assign(process.env,{CYBERSAFE_DEV_ISOLATION:'1',CYBERSAFE_DEV_ROOT:temp,CYBERSAFE_API_PORT:'4203',CYBERSAFE_DB_PATH:path.join(temp,'test.db'),CYBERSAFE_API_NO_LISTEN:'1',JWT_SECRET:'recovery-only-synthetic-secret-123456789',CYBERSAFE_AI_API_KEY:'synthetic-provider',CYBERSAFE_AI_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,CYBERSAFE_AI_MODEL:'synthetic'});
const {app}=await import('../dist/index.js');const {closeDb}=await import('../dist/db.js');
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>provider.close(r));closeDb();await fs.rm(temp,{recursive:true,force:true});});
const registration=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Recovery',email:'recovery@fixture.local',password:'synthetic-pass-123',type:'personal',plan:'free'})});
assert.equal(registration.status,201);const {token}=await registration.json();
const payload={version:1,measuredAt:'2026-10-14T11:00:00.000Z',ram:{totalMb:16000,usedMb:8000,availableMb:8000},cpuPercent:10,topProcesses:[{pid:500,name:'fixture.exe',startedAt:null,cpuPercent:2,workingSetMb:20}],selectedProcess:null,trends:[],limitations:['Working Set não é memória privada.']};
const post=(body,auth=true)=>fetch(base+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
// TP-MATRIX-R2-CONSENT: a autorização de enviar telemetria já não vai no corpo do
// chat (`processConsent: true` deixou de autorizar nada). Cria-se aqui o grant
// persistente que o servidor emite — é o caminho real do produto.
const descriptor=await (await fetch(base+'/api/ai/process-consent',{headers:{Authorization:`Bearer ${token}`}})).json();
const grantRes=await fetch(base+'/api/ai/process-consent',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({providerKey:descriptor.descriptor.providerKey,purpose:descriptor.descriptor.purpose,fields:descriptor.descriptor.fields,allowFutureProcesses:true,persistent:true})});
assert.equal(grantRes.status,200,'fixture: grant persistente');
const {grant}=await grantRes.json();
test('auth, consent and malformed process data refuse before provider in JSON and stream',async()=>{
  for(const stream of [false,true]){
    for(const extra of [{processIntelligence:payload},{processIntelligence:{...payload,path:'private'},consentGrantId:grant.id},{processIntelligence:payload,processConsent:true}]){
      const before=bodies.length;const res=await post({messages:[{role:'user',content:'CPU?'}],stream,...extra});
      assert.equal(res.status,400);assert.equal(bodies.length,before);
    }
  }
  assert.equal((await post({messages:[]},false)).status,401);
});
test('validated context reaches synthetic provider in both transports; credential guard still applies',async()=>{
  for(const stream of [false,true]){
    const res=await post({messages:[{role:'user',content:'Explica CPU.'}],stream,processIntelligence:payload,consentGrantId:grant.id});
    assert.equal(res.status,200);assert.match(await res.text(),/Resposta sintética/);
    const sent=JSON.stringify(bodies.at(-1));assert.match(sent,/FACTO MEDIDO/);assert.match(sent,/fixture.exe/);assert.doesNotMatch(sent,/commandLine|privateProcessData/);
  }
  const before=bodies.length;
  const res=await post({messages:[{role:'user',content:'Explica.'}],processIntelligence:{...payload,limitations:['api_key=syntheticsecret123456789']},consentGrantId:grant.id});
  assert.equal(res.status,400);assert.equal(bodies.length,before);
});
