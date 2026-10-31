import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { encodeMessage, decodeMessages, PIPE_AUTH_VERSION, generatePipeNonce, isPipeNonce, makePipeProof, verifyPipeProof } from "@cybersafe/core";
import { ProtectionEngineService } from "../dist/engine.js";

async function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "cybersafe-s4-"));
  const token = randomBytes(32).toString("hex");
  const previous = process.env.CYBERSAFE_PIPE_TOKEN;
  process.env.CYBERSAFE_PIPE_TOKEN = token;
  const oldMode=process.env.NODE_ENV;process.env.NODE_ENV="production";
  const engine = new ProtectionEngineService(base);
  if(oldMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldMode;
  if (previous === undefined) delete process.env.CYBERSAFE_PIPE_TOKEN; else process.env.CYBERSAFE_PIPE_TOKEN = previous;
  const calls = [];
  for (const name of ["killProcess", "restoreQuarantine", "allowHash", "allowPublisher"]) {
    engine[name] = async (...args) => { calls.push(name); return { success: true }; };
  }
  const pipe = process.platform === "win32" ? "\\\\.\\pipe\\cybersafe-s4-" + process.pid + "-" + randomBytes(6).toString("hex") : path.join(base, "s4.sock");
  const sockets = [];
  t.after(async () => { for (const s of sockets) s.destroy(); await engine.dispose(); rmSync(base, { recursive: true, force: true }); });
  assert.equal(typeof engine.authenticateClientSocket, "function", "o limite autenticado deve existir antes de abrir um pipe de teste");
  await engine.startPipeServer(pipe);
  async function connect() {
    const socket = net.createConnection(pipe); sockets.push(socket); socket.on("error", () => {});
    const messages = []; let buffer = "";
    // Registar o que o cliente ESCREVE é o que permite provar que o segredo não
    // viaja no fio; a asserção antiga só olhava para a resposta do servidor.
    const enviados = [];
    const escreve = socket.write.bind(socket);
    socket.write = (data, cb) => { enviados.push(String(data)); return escreve(data, cb); };
    socket.on("data", chunk => { const decoded = decodeMessages(buffer + chunk); buffer = decoded.rest; messages.push(...decoded.messages); });
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return { socket, messages, enviados, async next(predicate) { const until=Date.now()+3000; while(Date.now()<until) { const m=messages.find(predicate); if(m)return m; await new Promise(r=>setTimeout(r,10)); } throw new Error("resposta S4 em falta"); } };
  }
  return { engine, token, calls, connect };
}

/**
 * Handshake v2 do lado do cliente, feito à mão sobre o socket cru.
 *
 * Não é um mock: usa o helper puro real (`makePipeProof`/`verifyPipeProof`) e o
 * servidor real, por isso o que está aqui a passar é o contrato no fio. Se o
 * servidor não provar posse, `verifyPipeProof` falha e este helper lança — é a
 * propriedade que o RED do peer falso pedia.
 */
async function handshakeCliente(c, token) {
  const clientNonce = generatePipeNonce();
  c.socket.write(encodeMessage({ type: "auth-hello", v: PIPE_AUTH_VERSION, nonce: clientNonce }));
  const desafio = await c.next((m) => m.type === "auth-challenge");
  assert.equal(desafio.v, PIPE_AUTH_VERSION, "o desafio transporta a versão do protocolo");
  assert.equal(isPipeNonce(desafio.nonce), true, "o servidor tem de trazer um nonce bem formado");
  assert.equal(verifyPipeProof(token, "server", clientNonce, desafio.nonce, desafio.proof), true,
    "o servidor tem de provar posse do segredo antes de o cliente enviar qualquer coisa");
  c.socket.write(encodeMessage({
    type: "auth-response", v: PIPE_AUTH_VERSION,
    proof: makePipeProof(token, "client", clientNonce, desafio.nonce),
  }));
  const ack = await c.next((m) => m.type === "auth");
  assert.equal(ack.ok, true, "o aceite só chega depois das duas provas");
  return { clientNonce, serverNonce: desafio.nonce, ack };
}

test("S4: sem identidade, kill/restore/trust não chegam a dispatch", async t => {
  const f=await fixture(t);
  for (const method of ["process.killTree", "quarantine.restore", "trust.allowHash", "trust.allowPublisher"]) {
    const c=await f.connect();
    c.socket.write(encodeMessage({ id: method, type: "request", method, payload: { pid: 42, id: "fixture", sha256: "a".repeat(64), publisher: "fixture", userId: "claimed", role: "admin" } }));
    const rejected=await c.next(m=>m.type === "auth" || m.type === "response");
    assert.equal(rejected.ok, false, "um pedido sem handshake tem de ser rejeitado");
  }
  assert.deepEqual(f.calls, [], "zero efeitos sensíveis");
});

