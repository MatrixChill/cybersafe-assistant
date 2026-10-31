import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { downloadYaraRulesText } from "../dist/yara-rules-download.js";

function makeResponse({ statusCode = 200, headers = {}, chunks = [] } = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = headers;
  response.destroyed = false;
  response.destroy = () => {
    response.destroyed = true;
    response.emit("close");
  };
  response.resume = () => {};
  response.emitChunks = () => {
    for (const chunk of chunks) response.emit("data", chunk);
    response.emit("end");
  };
  return response;
}

function createGet(responses) {
  const requests = [];
  const get = (url, _options, callback) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => {
      request.destroyed = true;
    };
    requests.push({ url: String(url), request });
    const response = responses.shift();
    queueMicrotask(() => {
      callback(response);
      queueMicrotask(() => response.emitChunks());
    });
    return request;
  };
  return { get, requests };
}

describe("transfer YARA bounded and redirected", () => {
  it("rejects declared and streamed content over the cap and cancels the response", async () => {
    const declared = makeResponse({ headers: { "content-length": String(16 * 1024 * 1024 + 1) } });
    const declaredGet = createGet([declared]);
    await assert.rejects(
      downloadYaraRulesText("https://rules.example/rules.yar", declaredGet.get),
      /excede o limite/,
    );
    assert.equal(declared.destroyed, true);

    const streamed = makeResponse({ chunks: [Buffer.alloc(16 * 1024 * 1024 + 1)] });
    const streamedGet = createGet([streamed]);
    await assert.rejects(
      downloadYaraRulesText("https://rules.example/rules.yar", streamedGet.get),
      /excede o limite/,
    );
    assert.equal(streamed.destroyed, true);
  });

  it("follows only bounded HTTPS redirects to the same origin", async () => {
    const redirect = makeResponse({
      statusCode: 302,
      headers: { location: "https://rules.example/rules-v2.yar" },
    });
    const final = makeResponse({ chunks: [Buffer.from("rule benign { condition: true }")] });
    const sameOriginGet = createGet([redirect, final]);

    const body = await downloadYaraRulesText(
      "https://rules.example/rules.yar",
      sameOriginGet.get,
    );
    assert.match(body, /rule benign/);
    assert.equal(sameOriginGet.requests.length, 2);

    const externalRedirect = makeResponse({
      statusCode: 302,
      headers: { location: "https://attacker.example/rules.yar" },
    });
    const externalGet = createGet([externalRedirect]);
    await assert.rejects(
      downloadYaraRulesText("https://rules.example/rules.yar", externalGet.get),
      /Redirecionamento HTTPS para origem diferente/,
    );
    assert.equal(externalGet.requests.length, 1);
  });

  it("rejects non-HTTPS sources before making a request", async () => {
    const fake = createGet([]);
    await assert.rejects(
      downloadYaraRulesText("http://rules.example/rules.yar", fake.get),
      /A fonte YARA tem de usar HTTPS/,
    );
    assert.equal(fake.requests.length, 0);
  });

  it("closes an unsuccessful HTTP response instead of draining its body", async () => {
    const unavailable = makeResponse({ statusCode: 503, chunks: [Buffer.alloc(1024)] });
    const fake = createGet([unavailable]);
    await assert.rejects(
      downloadYaraRulesText("https://rules.example/rules.yar", fake.get),
      /HTTP 503/,
    );
    assert.equal(unavailable.destroyed, true);
  });
});
