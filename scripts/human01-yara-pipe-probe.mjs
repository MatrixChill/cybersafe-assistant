import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
if(!process.argv.includes('--run-fixtures')) {
 console.log('Plano: pipe autenticado exclusivo + serviço sem init/monitor, duas fixtures benignas temporárias, política warn, sem VT. Usar --run-fixtures.');
} else {
 process.env.NODE_ENV='test';process.env.CYBERSAFE_USB_PROTECTION='0';delete process.env.VIRUSTOTAL_API_KEY;
 const token=randomBytes(32).toString('hex');process.env.CYBERSAFE_PIPE_TOKEN=token;
 const {ProtectionEngineService}=await import('../packages/service/dist/engine.js');
 const {encodeMessage,decodeMessages}=await import('../packages/core/dist/index.js');
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const source=path.join(os.homedir(),'.cybersafe-service/definitions/yara/default.yar');const corpus=await fs.readFile(source);
 if(hash(corpus)!=='9cbd9fb38ff2e8c9fc30fbf730c14b709cad4c082fe752f86c17004a82654cc8')throw Error('Corpus mudou: rever plano');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cybersafe-yara-pipe-fixtures-'));
 const pipe=process.platform==='win32'?[String.fromCharCode(92).repeat(2)+'.','pipe','cybersafe-yara-probe-'+randomBytes(16).toString('hex')].join(String.fromCharCode(92)):path.join(root,'test.sock');
 let service,socket;const pending=new Map();let buffer='';let sequence=0;
 try {
  service=new ProtectionEngineService(path.join(root,'service'));
  const rules=path.join(root,'rules.yar');await fs.writeFile(rules,corpus);await service.yara.load(rules);
  if(service.protectionState!==false||service.quarantinePolicy!=='warn'||service.vt.isEnabled())throw Error('Gate de segurança recusado');
  await service.startPipeServer(pipe); // Parâmetro EXPLÍCITO aleatório; nunca PIPE_NAME pessoal.
  socket=net.createConnection(pipe);
  socket.on('data',chunk=>{const decoded=decodeMessages(buffer+chunk.toString());buffer=decoded.rest;for(const message of decoded.messages){const key=message.type==='auth'?'auth':message.id;const waiter=pending.get(key);if(waiter){pending.delete(key);clearTimeout(waiter.timer);waiter.resolve(message);}}});
  socket.on('error',()=>{for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(Error('Erro do pipe de teste'));}pending.clear();});
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const receive=(key,ms=40_000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(key);reject(Error('Prazo do pedido de teste excedido'));},ms);pending.set(key,{resolve,reject,timer});});
  const handshake=receive('auth',3000);socket.write(encodeMessage({type:'auth',token}));if(!(await handshake).ok)throw Error('Autenticação recusada');
  const request=async(method,payload)=>{if(!['protection.getState','scan.artifact'].includes(method))throw Error('Método fora do plano');const id=String(++sequence);const response=receive(id);socket.write(encodeMessage({id,type:'request',method,payload}));const message=await response;if(!message.ok)throw Error('Pedido de teste recusado');return message.result;};
  const before=await request('protection.getState');if(before.protectionEnabled!==false||before.stats.quarantinePolicy!=='warn')throw Error('Estado remoto recusa scan de fixture');
  const cases=[];
  for(const [name,bytes] of [['crc.bin',Buffer.from([0x78,0x3b,0xf6,0x82])],['negative.txt',Buffer.from('Texto benigno de controlo CyberSafe 2026.')]]){
   const file=path.join(root,name);await fs.writeFile(file,bytes);
   const result=await request('scan.artifact',{path:file});const item=result?.results?.[0];if(!item)throw Error('Resultado ausente');
   cases.push({case:name,rules:result.rulesTriggered,verdict:item.verdict,analysisState:item.analysisState,riskScore:result.riskScore,fixtureUnchanged:hash(await fs.readFile(file))===hash(bytes)});
  }
  const after=await request('protection.getState');
  const pass=cases[0].rules.includes('yara_match')&&!cases[1].rules.includes('yara_match')&&cases.every(c=>c.fixtureUnchanged)&&after.protectionEnabled===false&&service.quarantine.list().length===0;
  const result={at:new Date().toISOString(),context:'real service instance + real authenticated dedicated named pipe + real scan.artifact; no init/monitor/installed daemon',corpusSha256:hash(corpus),yara:after.engine.yara,cases,protectionEnabled:after.protectionEnabled,quarantineCount:service.quarantine.list().length,sourceUnchanged:hash(await fs.readFile(source))===hash(corpus),pass};
  await fs.writeFile(new URL('../output/human-review-20261018/HUMAN01-YARA-PIPE.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!pass)process.exitCode=1;
 }finally{
  for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(Error('Encerramento da sonda'));}pending.clear();socket?.destroy();if(service)await service.dispose();await fs.rm(root,{recursive:true,force:true});
 }
}
