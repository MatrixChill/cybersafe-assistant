import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync, spawn} from "node:child_process";
import net from "node:net";

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"cybersafe-preflight-test-"));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const user=path.join(root,"electron");fs.mkdirSync(user);
 const env={...process.env,CYBERSAFE_DEV_ISOLATION:"1",CYBERSAFE_DEV_SERVICE_DIR:root,CYBERSAFE_DEV_PIPE_NAME:`\\\\.\\pipe\\cybersafe-test-${process.pid}-${Math.random().toString(16).slice(2)}`,CYBERSAFE_DB_PATH:path.join(root,"test.db"),CYBERSAFE_DEV_USER_DATA_DIR:user,CYBERSAFE_API_PORT:"4510"};
 return {root,env};
}
function run(env){return spawnSync(process.execPath,["scripts/dev-isolated-preflight.mjs"],{env,encoding:"utf8",timeout:10000});}
// O gate usa os VALIDADORES REAIS do core (`packages/core/dist/dev-isolation.js`).
// Numa lane sem produto compilado o import falha e as camadas SERVIÇO/Electron
// bloqueiam por cima — o veredito da PORTA é decidido antes e continua observável,
// por isso os casos de porta correm sempre e só o `GO` completo pede o build.
const CORE_COMPILADO=path.join("packages","core","dist","dev-isolation.js");
test("complete isolated fixture can pass without starting any app",t=>{
 if(!fs.existsSync(CORE_COMPILADO)){t.diagnostic(`salto: ${CORE_COMPILADO} ausente nesta lane (sem builds); o gate não pode declarar GO sem os validadores reais do core.`);return;}
 const {env}=fixture(t);const r=run(env);assert.equal(r.status,0,r.stdout+r.stderr);});
test("missing API DB must block, never claim GO",t=>{const {env}=fixture(t);delete env.CYBERSAFE_DB_PATH;const r=run(env);assert.equal(r.status,2,r.stdout);});
test("missing explicit Electron profile must block",t=>{const {env}=fixture(t);delete env.CYBERSAFE_DEV_USER_DATA_DIR;const r=run(env);assert.equal(r.status,2,r.stdout);});
test("service root must be a directory, not an existing regular file",t=>{const {root,env}=fixture(t);const file=path.join(root,"regular");fs.writeFileSync(file,"benign");env.CYBERSAFE_DEV_SERVICE_DIR=file;const r=run(env);assert.equal(r.status,2,r.stdout);});
test("personal API DB path must block",t=>{const {env}=fixture(t);env.CYBERSAFE_DB_PATH=path.join(os.homedir(),".cybersafe-service","cybersafe.db");const r=run(env);assert.equal(r.status,2,r.stdout);});

test("occupied isolated pipe must block rather than attach to an unknown service",async t=>{
 const {env}=fixture(t);
 const server=net.createServer(socket=>socket.end());
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(env.CYBERSAFE_DEV_PIPE_NAME,resolve);});
 try {
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,["scripts/dev-isolated-preflight.mjs"],{env});let stdout="";
   child.stdout.on("data",b=>stdout+=b);child.once("error",reject);child.once("close",status=>resolve({status,stdout}));
  });
  assert.equal(result.status,2,result.stdout);
 } finally {await new Promise(resolve=>server.close(resolve));}
});

// ── Porta: o gate do dev NÃO tem default para 4000 ─────────────────────────
// Antes desta correção, `Number(env.CYBERSAFE_API_PORT || 4000)` fazia o preflight
// abrir um `connect` contra a porta da instalação pessoal sempre que o env estava
// incompleto — e ainda escrevia «porta alvo livre» sobre o alvo errado. Um probe é
// interação; por isso a ausência passa a ser recusa nomeada, e o piso é o do
// runner e do perfil dev (4100).
const VEREDEITO_PORTA=/API: (sem CYBERSAFE_API_PORT|porta invalida|porta \d+ abaixo do piso dev|porta ocupada|porta alvo livre)/;
test("porta: sem CYBERSAFE_API_PORT bloqueia e nada é sondado",t=>{
 const {env}=fixture(t);delete env.CYBERSAFE_API_PORT;
 const r=run(env);
 assert.equal(r.status,2,r.stdout);
 assert.match(r.stdout,/API: sem CYBERSAFE_API_PORT/);
 assert.doesNotMatch(r.stdout,/API: porta (alvo livre|ocupada)/,"sondou uma porta — a 4000 era o alvo silencioso");
});
test("porta: cada forma inválida é recusada pelo motivo certo, sem sonda",t=>{
 const casos=[
  ["",/API: sem CYBERSAFE_API_PORT/,"chave vazia = omissão declarada"],
  ["   ",/API: sem CYBERSAFE_API_PORT/,"só espaços"],
  ["41ab",/API: porta invalida/,"não é número"],
  ["65536",/API: porta invalida/,"fora da faixa TCP"],
  ["0",/API: porta invalida/,"zero não é porta (faixa antes do piso)"],
  ["1",/API: porta 1 abaixo do piso dev 4100/,"abaixo do piso"],
  ["4099",/API: porta 4099 abaixo do piso dev 4100/,"um abaixo do piso"],
  ["4000",/API: porta 4000 abaixo do piso dev 4100/,"a porta da instalação"],
 ];
 for(const [bruto,espera,porque] of casos){
  const {env}=fixture(t);env.CYBERSAFE_API_PORT=bruto;
  const r=run(env);
  assert.equal(r.status,2,`"${bruto}" (${porque}) passou: ${r.stdout.match(VEREDEITO_PORTA)?.[0]}`);
  assert.match(r.stdout,espera,`"${bruto}" (${porque}) deu "${r.stdout.match(VEREDEITO_PORTA)?.[0]}"`);
  assert.doesNotMatch(r.stdout,/API: porta (alvo livre|ocupada)/,`"${bruto}" foi sondada apesar de inválida`);
 }
});
test("porta: 4510 isolada recebe veredito próprio (e não o da instalação)",t=>{
 const {env}=fixture(t);
 const r=run(env);
 assert.match(r.stdout,/API: porta 4510|API: porta alvo livre/);
 assert.equal(/porta 4000/.test(r.stdout),false,"o gate voltou a falar da porta da instalação");
});
