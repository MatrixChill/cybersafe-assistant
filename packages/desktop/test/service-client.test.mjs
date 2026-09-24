import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { decodeMessages, encodeMessage } from "@cybersafe/core";
import { ServiceClient } from "../src/service-client.ts";

/**
 * Regressão da ligação duplicada ao pipe.
 *
 * No arranque, o poll da tray (createTray → updateServiceStatus →
 * refreshTrayProtectionInfo) e o boot da app (client.connect()) chamavam
 * connect() quase ao mesmo tempo. Como connect() não memoizava o pedido em
 * curso, cada chamada abria o seu próprio socket — daí os dois
 * "Connected to pipe successfully!" e o primeiro socket ficar órfão na
 * collection do serviço.
 *
 * Estes testes usam um pipe local de teste (nunca o pipe real do produto) para
 * contar o número de ligações efetivamente abertas.
 */

function newPipeName(label) {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\cybersafe-test-${label}-${id}`
    : path.join(os.tmpdir(), `cybersafe-test-${label}-${id}.sock`);
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout à espera da condição");
}

/**
 * Servidor de teste no pipe. Responde a cada request com um ACK simples, a
 * menos que `onRequest` decida outra coisa (ex.: cortar a ligação).
 */
async function startPipeServer({ onRequest } = {}) {
  const pipeName = newPipeName("svc");
  let connections = 0;
  const sockets = new Set();

  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const decoded = decodeMessages(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message?.type !== "request") continue;
        if (onRequest) {
          onRequest(socket, message);
          continue;
        }
        socket.write(encodeMessage({
          id: message.id,
          type: "response",
          ok: true,
          result: { method: message.method },
        }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, resolve);
  });

  return {
    pipeName,
    get connections() {
      return connections;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("ServiceClient — ligação única ao pipe", () => {
  let pipe;

  beforeEach(async () => {
    pipe = await startPipeServer();
  });

  afterEach(async () => {
    await pipe.close();
  });

  it("connect() chamado em paralelo abre uma única ligação", async () => {
    const client = new ServiceClient(pipe.pipeName);

    await Promise.all([client.connect(), client.connect(), client.connect()]);

    // O "connection" do servidor pode chegar depois do callback do cliente.
    await waitFor(() => pipe.connections === 1);
    // E não pode aparecer uma segunda ligação logo a seguir.
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(pipe.connections, 1, "só pode existir uma ligação ativa");
    assert.equal(client.isConnected, true);
    client.disconnect();
  });

  it("o caminho real de arranque (poll da tray + boot) não duplica a ligação", async () => {
    const client = new ServiceClient(pipe.pipeName);

    await Promise.all([
      client.connect(),
      client.request("protection.getState", undefined),
      client.request("events.list", undefined),
    ]);

    assert.equal(pipe.connections, 1, "o arranque não pode abrir dois sockets");
    client.disconnect();
  });

  it("disconnect() fecha o socket e o pedido seguinte religa uma só vez", async () => {
    const client = new ServiceClient(pipe.pipeName);

    await client.request("events.list", undefined);
    assert.equal(pipe.connections, 1);

    client.disconnect();
    assert.equal(client.isConnected, false);

    await client.request("events.list", undefined);
    assert.equal(pipe.connections, 2, "cada reconexão abre exatamente uma ligação");
    client.disconnect();
  });

  it("requestShutdown() regressa mesmo se o serviço cortar a ligação sem ACK", async () => {
    const cutPipe = await startPipeServer({ onRequest: (socket) => socket.destroy() });
    try {
      const client = new ServiceClient(cutPipe.pipeName);
      await client.requestShutdown();
      assert.equal(client.isConnected, false);
    } finally {
      await cutPipe.close();
    }
  });

  it("requestShutdown() não fica pendurado se o serviço nunca responder ao ACK", async () => {
    const silentPipe = await startPipeServer({
      onRequest: (socket) => socket.pause(), // aceita mas nunca responde
    });
    try {
      const client = new ServiceClient(silentPipe.pipeName);
      const started = Date.now();
      await client.requestShutdown();
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5000, `requestShutdown demorou ${elapsed}ms e não pode bloquear o quit`);
      assert.equal(client.isConnected, false);
      await waitFor(() => true, 10);
    } finally {
      await silentPipe.close();
    }
  });
});
