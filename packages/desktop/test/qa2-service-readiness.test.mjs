import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ServiceClient, PIPE_AUTH_REFUSED_CODE } from "../src/service-client.ts";
import { resolveExistingService } from "../src/service-readiness.ts";
import { ProtectionEngineService } from "../../service/dist/engine.js";

/**
 * TP-QA2-READINESS-20261025 — a decisão "reutilizar o serviço existente".
 *
 * Corre as duas pontas REAIS: o `ProtectionEngineService` a servir um pipe e o
 * `ServiceClient` do desktop a chamá-lo. O pipe é sempre um nome isolado de
 * teste (nunca o pipe default do produto), o diretório de dados é um temp
 * dedicado e nada liga proteção, USB, scans ou kill de processos.
 *
 * Mede, em host/lane, o cenário que a VM QA1 reportou: com um serviço vivo de um
 * boot anterior, o
 * arranque tinha de (a) decidir por handshake autenticado e não por "há alguém à
 * escuta", (b) nunca lançar para o boot, e (c) não gastar ~29 s a tentar uma
 * credencial que já foi recusada.
 */

function pipeName(label) {
  return `\\\\.\\pipe\\cybersafe-qa2-${label}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/** Um serviço real e autenticado, com a credencial que lhe é dada. */
async function serviceOnPipe(t, credential) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-qa2-eng-"));
  const previousToken = process.env.CYBERSAFE_PIPE_TOKEN;
  const previousEnv = process.env.NODE_ENV;
  // O motor lê a credência e o modo na construção (mesma ordem do arranque real).
  process.env.CYBERSAFE_PIPE_TOKEN = credential;
  process.env.NODE_ENV = "production";
  const engine = new ProtectionEngineService(base);
  if (previousToken === undefined) delete process.env.CYBERSAFE_PIPE_TOKEN;
  else process.env.CYBERSAFE_PIPE_TOKEN = previousToken;
  if (previousEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv;

  const pipe = pipeName("srv");
  await engine.startPipeServer(pipe);
  t.after(async () => {
    try { await engine.dispose(); } catch { /* já desmontado */ }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return pipe;
}

/** O `probePipe` de main.ts, literal: conectar sem autenticar. */
function probeRaw(pipe) {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipe);
    const done = (ok) => { try { socket.destroy(); } catch { /* já fechado */ } resolve(ok); };
    socket.setTimeout(1200);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

function readiness(pipe, client, log = []) {
  return resolveExistingService({
    probePipe: () => probeRaw(pipe),
    connect: () => client.connect(),
    teardown: () => client.disconnect(),
    log: (message) => log.push(message),
  });
}

describe("readiness do arranque — reutilizar exige prova, não presença", () => {
  it("serviço de um boot anterior com a credencial desta instalação é reutilizado e as leituras passam", async (t) => {
    const credential = randomBytes(32).toString("hex");
    const pipe = await serviceOnPipe(t, credential);
    const client = new ServiceClient(pipe, credential);
    t.after(() => client.disconnect());

    const inicio = Date.now();
    const outcome = await readiness(pipe, client);
    assert.equal(outcome.status, "reused", "um serviço que fala a nossa credencial é reutilizável");
    assert.ok(Date.now() - inicio < 5000, `reutilizar tem de ser imediato (medido: ${Date.now() - inicio}ms)`);

    // Requisito de aceitação: comunicação REAL que passe os pedidos.
    const protection = await client.request("protection.getState", undefined);
    assert.ok(protection && typeof protection === "object" && "status" in protection,
      "protection.getState tem de responder com estado real");

    // P1-PROCESS-TRUTH: o contrato é `{ processes, truth }` — a lista só vale com
    // a verdade que a acompanha.
    const processes = await client.request("processes.list", undefined);
    assert.ok(Array.isArray(processes.processes) && processes.processes.length > 0, "a lista de processos não pode vir vazia");
    assert.equal(processes.truth.state, "ok", "e o serviço tem de afirmar que a enumeração aconteceu");
    assert.equal(typeof processes.truth.enumeratedAt, "number", "com o instante da foto do Windows");

    const pcState = await client.request("pcstate.get", undefined);
    assert.ok(pcState && typeof pcState === "object" && "overall" in pcState, "pcstate.get tem de responder");
  });

  it("pipe ocupado por OUTRA instalação é foreign-service, sem lançar e sem 30 tentativas", async (t) => {
    const pipe = await serviceOnPipe(t, randomBytes(32).toString("hex"));
    const client = new ServiceClient(pipe, randomBytes(32).toString("hex"));
    t.after(() => client.disconnect());

    const inicio = Date.now();
    const outcome = await readiness(pipe, client);
    const emMs = Date.now() - inicio;

    assert.equal(outcome.status, "foreign-service",
      "um pipe que recusa a nossa credencial não é o nosso serviço — reutilizá-lo era o lockout");
    assert.match(String(outcome.reason), /credencial|autentica/i, "a razão tem de dizer o que falhou");
    assert.ok(emMs < 6000, `a recusa é terminal: sem repetir 30 vezes (medido: ${emMs}ms)`);
    assert.equal(client.isConnected, false, "nada é dado como ligado sem handshake");
  });

  it("nada à escuta é no-service, para o chamador arrancar o próprio serviço", async () => {
    const client = new ServiceClient(pipeName("vazio"), randomBytes(32).toString("hex"));
    const outcome = await resolveExistingService({
      probePipe: async () => false,
      connect: () => client.connect(),
      teardown: () => client.disconnect(),
      log: () => {},
    });
    client.disconnect();
    assert.equal(outcome.status, "no-service");
  });

  it("uma avaria do probe não lança para o boot: devolve estado explícito", async () => {
    const client = new ServiceClient(pipeName("avaria"), randomBytes(32).toString("hex"));
    const outcome = await resolveExistingService({
      probePipe: async () => { throw new Error("pipe indisponível"); },
      connect: () => client.connect(),
      teardown: () => client.disconnect(),
      log: () => {},
    });
    client.disconnect();
    assert.ok(["no-service", "foreign-service"].includes(outcome.status),
      `esperado estado explícito, veio ${JSON.stringify(outcome)}`);
  });

  it("a recusa de credencial é marcada como terminal pelo cliente", async (t) => {
    const pipe = await serviceOnPipe(t, randomBytes(32).toString("hex"));
    const client = new ServiceClient(pipe, randomBytes(32).toString("hex"));
    t.after(() => client.disconnect());
    await assert.rejects(client.connect(), (err) => err?.code === PIPE_AUTH_REFUSED_CODE,
      "o cliente tem de classificar a recusa, não a trocar por 'pipe not ready'");
  });
});
