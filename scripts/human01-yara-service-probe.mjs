import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
if (!process.argv.includes('--run-fixtures')) {
 console.log('Plano: instância real do serviço, sem init/listen/monitor, duas fixtures temporárias benignas readOnly; nenhum ficheiro pessoal como alvo. Usar --run-fixtures.');
} else {
 process.env.NODE_ENV='test';process.env.CYBERSAFE_USB_PROTECTION='0';delete process.env.VIRUSTOTAL_API_KEY;
 const {ProtectionEngineService}=await import('../packages/service/dist/engine.js');
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const source=path.join(os.homedir(),'.cybersafe-service/definitions/yara/default.yar');
 const corpus=await fs.readFile(source);
 if(hash(corpus)!=='9cbd9fb38ff2e8c9fc30fbf730c14b709cad4c082fe752f86c17004a82654cc8')throw Error('Corpus mudou; rever plano');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cybersafe-yara-service-fixtures-'));let service;
 try {
  const rules=path.join(root,'rules.yar');await fs.writeFile(rules,corpus);
  service=new ProtectionEngineService(path.join(root,'service'));
  // Sem init(): não abre pipe, watchers, updater, hardware polling ou proteção.
  await service.yara.load(rules);
  // A sonda é YARA. ClamAV explicitamente não exercido; erro não vira clean.
  const cases=[];
  for (const [name,bytes] of [['crc.bin',Buffer.from([0x78,0x3b,0xf6,0x82])],['negative.txt',Buffer.from('Texto benigno de controlo CyberSafe 2026.')]]) {
   const target=path.join(root,name);await fs.writeFile(target,bytes);
   const result=await service.scanArtifact(target,'system-scanner',{readOnly:true,skipVirusTotal:true,clamavOutcome:{file:target,verdict:'error',detail:'ClamAV não exercido nesta sonda YARA.'}});
   const actual=result?.results?.[0];
   if(!actual)throw Error('Sem resultado real do serviço');
   cases.push({case:name,verdict:actual.verdict,analysisState:actual.analysisState,rules:result.rulesTriggered,riskScore:result.riskScore,fixtureUnchanged:hash(await fs.readFile(target))===hash(bytes)});
  }
  const pass=cases[0].rules.includes('yara_match')&&!cases[1].rules.includes('yara_match')&&cases.every(c=>c.fixtureUnchanged)&&cases[1].verdict==='inconclusive'&&service.quarantine.list().length===0&&service.protectionState===false;
  const result={at:new Date().toISOString(),context:'real ProtectionEngineService instance + scanArtifact; no init, pipe, installed process or GUI',corpusSha256:hash(corpus),yara:service.yara.health,cases,protectionEnabled:service.protectionState,quarantineCount:service.quarantine.list().length,sourceUnchanged:hash(await fs.readFile(source))===hash(corpus),pass};
  await fs.writeFile(new URL('../output/human-review-20261018/HUMAN01-YARA-SERVICE.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!pass)process.exitCode=1;
 } finally { if(service)await service.dispose();await fs.rm(root,{recursive:true,force:true}); }
}
