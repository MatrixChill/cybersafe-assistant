import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { encodeMessage, decodeMessages } from "@cybersafe/core";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * Regressão do shutdown limpo.
 *
 * O que aconteceu em produção: o Electron fechava o pipe (ou o próprio serviço
 * destruía os sockets no dispose()) antes de o handler async de "data" escrever
 * a resposta. O EPIPE resultante subia como uncaught exception ("CRITICAL
 * uncaught exception: write EPIPE ... engine.ts:973"), porque o socket do pipe
 * não tinha handler de "error". Estes testes fixam o comportamento correto:
 *  - escrever para um socket morto nunca lança e remove-o da collection;
 *  - o shutdown é idempotente e limpa servidor + clientes;
 *  - durante o shutdown não há eventos nem trabalho novo;
 *  - o ACK é escrito antes de a desmontagem começar.
 */

/** Socket mínimo compatível com o que a engine usa em safeWrite/dispose. */
function fakeSocket(overrides = {}) {
  const written = [];
  return {
    destroyed: false,
    writable: true,
    writableEnded: false,
    written,
    write(payload, cb) {
      written.push(payload);
      if (typeof cb === "function") cb(undefined);
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout à espera da condição");
}

/** Par de sockets reais sobre TCP local (não usa o named pipe global). */
async function connectPair() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const client = net.createConnection({ port, host: "127.0.0.1" });
  const socket = await new Promise((resolve) => server.once("connection", resolve));
  client.on("error", () => {});
  return {
    socket,
    client,
    close() {
      client.destroy();
      server.close();
    },
  };
}

function collectMessages(client) {
  const messages = [];
  let buffer = "";
  client.on("data", (chunk) => {
    buffer += chunk.toString();
    const decoded = decodeMessages(buffer);
    buffer = decoded.rest;
    messages.push(...decoded.messages);
  });
  return {
    messages,
    async waitFor(predicate, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Mensagem esperada não chegou: ${JSON.stringify(messages)}`);
    },
  };
}

describe("clean shutdown — EPIPE e lifecycle do pipe", () => {
  const originalExit = process.exit;
  afterEach(() => {
    process.exit = originalExit;
  });

  it("não escreve num socket já fechado e remove-o da collection", () => {
    const engine = new ProtectionEngineService();
    const dead = fakeSocket({ destroyed: true, writable: false, writableEnded: true });
    engine.clients.add(dead);

    assert.equal(engine.safeWrite(dead, encodeMessage({ type: "event" })), false);
    assert.equal(dead.written.length, 0, "nada pode ser escrito num socket morto");
    assert.equal(engine.clients.has(dead), false, "o socket morto sai da collection");
  });

  it("escrever num net.Socket real destruído não lança", () => {
    const engine = new ProtectionEngineService();
    const socket = new net.Socket();
    socket.destroy();

    assert.doesNotThrow(() => engine.safeWrite(socket, encodeMessage({ type: "event" })));
  });

  it("responde a pedidos e não deixa uncaught quando o peer fecha a seguir", async () => {
    const engine = new ProtectionEngineService();
    const { socket, client, close } = await connectPair();
    engine.attachClientSocket(socket);
    const rx = collectMessages(client);

    client.write(encodeMessage({ id: "r1", type: "request", method: "events.list", payload: undefined }));
    const response = await rx.waitFor((m) => m.type === "response" && m.id === "r1");
    assert.equal(response.ok, true);

    // O peer fecha abruptamente — a próxima escrita da engine tem de ser segura.
    client.destroy();
    await waitFor(() => engine.clients.has(socket) === false);
    assert.doesNotThrow(() => engine.safeWrite(socket, encodeMessage({ type: "event" })));

    close();
  });

  it("shutdown limpa servidor/clientes e é idempotente", async () => {
    const engine = new ProtectionEngineService();
    let exits = 0;
    process.exit = () => {
      exits += 1;
      return undefined;
    };

    const live = fakeSocket();
    engine.clients.add(live);
    let serverClosed = false;
    engine.server = {
      close(cb) {
        serverClosed = true;
        if (typeof cb === "function") cb();
      },
    };

    let disposeCalls = 0;
    const realDispose = engine.dispose.bind(engine);
    engine.dispose = async () => {
      disposeCalls += 1;
      return realDispose();
    };

    await engine.shutdown();

    assert.equal(engine.isShuttingDown, true);
    assert.equal(disposeCalls, 1);
    assert.equal(live.destroyed, true, "os sockets abertos são fechados");
    assert.equal(engine.clients.size, 0);
    assert.equal(serverClosed, true, "o servidor do pipe é fechado");
    assert.equal(engine.server, null);

    // Segunda chamada: idempotente, não repete a desmontagem.
    await engine.shutdown();
    assert.equal(disposeCalls, 1);

    await waitFor(() => exits === 1);
  });

  it("ignora eventos e recusa trabalho novo durante o shutdown", async () => {
    const engine = new ProtectionEngineService();
    const live = fakeSocket();
    engine.clients.add(live);
    engine.isShuttingDown = true;

    engine.broadcast({ type: "event", event: { id: "e1", type: "threat.detected" } });
    engine.emitScanProgress({ id: "scan-1", status: "running", filesScanned: 1, threatsFound: 0 });

    assert.equal(live.written.length, 0, "nenhum evento novo deve ser emitido no shutdown");
    await assert.rejects(() => engine.dispatch("scan.start", { type: "quick" }), /a encerrar/);
    await assert.rejects(() => engine.dispatch("definitions.update", undefined), /a encerrar/);
    await assert.rejects(() => engine.dispatch("monitor.start", undefined), /a encerrar/);

    // O pedido de shutdown em si continua a ser atendido (com ACK imediato).
    let called = false;
    engine.shutdown = async () => {
      called = true;
    };
    assert.deepEqual(await engine.dispatch("service.shutdown", undefined), { success: true });
  });

  it("só inicia a desmontagem depois de o ACK do shutdown estar pronto", async () => {
    const engine = new ProtectionEngineService();
    let called = false;
    engine.shutdown = async () => {
      called = true;
    };

    assert.deepEqual(await engine.dispatch("service.shutdown", undefined), { success: true });
    assert.equal(called, false, "a desmontagem não pode correr antes de o ACK ser escrito");
    await new Promise((r) => setImmediate(r));
    assert.equal(called, true);
  });

  it("broadcast remove sockets mortos e mantém os vivos", () => {
    const engine = new ProtectionEngineService();
    const dead = fakeSocket({ destroyed: true, writable: false, writableEnded: true });
    const alive = fakeSocket();
    engine.clients.add(dead);
    engine.clients.add(alive);

    engine.broadcast({ type: "event", event: { id: "e2", type: "threat.detected" } });

    assert.equal(engine.clients.has(dead), false);
    assert.equal(engine.clients.has(alive), true);
    assert.equal(dead.written.length, 0);
    assert.equal(alive.written.length, 1);
  });
});