test("S4: credencial errada, prova alheia, reflexão e frames legado/malformados são recusados sem efeitos", async t => {
  const f=await fixture(t);
  // (a) legado v1: `{auth, token}` cru deixou de autorizar seja o que for.
  for(const message of [{type:"auth",token:randomBytes(32).toString("hex")},{type:"auth",token: {role:"admin"}}]) {
    const c=await f.connect(); c.socket.write(encodeMessage(message));
    assert.equal((await c.next(m=>m.type==="auth")).ok,false, "frame legado tem de ser recusado");
  }
  // (b) hello com versão errada, nonce malformado e JSON lixo.
  for(const frame of [
    {type:"auth-hello", v: 1, nonce: generatePipeNonce()},
    {type:"auth-hello", v: PIPE_AUTH_VERSION, nonce: "não-hex"},
    {type:"auth-hello", v: PIPE_AUTH_VERSION},
  ]) {
    const c=await f.connect(); c.socket.write(encodeMessage(frame));
    assert.equal((await c.next(m=>m.type==="auth")).ok,false, "hello inválido tem de ser recusado");
  }
  // (c) prova do cliente calculada com OUTRA chave.
  const errado = await f.connect();
  const cn = generatePipeNonce();
  errado.socket.write(encodeMessage({type:"auth-hello", v: PIPE_AUTH_VERSION, nonce: cn}));
  const d1 = await errado.next((m)=>m.type==="auth-challenge");
  errado.socket.write(encodeMessage({type:"auth-response", v: PIPE_AUTH_VERSION,
    proof: makePipeProof(randomBytes(32).toString("hex"), "client", cn, d1.nonce)}));
  assert.equal((await errado.next((m)=>m.type==="auth")).ok,false, "chave errada não liberta RPC");
  // (d) reflexão: a prova do SERVIDOR não serve como prova do CLIENTE (domínios
  //     separados por papel, é o que o helper garante e o que aqui se verifica no fio).
  const refleto = await f.connect();
  const cn2 = generatePipeNonce();
  refleto.socket.write(encodeMessage({type:"auth-hello", v: PIPE_AUTH_VERSION, nonce: cn2}));
  const d2 = await refleto.next((m)=>m.type==="auth-challenge");
  refleto.socket.write(encodeMessage({type:"auth-response", v: PIPE_AUTH_VERSION, proof: d2.proof}));
  assert.equal((await refleto.next((m)=>m.type==="auth")).ok,false, "prova refletida tem de falhar");
  assert.deepEqual(f.calls, [], "zero efeitos sensíveis em qualquer dos casos");
});

test("S4: handshake v2 válido permite as operações existentes e o segredo nunca vai no fio", async t => {
  const f=await fixture(t); const c=await f.connect();
  await handshakeCliente(c, f.token);
  // Propriedade reforçada: em NENHUM byte escrito pelo cliente aparece o segredo.
  assert.equal(c.enviados.some((b) => b.includes(f.token)), false,
    "o segredo persistente não pode viajar em claro, nem numa fase do handshake");
  assert.equal(c.messages.some((m) => JSON.stringify(m).includes(f.token)), false,
    "nem nas respostas do servidor");
  for(const [method,payload] of [["process.killTree",{pid:42}],["quarantine.restore",{id:"fixture"}],["trust.allowHash",{sha256:"a".repeat(64)}],["trust.allowPublisher",{publisher:"fixture"}]]) {
    c.socket.write(encodeMessage({id:method,type:"request",method,payload}));
    assert.equal((await c.next(m=>m.id===method)).ok,true);
  }
  assert.deepEqual(f.calls,["killProcess","restoreQuarantine","allowHash","allowPublisher"]);
});

