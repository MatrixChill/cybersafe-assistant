import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  PIPE_AUTH_VERSION,
  decodeMessages,
  encodeMessage,
  generatePipeNonce,
  makePipeProof,
} from "@cybersafe/core";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * TP-QA2-READINESS R1 — posse do servidor no pipe (integração cliente+serviço).
 *
 * Fecha o RED que o peer falso deixou aberto: um `{auth, ok:true}` unilateral já
 * não autoriza nada, e o segredo deixa de viajar no fio. Corre o motor REAL e o
 * cliente REAL da lane, sempre com pipe de teste (nunca o pipe default do
 * produto) e raiz de dados temporária. Nenhum segredo real: as credenciais são
 * fixtures geradas aqui e nunca são escritas em asserções ou logs.
 */

async function motor(t, token) {
  const base = mkdtempSync(path.join(os.tmpdir(), "cybersafe-r1-"));
  const previousToken = process.env.CYBERSAFE_PIPE_TOKEN;
  const previousMode = process.env.NODE_ENV;
  process.env.CYBERSAFE_PIPE_TOKEN = token;
  process.env.NODE_ENV = "production";
  const engine = new ProtectionEngineService(base);
  if (previousToken === undefined) delete process.env.CYBERSAFE_PIPE_TOKEN;
  else process.env.CYBERSAFE_PIPE_TOKEN = previousToken;
  if (previousMode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousMode;
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\cybersafe-r1-${process.pid}-${randomBytes(6).toString("hex")}`
    : path.join(base, "r1.sock");
  await engine.startPipeServer(pipe);
  t.after(async () => {
    try { await engine.dispose(); } catch { /* já desmontado */ }
    rmSync(base, { recursive: true, force: true });
  });
  return { engine, pipe };
}

/** Socket cru com enfileiramento de frames, para ver o que passa no fio. */
async function bruto(t, pipe) {
  const socket = net.createConnection(pipe);
  const enviados = [];
  const escreve = socket.write.bind(socket);
  socket.write = (data, cb) => { enviados.push(String(data)); return escreve(data, cb); };
  const mensagens = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    const dec = decodeMessages(buffer + chunk.toString());
    buffer = dec.rest;
    mensagens.push(...dec.messages);
  });
  socket.on("error", () => { /* peers de teste */ });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const next = async (predicado) => {
    const ate = Date.now() + 3000;
    for (;;) {
      const encontrada = mensagens.find(predicado);
      if (encontrada) return encontrada;
      if (Date.now() > ate) throw new Error("frame em falta");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { socket, mensagens, enviados, next };
}

test("R1: par verdadeiro — RPC real passa, e reabrir a ligação volta a passar", async t => {
  const token = randomBytes(32).toString("hex");
  const { pipe } = await motor(t, token);
  const { ServiceClient } = await import("../../desktop/src/service-client.ts");

  for (const ronda of [1, 2]) {
    const client = new ServiceClient(pipe, token);
    t.after(() => client.disconnect());
    await client.connect();
    assert.equal(client.isConnected, true, `ronda ${ronda}: handshake v2`);
    const estado = await client.request("protection.getState", undefined);
    assert.ok(estado && typeof estado === "object" && "status" in estado, `ronda ${ronda}: proteção real`);
    const processos = await client.request("processes.list", undefined);
    assert.ok(Array.isArray(processos.processes), `ronda ${ronda}: lista de processos`);
    assert.ok(processos.truth && typeof processos.truth.state === "string", `ronda ${ronda}: verdade da enumeração`);
    const pcState = await client.request("pcstate.get", undefined);
    assert.ok(pcState && "overall" in pcState, `ronda ${ronda}: PcState real`);
    client.disconnect();
  }
});

test("R1: o fio não leva o segredo — nem no hello, nem na resposta", async t => {
  const token = randomBytes(32).toString("hex");
  const { pipe } = await motor(t, token);
  const c = await bruto(t, pipe);
  const clientNonce = generatePipeNonce();
  c.socket.write(encodeMessage({ type: "auth-hello", v: PIPE_AUTH_VERSION, nonce: clientNonce }));
  const desafio = await c.next((m) => m.type === "auth-challenge");
  c.socket.write(encodeMessage({
    type: "auth-response", v: PIPE_AUTH_VERSION,
    proof: makePipeProof(token, "client", clientNonce, desafio.nonce),
  }));
  assert.equal((await c.next((m) => m.type === "auth")).ok, true, "handshake completo");
  assert.equal(c.enviados.some((b) => b.includes(token)), false, "o cliente nunca escreve o segredo");
  assert.equal(c.mensagens.some((m) => JSON.stringify(m).includes(token)), false, "o servidor nunca o devolve");
});

test("R1: transcripto gravado não se reproduz (nonce de servidor novo por ligação)", async t => {
  const token = randomBytes(32).toString("hex");
  const { engine, pipe } = await motor(t, token);
  // 1) gravar um handshake legítimo por inteiro.
  const origem = await bruto(t, pipe);
  const clientNonce = generatePipeNonce();
  origem.socket.write(encodeMessage({ type: "auth-hello", v: PIPE_AUTH_VERSION, nonce: clientNonce }));
  const desafio = await origem.next((m) => m.type === "auth-challenge");
  const resposta = encodeMessage({
    type: "auth-response", v: PIPE_AUTH_VERSION,
    proof: makePipeProof(token, "client", clientNonce, desafio.nonce),
  });
  origem.socket.write(resposta);
  assert.equal((await origem.next((m) => m.type === "auth")).ok, true, "transcripto original deve completar autenticação");

  // 2) reproduzir os mesmos dois frames numa ligação nova.
  const replica = await bruto(t, pipe);
  replica.socket.write(encodeMessage({ type: "auth-hello", v: PIPE_AUTH_VERSION, nonce: clientNonce }));
  const desafio2 = await replica.next((m) => m.type === "auth" || m.type === "auth-challenge");
  if (desafio2.type === "auth-challenge") {
    assert.notEqual(desafio2.nonce, desafio.nonce, "o servidor renova o próprio nonce");
    replica.socket.write(resposta);
    const recusa = await replica.next((m) => m.type === "auth");
    assert.equal(recusa.ok, false, "prova de outra ligação não vale nesta");
  } else {
    assert.equal(desafio2.ok, false, "clientNonce repetido é recusado à partida");
  }
  assert.deepEqual(engine.getProtectionState().protectionEnabled, false);
});

test("R1: prova adulterada é recusada e nada é libertado", async t => {
  const token = randomBytes(32).toString("hex");
  const { pipe } = await motor(t, token);
  const c = await bruto(t, pipe);
  const clientNonce = generatePipeNonce();
  c.socket.write(encodeMessage({ type: "auth-hello", v: PIPE_AUTH_VERSION, nonce: clientNonce }));
  const desafio = await c.next((m) => m.type === "auth-challenge");
  const correta = makePipeProof(token, "client", clientNonce, desafio.nonce);
  const adulterada = (correta[0] === "a" ? "b" : "a") + correta.slice(1);
  c.socket.write(encodeMessage({ type: "auth-response", v: PIPE_AUTH_VERSION, proof: adulterada }));
  assert.equal((await c.next((m) => m.type === "auth")).ok, false, "prova alterada não autoriza");
  c.socket.write(encodeMessage({ id: "x", type: "request", method: "trust.allowHash", payload: { sha256: "a".repeat(64) } }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.mensagens.some((m) => m.id === "x"), false, "sem RPC depois de recusar");
});

test("R1: peer que só sabe dizer 'ok' não é aceite pelo cliente real", async t => {
  // O RED, do lado do cliente: um listener arbitrário responde ACK unilateral.
  const token = randomBytes(32).toString("hex");
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\cybersafe-r1fake-${process.pid}-${randomBytes(6).toString("hex")}`
    : path.join(os.tmpdir(), `r1fake-${process.pid}.sock`);
  let segredoVisto = false;
  const fake = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      for (const m of decodeMessages(chunk.toString()).messages) {
        if (JSON.stringify(m).includes(token)) segredoVisto = true;
        socket.write(encodeMessage({ type: "auth", ok: true }));
      }
    });
    socket.on("error", () => { /* peer de teste */ });
  });
  await new Promise((resolve) => fake.listen(pipe, resolve));
  t.after(() => new Promise((resolve) => fake.close(resolve)));

  const { ServiceClient } = await import("../../desktop/src/service-client.ts");
  const client = new ServiceClient(pipe, token);
  t.after(() => client.disconnect());
  const inicio = Date.now();
  const erro = await client.openSocket(1).then(() => null, (e) => e);
  const emMs = Date.now() - inicio;
  assert.ok(erro, "um peer sem prova não pode ser aceite");
  assert.match(erro.message, /posse/i, "a recusa diz o que falhou");
  assert.ok(emMs < 1500, `recusa de posse é terminal: sem espera de prazo (medido: ${emMs}ms)`);
  assert.equal(client.isConnected, false);
  assert.equal(segredoVisto, false, "o segredo nunca foi transmitido ao peer falso");
});
