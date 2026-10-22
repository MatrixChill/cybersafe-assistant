import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { encodeMessage, decodeMessages } from "@cybersafe/core";
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
    socket.on("data", chunk => { const decoded = decodeMessages(buffer + chunk); buffer = decoded.rest; messages.push(...decoded.messages); });
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return { socket, messages, async next(predicate) { const until=Date.now()+3000; while(Date.now()<until) { const m=messages.find(predicate); if(m)return m; await new Promise(r=>setTimeout(r,10)); } throw new Error("resposta S4 em falta"); } };
  }
  return { engine, token, calls, connect };
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

test("S4: credencial errada e conteúdo malformado são rejeitados sem efeitos", async t => {
  const f=await fixture(t);
  for(const message of [{type:"auth",token:randomBytes(32).toString("hex")},{type:"auth",token: {role:"admin"}}]) {
    const c=await f.connect(); c.socket.write(encodeMessage(message));
    assert.equal((await c.next(m=>m.type==="auth")).ok,false);
  }
  assert.deepEqual(f.calls,[]);
});

test("S4: handshake válido permite as operações existentes e não envia segredo na resposta", async t => {
  const f=await fixture(t); const c=await f.connect();
  c.socket.write(encodeMessage({type:"auth", token:f.token}));
  const ack=await c.next(m=>m.type==="auth"); assert.equal(ack.ok,true); assert.equal(JSON.stringify(ack).includes(f.token),false);
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
  const {ServiceClient}=await import("../../desktop/src/service-client.ts");
  const client=new ServiceClient(f.engine.server.address(),randomBytes(32).toString("hex"));
  t.after(()=>client.disconnect());
  await assert.rejects(()=>client.openSocket(1),/autenticação/i);
  assert.equal(client.isConnected,false); assert.deepEqual(f.calls,[]);
});
test("S4: autenticação fragmentada funciona; JSON inválido e frame excessivo são recusados", async t => {
  const f=await fixture(t);const good=await f.connect();
  const frame=encodeMessage({type:"auth",token:f.token});
  good.socket.write(frame.slice(0,15));await new Promise(r=>setTimeout(r,20));
  assert.equal(good.messages.length,0);
  good.socket.write(frame.slice(15)); assert.equal((await good.next(m=>m.type==="auth")).ok,true);
  for(const data of ["{invalid json}\n","x".repeat(4097)]){
    const c=await f.connect(); c.socket.write(data);assert.equal((await c.next(m=>m.type==="auth")).ok,false);
  }
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