test("S4: serviço sem credencial falha fechado antes de escutar", async t => {
  const previous=process.env.CYBERSAFE_PIPE_TOKEN; delete process.env.CYBERSAFE_PIPE_TOKEN;
  const oldMode=process.env.NODE_ENV; process.env.NODE_ENV="production";
  const base=mkdtempSync(path.join(os.tmpdir(),"cybersafe-s4-missing-")); const engine=new ProtectionEngineService(base);
  if(previous!==undefined)process.env.CYBERSAFE_PIPE_TOKEN=previous;
  if(oldMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldMode;
  t.after(async()=>{await engine.dispose();rmSync(base,{recursive:true,force:true});});
  assert.equal(typeof engine.authenticateClientSocket, "function", "o limite autenticado deve existir");
  await assert.rejects(()=>engine.startPipeServer(path.join(base,"never.sock")),/credencial|autenticação/i);
});

test("S4: DEV externo mantém pedidos existentes e avisa explicitamente", async t => {
  const previous=process.env.CYBERSAFE_PIPE_TOKEN, mode=process.env.NODE_ENV;
  delete process.env.CYBERSAFE_PIPE_TOKEN; process.env.NODE_ENV="development";
  const base=mkdtempSync(path.join(os.tmpdir(),"cybersafe-s4-dev-"));
  const engine=new ProtectionEngineService(base);
  if(previous===undefined)delete process.env.CYBERSAFE_PIPE_TOKEN;else process.env.CYBERSAFE_PIPE_TOKEN=previous;
  if(mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=mode;
  const sockets=[]; t.after(async()=>{for(const s of sockets)s.destroy();await engine.dispose();rmSync(base,{recursive:true,force:true});});
  assert.equal(typeof engine.authenticateClientSocket,"function","não abrir pipe global no código anterior");
  const endpoint=process.platform==="win32" ? "\\\\.\\pipe\\cybersafe-s4-dev-"+process.pid+"-"+randomBytes(6).toString("hex") : path.join(base,"dev.sock");
  const warnings=[];const warn=console.warn;console.warn=(...args)=>warnings.push(args.join(" "));
  try { await engine.startPipeServer(endpoint); } finally {console.warn=warn;}
  assert.equal(warnings.some(s=>/AVISO S4.*DEV.*sem autenticação/.test(s)),true);
  const {ServiceClient}=await import("../../desktop/src/service-client.ts");
  const client=new ServiceClient(endpoint);t.after(()=>client.disconnect());
  const state=await client.request("protection.getState",undefined);
  assert.equal(state.protectionEnabled,false);assert.deepEqual(state.stats,engine.getProtectionState().stats);
});
test("S4: cliente desktop autentica antes de enviar comandos ao serviço", async t => {
  const f=await fixture(t);
  const {ServiceClient}=await import("../../desktop/src/service-client.ts");
  const client=new ServiceClient(f.engine.server.address(),f.token);
  t.after(()=>client.disconnect());
  await client.request("trust.allowHash",{sha256:"a".repeat(64)});
  assert.deepEqual(f.calls,["allowHash"]);
  assert.equal(client.isConnected,true);
  client.disconnect();
  await client.request("trust.allowHash",{sha256:"a".repeat(64)});
  assert.deepEqual(f.calls,["allowHash","allowHash"]);
});

test("S4: cliente com credencial errada não fica ligado nem executa efeitos", async t => {
  const f=await fixture(t);
  const {ServiceClient, PIPE_AUTH_REFUSED_CODE}=await import("../../desktop/src/service-client.ts");
  const client=new ServiceClient(f.engine.server.address(),randomBytes(32).toString("hex"));
  t.after(()=>client.disconnect());
  const erro = await client.openSocket(1).then(()=>null,(e)=>e);
  assert.ok(erro, "a ligação tem de falhar");
  assert.match(erro.message, /posse|credência|autentica/i, "razão legível, sem segredo no texto");
  assert.equal(erro.code, PIPE_AUTH_REFUSED_CODE, "recusa de posse é terminal, não atraso a repetir");
  assert.equal(client.isConnected,false); assert.deepEqual(f.calls,[]);
});
test("S4: hello fragmentado reassemlado; JSON inválido, frame excessivo e ACK legado são recusados", async t => {
  const f=await fixture(t);const good=await f.connect();
  const frame=encodeMessage({type:"auth-hello", v:PIPE_AUTH_VERSION, nonce:generatePipeNonce()});
  good.socket.write(frame.slice(0,15));await new Promise(r=>setTimeout(r,20));
  assert.equal(good.messages.length,0,"um fragmento não é ainda uma mensagem");
  good.socket.write(frame.slice(15));
  assert.equal((await good.next(m=>m.type==="auth-challenge")).v, PIPE_AUTH_VERSION, "o desafio chega depois do reassemlado");
  for(const data of ["{invalid json}\n","x".repeat(4097)]){
    const c=await f.connect(); c.socket.write(data);assert.equal((await c.next(m=>m.type==="auth")).ok,false);
  }
  // ACK unilateral, sem desafio: é o RED do peer falso. Não autoriza RPC.
  const soAck=await f.connect();
  soAck.socket.write(encodeMessage({type:"auth", ok:true}));
  const negado = await soAck.next(m=>m.type==="auth" && m.ok===false);
  assert.equal(negado.ok,false);
  soAck.socket.write(encodeMessage({id:"t",type:"request",method:"trust.allowHash",payload:{sha256:"a".repeat(64)}}));
  await new Promise(r=>setTimeout(r,50));
  assert.equal(soAck.messages.some(m=>m.id==="t"),false,"nenhum pedido é respondido por um peer não aceite");
  assert.deepEqual(f.calls,[]);
});

test("S4: cliente não autenticado não recebe replay de eventos", async t => {
  const f=await fixture(t);
  f.engine.eventBus.getReplay=()=>[{id:"s4-replay-fixture"}];
  const c=await f.connect();await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(c.messages,[]);
  c.socket.write(encodeMessage({type:"auth",token:randomBytes(32).toString("hex")}));
  assert.equal((await c.next(m=>m.type==="auth")).ok,false);
  assert.equal(c.messages.some(m=>m.type==="event"),false);
});
