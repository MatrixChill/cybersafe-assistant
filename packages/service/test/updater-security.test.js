/**
 * TP-RETOMA-01 — updater: limite do feed de hashes e escrita atómica.
 *
 * O feed real do MalwareBazaar é pequeno; o defeito era acumular a resposta sem
 * limite e escrever `default.json` diretamente. Estes testes usam um
 * `https.request` duplo e uma raiz temporária própria: sem rede, sem DB, sem
 * serviço e sem tocar na base de produção.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DefinitionUpdater, MAX_HASH_FEED_BYTES } from "../dist/updater.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cs-updater-security-"));

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fakeRequest({ statusCode = 200, headers = {}, chunks = [], end = true, abort = false, close = false } = {}) {
  return (_url, _options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = headers;
      res.destroy = () => {};
      callback(res);
      queueMicrotask(() => {
        for (const chunk of chunks) res.emit("data", chunk);
        // `aborted` e `close` são cortes reais da resposta: sem `end`, o
        // updater tem de recusar em vez de esperar para sempre.
        if (abort) {
          res.emit("aborted");
          res.emit("close");
        } else if (close) {
          res.emit("close");
        } else if (end) {
          res.emit("end");
        }
      });
    };
    return req;
  };
}

test("content-length acima do limite é recusado antes de ler o corpo", async () => {
  const updater = new DefinitionUpdater(path.join(ROOT, "declared"), {
    hashFeedRequest: fakeRequest({ headers: { "content-length": String(MAX_HASH_FEED_BYTES + 1) }, end: false }),
  });
  await assert.rejects(() => updater["downloadMalwareBazaar"](), /limite/);
});

test("corpo sem content-length que cresce acima do limite é recusado", async () => {
  const updater = new DefinitionUpdater(path.join(ROOT, "streamed"), {
    hashFeedRequest: fakeRequest({ chunks: [Buffer.alloc(MAX_HASH_FEED_BYTES + 1, 0x20)] }),
  });
  await assert.rejects(() => updater["downloadMalwareBazaar"](), /limite/);
});

test("resposta abortada a meio recusa o feed em vez de pendurar", { timeout: 2000 }, async () => {
  const updater = new DefinitionUpdater(path.join(ROOT, "aborted"), {
    hashFeedRequest: fakeRequest({ chunks: ['{"query_status":"ok","data":['], abort: true }),
  });
  await assert.rejects(() => updater["downloadMalwareBazaar"](), /interrompida/);
});

test("resposta fechada sem end recusa o feed em vez de pendurar", { timeout: 2000 }, async () => {
  const updater = new DefinitionUpdater(path.join(ROOT, "closed"), {
    hashFeedRequest: fakeRequest({ chunks: ['{"query_status":"ok","data":['], close: true }),
  });
  await assert.rejects(() => updater["downloadMalwareBazaar"](), /fechada antes do fim/);
});

test("falha de rename da base de hashes preserva os bytes antigos e remove o staging", async () => {
  const defs = path.join(ROOT, "hash-rename-failure");
  const oldContent = JSON.stringify([{ sha256: "b".repeat(64), family: "Antigo", severity: "critical", source: "malwarebazaar" }], null, 2);
  fs.mkdirSync(path.join(defs, "hashes"), { recursive: true });
  const file = path.join(defs, "hashes", "default.json");
  fs.writeFileSync(file, oldContent);

  const payload = JSON.stringify({
    query_status: "ok",
    data: [{ sha256_hash: "c".repeat(64), signature: "Novo", file_type: "txt" }],
  });
  const updater = new DefinitionUpdater(defs, {
    hashFeedRequest: fakeRequest({ chunks: [payload] }),
    // Chave sintética: desde 2026-11-01 o caminho de alto nível recusa-se antes
    // da rede sem `Auth-Key`, e este teste quer provar a ESCRITA, não a recusa
    // (a recusa tem teste próprio em `updater-hashfeed.test.js`).
    hashAuthKey: "0123456789abcdef0123456789abcdef",
    renameHashes: async () => {
      throw new Error("rename falhou");
    },
  });

  await assert.rejects(() => updater["updateHashFeed"](), /rename falhou/);
  assert.equal(fs.readFileSync(file, "utf8"), oldContent, "a base anterior tem de ficar intacta");
  const leftovers = fs.readdirSync(path.join(defs, "hashes")).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "o staging .tmp tem de ser removido na falha");
});

test("falha de rename do corpus YARA preserva o corpus antigo e remove o staging", async () => {
  const defs = path.join(ROOT, "yara-rename-failure");
  fs.mkdirSync(path.join(defs, "yara"), { recursive: true });
  const file = path.join(defs, "yara", "default.yar");
  const oldContent = "rule corpus_antigo { condition: true }\n";
  fs.writeFileSync(file, oldContent);

  const updater = new DefinitionUpdater(defs, {
    renameYaraRules: async () => {
      throw new Error("rename YARA falhou");
    },
  });

  await assert.rejects(() => updater["writeYaraRulesAtomically"]("rule corpus_novo { condition: true }\n"), /rename YARA falhou/);
  assert.equal(fs.readFileSync(file, "utf8"), oldContent, "o corpus anterior tem de ficar intacto");
  const leftovers = fs.readdirSync(path.join(defs, "yara")).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "o staging .tmp tem de ser removido na falha");
});

test("base de hashes é escrita por staging+rename e não deixa .tmp", async () => {
  const defs = path.join(ROOT, "atomic");
  const hash = "a".repeat(64);
  const payload = JSON.stringify({
    query_status: "ok",
    data: [{ sha256_hash: hash, signature: "Fixture", file_type: "txt" }],
  });
  const updater = new DefinitionUpdater(defs, {
    hashFeedRequest: fakeRequest({ chunks: [payload] }),
    hashAuthKey: "0123456789abcdef0123456789abcdef",
  });

  const resultado = await updater["updateHashFeed"]();

  const file = path.join(defs, "hashes", "default.json");
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(records.length, 1);
  assert.equal(records[0].sha256, hash);
  assert.equal(resultado.alterou, true, "hash novo em disco é uma alteração real");
  assert.equal(records[0].severity, "high", "a severidade deixou de «critical» automática");
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "staging .tmp não pode sobreviver ao rename");
});
