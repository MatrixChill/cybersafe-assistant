import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { downloadYaraRulesText } from "../dist/yara-rules-download.js";

/**
 * Integridade da transferência do corpus YARA (TP-HUMAN-YARA).
 *
 * O updater publica o corpus no path real do serviço; uma transferência
 * truncada aceite em silêncio pode, por exemplo, deixar apenas a primeira
 * regra do ficheiro (a fonte EICAR) e o motor reporta `degraded` como se as
 * regras reais não existissem. Estes testes usam um transporte falso — nunca
 * rede real — e fixam o contrato: a resposta entregue tem de corresponder aos
 * bytes que o servidor declarou, e uma ligação cortada nunca pode resolver.
 */

function makeResponse({ statusCode = 200, headers = {}, chunks = [] } = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = headers;
  response.destroyed = false;
  response.destroy = () => {
    response.destroyed = true;
    response.emit("close");
  };
  response.emitChunks = () => {
    for (const chunk of chunks) response.emit("data", chunk);
    response.emit("end");
  };
  return response;
}

function createGet(responses) {
  const get = (url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    const response = responses.shift();
    queueMicrotask(() => {
      callback(response);
      queueMicrotask(() => {
        if (response.autoEmit !== false) response.emitChunks();
      });
    });
    return request;
  };
  return { get };
}

describe("corpus YARA — resposta truncada não é publicável", () => {
  it("rejeita quando o corpo termina antes dos bytes declarados", async () => {
    const truncated = makeResponse({
      headers: { "content-length": "5000" },
      chunks: [Buffer.from("rule eicar { condition: true }")],
    });
    const fake = createGet([truncated]);

    await assert.rejects(
      downloadYaraRulesText("https://rules.example/rules.yar", fake.get),
      /truncada: 30 de 5000 bytes/,
    );
  });

  it("aceita quando o corpo entrega exatamente os bytes declarados", async () => {
    const body = "rule benign { condition: true }";
    const complete = makeResponse({
      headers: { "content-length": String(Buffer.byteLength(body)) },
      chunks: [Buffer.from(body)],
    });
    const fake = createGet([complete]);

    const text = await downloadYaraRulesText("https://rules.example/rules.yar", fake.get);
    assert.equal(text, body);
  });

  it("rejeita uma ligação fechada antes do fim da resposta", async () => {
    const cut = makeResponse({
      headers: { "content-length": "5000" },
      chunks: [],
    });
    cut.autoEmit = false;
    cut.on("data", () => {});
    const fake = createGet([cut]);

    const promise = downloadYaraRulesText("https://rules.example/rules.yar", fake.get);
    queueMicrotask(() => {
      cut.emit("data", Buffer.from("rule partial"));
      cut.emit("close");
    });

    await assert.rejects(promise, /fechada antes do fim da resposta/);
  });
});
