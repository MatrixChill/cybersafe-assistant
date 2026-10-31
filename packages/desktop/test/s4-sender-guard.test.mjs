import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as guards from "../src/ipc-guard.ts";

function handlerFixture(){
  const frame={url:"http://localhost:5173/"}; const contents={mainFrame:frame,isDestroyed:()=>false}; let effects=0;
  const handler=(...args)=>{effects++; return "allowed";};
  assert.equal(typeof guards.trustedIpcHandler,"function");
  return {frame,contents,wrap:guards.trustedIpcHandler(()=>contents,()=>"http://localhost:5173/",handler),effects:()=>effects};
}
test("S4 sender: outra janela, subframe, origem ou documento são recusados antes do handler",()=>{
  const f=handlerFixture();
  for(const event of [{sender:{...f.contents},senderFrame:f.frame},{sender:f.contents,senderFrame:{url:f.frame.url}},{sender:f.contents,senderFrame:null}])assert.throws(()=>f.wrap(event),/não autorizado/i);
  for(const url of ["https://attacker.invalid/","http://localhost:5173/other","http://localhost:5173/?attacker=1","file:///tmp/report.html"]){f.frame.url=url;assert.throws(()=>f.wrap({sender:f.contents,senderFrame:f.frame}),/não autorizado/i);}
  assert.equal(f.effects(),0);
});
test("S4 sender: frame principal e URL exatos continuam a funcionar com fragmento SPA",()=>{
  const f=handlerFixture();f.frame.url+="#/scanner";assert.equal(f.wrap({sender:f.contents,senderFrame:f.frame}),"allowed");assert.equal(f.effects(),1);
});
test("S4 report: opções do relatório não incluem preload privilegiado",()=>{
  assert.equal(typeof guards.reportWindowPreferences,"function");
  const options=guards.reportWindowPreferences();assert.equal(options.preload,undefined);assert.equal(options.nodeIntegration,false);assert.equal(options.sandbox,true);assert.equal(options.contextIsolation,true);
  const main=fs.readFileSync(new URL("../src/main.ts",import.meta.url),"utf8");
  const report=main.slice(main.indexOf('handle("app:open-report-window"'),main.indexOf('// ── Auto-Start Registration'));
  assert.match(report,/webPreferences: reportWindowPreferences()/);
});
test("S4 main: todas as inscrições IPC passam pela validação do sender",()=>{
  const main=fs.readFileSync(new URL("../src/main.ts",import.meta.url),"utf8");
  assert.equal((main.match(/ipcMain\.handle\(/g)||[]).length,1);
  assert.match(main,/ipcMain\.handle\(channel, trustedIpcHandler/);
});

test("S4 sender: documento empacotado exato, janela destruída e janela ausente",()=>{
  const frame={url:"file:///C:/CyberSafe/dist/index.html#/settings"};
  const contents={mainFrame:frame,isDestroyed:()=>false};let effects=0;
  const handler=guards.trustedIpcHandler(()=>contents,()=>"file:///C:/CyberSafe/dist/index.html",()=>effects++);
  handler({sender:contents,senderFrame:frame});assert.equal(effects,1);
  frame.url="file:///C:/CyberSafe/dist/report.html";assert.throws(()=>handler({sender:contents,senderFrame:frame}),/não autorizado/i);
  contents.isDestroyed=()=>true;assert.throws(()=>handler({sender:contents,senderFrame:frame}),/não autorizado/i);
  assert.throws(()=>guards.trustedIpcHandler(()=>null,()=>frame.url,()=>effects++)({sender:contents,senderFrame:frame}),/não autorizado/i);
  assert.equal(effects,1);
});
test("S4 spawn: produção injeta token no filho; bootstrap DEV continua externo",()=>{
  const main=fs.readFileSync(new URL("../src/main.ts",import.meta.url),"utf8");
  // TP-QA2-READINESS-20261025: o pin anterior exigia uma credência nova POR
  // PROCESSO. Medido: com um serviço filho que sobreviveu ao pai, a credência
  // nova era recusada 30 vezes em 29 322 ms e o arranque ficava sem serviço.
  // O contrato preservado é o mesmo, com outro desenho de posse: empacotado ⇒
  // credência de 64 hex só desta instalação, persistida FORA do pacote; DEV ⇒
  // `undefined` (bootstrap externo, como sempre).
  assert.match(main,/readOrCreatePipeCredential\(app\.getPath\("userData"\)\)/,
    "a credência do pipe vem do armazenamento da instalação");
  assert.doesNotMatch(main,/pipeSessionToken = app\.isPackaged \? randomBytes\(32\)/,
    "uma credência nova por processo volta a criar o lockout entre arranques");
  assert.match(main,/let pipeSessionToken: string \| undefined/,
    "em DEV a credência continua ausente");
  const cred=fs.readFileSync(new URL("../src/pipe-credential.ts",import.meta.url),"utf8");
  assert.ok(cred.includes("PIPE_CREDENTIAL_PATTERN = /^[a-f0-9]{64}$/"),
    "a forma exigida pelo serviço é a que se persiste");
  assert.match(cred,/não pode viver dentro do pacote/,
    "a credência nunca é parte do artefacto partilhado");
  assert.doesNotMatch(cred,/api-jwt-secret|INSTALLATION_SECRET_FILENAME/,
    "o pipe não reutiliza o segredo JWT da API: dois domínios de confiança");
  // P0-ISOLAR-ELECTRON-DEV: o pipe passa por `perfil.pipeName`, que é `PIPE_NAME`
  // quando empacotado (provado em test/dev-isolation-matrix.test.mjs). O que este
  // pin protege continua a ser o contrato: pipe canónico no artefacto e token só
  // quando empacotado.
  assert.match(main,/new ServiceClient\(perfil\.pipeName, pipeSessionToken\)/);
  const spawn=main.slice(main.indexOf("function startServiceProcess()"),main.indexOf("function startPackagedApi()"));
  assert.match(spawn,/if \(!app.isPackaged\)[\s\S]*?return \{ status: "connected" \}/,
    "o DEV continua a devolver cedo, agora com estado discriminado");
  // DIST-CLAMAV13OUT (2026-10-13): o env do filho passou a ser construído por
  // `serviceEnv(pipeToken)`, porque tem de levar TAMBÉM o pin do motor ClamAV
  // empacotado. A asserção mantém-se sobre o MESMO comportamento (produção
  // injecta o token da instalação e NODE_ENV=production) e passa a verificar os
  // dois lados: que o spawn usa a função e que a função injecta os dois valores.
  assert.match(spawn,/env: serviceEnv\(pipeSessionToken\)/,
    "o env do filho tem de vir da função que o constrói, não de um literal inline");
  const serviceEnv=main.slice(main.indexOf("function serviceEnv("),main.indexOf("function startServiceProcess()"));
  // `\s+` e não um espaço: o objecto é multi-linha (CRLF) — a asserção mede a
  // presença dos dois valores, não a formatação.
  assert.match(serviceEnv,/NODE_ENV: "production",\s+CYBERSAFE_PIPE_TOKEN: pipeToken,/,
    "produção injecta NODE_ENV=production e o token da instalação no filho");
  assert.match(serviceEnv,/if \(fs\.existsSync\(bundledClamscan\)\) env\[CLAMAV_BINARY_ENV\] = bundledClamscan/,
    "o pin do motor só é definido quando o ficheiro existe (nunca um pin fantasma)");
});
