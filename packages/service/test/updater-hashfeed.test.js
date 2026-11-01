/**
 * DEFINITIONS-UPDATER — o percurso real do feed de hashes (MalwareBazaar).
 *
 * Estes casos existem porque o caminho anterior tinha quatro afirmações falsas
 * ao mesmo tempo: pedia um endpoint que exige `Auth-Key` sem o enviar; usava uma
 * cadência de 6 h contra uma janela oficial de 60 minutos (perdia 5 h por ciclo);
 * escrevia `severity: "critical"` para tudo o que a fonte não certifica; e
 * chamava «atualizado» a qualquer tentativa, incluindo a que não mudou nada.
 *
 * Tudo SIMULADO: `hashFeedRequest` é duplo, `renameHashes` é o real, a raiz é um
 * tmpdir próprio. Nenhuma chamada sai para a rede, nenhuma amostra de malware é
 * escrita em disco, nenhuma base de produção é tocada. A prova com a API real só
 * existe com uma chave do dono da máquina e está declarada como bloqueio.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DefinitionUpdater,
  HASH_FEED_INTERVAL_MS,
  MALWAREBAZAAR_AUTH_KEY_ENV,
  MAX_HASH_RECORDS,
  normalizarAuthMalwareBazaar,
} from "../dist/updater.js";

const KEY = "0123456789abcdef0123456789abcdef"; // 32 chars: formato sintético, não vale nada
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cs-hashfeed-"));

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** Duplo de `https.request` que REGISTA o que foi pedido — a asserção útil é tantas vezes o pedido que NÃO se fez. */
function fakeRequest(cabecalho) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.write = (data) => cabecalho.corpos.push(String(data));
    req.end = () => {
      cabecalho.pedidos.push({
        url,
        method: options.method,
        headers: { ...(options.headers ?? {}) },
      });
      const res = new EventEmitter();
      res.statusCode = cabecalho.statusCode ?? 200;
      res.headers = cabecalho.responseHeaders ?? {};
      res.destroy = () => {};
      callback(res);
      queueMicrotask(() => {
        for (const chunk of cabecalho.chunks ?? []) res.emit("data", chunk);
        if (cabecalho.abort) {
          res.emit("aborted");
          res.emit("close");
        } else if (cabecalho.semEnd) {
          res.emit("close");
        } else {
          res.emit("end");
        }
      });
    };
    if (cabecalho.spawnError) {
      queueMicrotask(() => req.emit("error", new Error(cabecalho.spawnError)));
    }
    return req;
  };
}

function updaterPara(pasta, cabecalho, extras = {}) {
  const defs = path.join(ROOT, pasta);
  return new DefinitionUpdater(defs, {
    hashFeedRequest: fakeRequest(cabecalho),
    hashAuthKey: KEY,
    ...extras,
  });
}

const ficheiroHashes = (pasta) => path.join(ROOT, pasta, "hashes", "default.json");
const payloadOk = (hashes, extra = {}) =>
  JSON.stringify({
    query_status: "ok",
    data: hashes.map((h) => ({ sha256_hash: h, signature: "FixtureGen", ...extra })),
  });

describe("chave de acesso: recusada antes da rede, nunca embutida", () => {
  test("sem chave não há pedido nenhum — e a base fica intacta", async () => {
    const cabecalho = { chunks: [], corpos: [], pedidos: [] };
    const defs = path.join(ROOT, "nochave");
    fs.mkdirSync(path.join(defs, "hashes"), { recursive: true });
    const anterior = JSON.stringify([{ sha256: "b".repeat(64), family: "X", severity: "high", source: "built-in" }]);
    fs.writeFileSync(ficheiroHashes("nochave"), anterior, "utf8");
    const guardado = process.env[MALWAREBAZAAR_AUTH_KEY_ENV];
    delete process.env[MALWAREBAZAAR_AUTH_KEY_ENV];
    try {
      const updater = new DefinitionUpdater(defs, { hashFeedRequest: fakeRequest(cabecalho) });
      await assert.rejects(() => updater["updateHashFeed"](), /sem chave de acesso/i);
      assert.equal(cabecalho.pedidos.length, 0, "sem chave o pedido não pode sair para a rede");
      assert.equal(fs.readFileSync(ficheiroHashes("nochave"), "utf8"), anterior, "nada é escrito");
    } finally {
      if (guardado !== undefined) process.env[MALWAREBAZAAR_AUTH_KEY_ENV] = guardado;
    }
  });

  test("o ambiente é lido no construtor, e uma chave inválida vale como ausente", async () => {
    process.env[MALWAREBAZAAR_AUTH_KEY_ENV] = "curta";
    try {
      const cabecalho = { chunks: [], corpos: [], pedidos: [] };
      const updater = new DefinitionUpdater(path.join(ROOT, "envkey"), { hashFeedRequest: fakeRequest(cabecalho) });
      await assert.rejects(() => updater["updateHashFeed"](), /sem chave/i);
      assert.equal(cabecalho.pedidos.length, 0);
    } finally {
      delete process.env[MALWAREBAZAAR_AUTH_KEY_ENV];
    }
    assert.equal(normalizarAuthMalwareBazaar("curta"), null);
    assert.equal(normalizarAuthMalwareBazaar("a".repeat(200)), null);
    assert.equal(normalizarAuthMalwareBazaar(`${KEY}\r\nX-Token: secreto`), null, "CR/LF num header é injeção");
    assert.equal(normalizarAuthMalwareBazaar(undefined), null);
    assert.equal(normalizarAuthMalwareBazaar(KEY), KEY);
  });

  test("o header Auth-Key vai em TODDO pedido, conforme a documentação oficial exige", async () => {
    const cabecalho = { chunks: [payloadOk(["c".repeat(64)])], corpos: [], pedidos: [] };
    const updater = updaterPara("header", cabecalho);
    await updater["updateHashFeed"]();
    assert.equal(cabecalho.pedidos.length, 1);
    assert.equal(cabecalho.pedidos[0].headers["Auth-Key"], KEY);
    assert.equal(cabecalho.pedidos[0].method, "POST");
    assert.match(cabecalho.corpos.join(""), /query=get_recent&selector=time/);
  });
});

describe("janela de 60 minutos: a cadência e o cursor", () => {
  test("a cadência do feed é estritamente mais curta que a janela oficial", () => {
    assert.ok(
      HASH_FEED_INTERVAL_MS < 60 * 60 * 1000,
      `tick de ${HASH_FEED_INTERVAL_MS / 60000} min não cobre a janela de 60 min do selector=time`,
    );
  });

  test("com lacuna de cobertura pede-se também a lista das 100 mais recentes, e declara-se a lacuna", async () => {
    const defs = path.join(ROOT, "lacuna");
    fs.mkdirSync(path.join(defs, "hashes"), { recursive: true });
    // Cursor de há duas horas: a janela de 60 min já não chega ao que passou.
    fs.writeFileSync(
      path.join(defs, ".update-meta.json"),
      JSON.stringify({ timestamp: Date.now(), components: {}, hashesCursorMs: Date.now() - 120 * 60 * 1000 }),
      "utf8",
    );
    const cabecalho = { chunks: [], corpos: [], pedidos: [], porCorpo: null };
    const updater = new DefinitionUpdater(defs, {
      hashFeedRequest: (url, options, callback) => {
        const req = new EventEmitter();
        req.write = (d) => cabecalho.corpos.push(String(d));
        req.end = () => {
          const corpo = String(cabecalho.corpos.at(-1) ?? "");
          cabecalho.pedidos.push(corpo);
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.destroy = () => {};
          callback(res);
          queueMicrotask(() => {
            const hash = corpo.includes("selector=100") ? "e".repeat(64) : "f".repeat(64);
            res.emit("data", payloadOk([hash]));
            res.emit("end");
          });
        };
        return req;
      },
      hashAuthKey: KEY,
    });
    const r = await updater["updateHashFeed"]();
    assert.equal(cabecalho.pedidos.length, 2, "dois pedidos: janela + lista das 100");
    assert.match(cabecalho.pedidos.join(" "), /selector=time/);
    assert.match(cabecalho.pedidos.join(" "), /selector=100/);
    assert.equal(r.lacunaCobertura, true);
    const meta = JSON.parse(fs.readFileSync(path.join(defs, ".update-meta.json"), "utf8"));
    assert.ok(Number(meta.hashesCursorMs) > 0, "o cursor fica registado para o próximo ciclo");
  });

  test("sem lacuna NÃO se faz o segundo pedido (respeitar os limites do fornecedor)", async () => {
    const cabecalho = { chunks: [payloadOk(["1".repeat(64)])], corpos: [], pedidos: [] };
    const updater = updaterPara("umasemlacuna", cabecalho);
    const r = await updater["updateHashFeed"]();
    assert.equal(cabecalho.pedidos.length, 1);
    assert.equal(r.lacunaCobertura, false);
  });
});

describe("validação do que a fonte devolve", () => {
  test("hash malformado e duplicado são rejeitados e CONTADOS, não ignorados em silêncio", async () => {
    const bom = "a".repeat(64);
    const payload = JSON.stringify({
      query_status: "ok",
      data: [
        { sha256_hash: bom, signature: "OK" },
        { sha256_hash: "zzzz", signature: "nao é hex" },
        { sha256_hash: "", signature: "vazio" },
        { sha256_hash: bom.toUpperCase(), signature: "duplicado por maiúsculas" },
        { signature: "sem campo hash" },
      ],
    });
    const cabecalho = { chunks: [payload], corpos: [], pedidos: [] };
    const updater = updaterPara("validacao", cabecalho);
    const r = await updater["updateHashFeed"]();
    assert.equal(r.total, 1, "só o hash válido entra");
    assert.equal(r.rejeitados, 4, JSON.stringify(r));
    const registros = JSON.parse(fs.readFileSync(ficheiroHashes("validacao"), "utf8"));
    assert.deepEqual(registros.map((x) => x.sha256), [bom], "normalizado em minúsculas");
  });

  test("a severidade escrita não é «critical» automática", async () => {
    const cabecalho = { chunks: [payloadOk(["b".repeat(64)])], corpos: [], pedidos: [] };
    const updater = updaterPara("severity", cabecalho);
    await updater["updateHashFeed"]();
    const registros = JSON.parse(fs.readFileSync(ficheiroHashes("severity"), "utf8"));
    assert.equal(registros[0].severity, "high");
    assert.notEqual(registros[0].severity, "critical", "o get_recent não certifica família nenhuma");
    assert.equal(registros[0].source, "malwarebazaar");
    assert.equal(registros[0].family, "FixtureGen");
  });

  test("signature ausente vira «Unknown», não um nome inventado", async () => {
    const payload = JSON.stringify({ query_status: "ok", data: [{ sha256_hash: "d".repeat(64) }] });
    const cabecalho = { chunks: [payload], corpos: [], pedidos: [] };
    const updater = updaterPara("semfam", cabecalho);
    await updater["updateHashFeed"]();
    const registros = JSON.parse(fs.readFileSync(ficheiroHashes("semfam"), "utf8"));
    assert.equal(registros[0].family, "Unknown");
  });

  test("o teto de crescimento corta por antiguidade e declara o corte", async () => {
    const defs = path.join(ROOT, "teto");
    fs.mkdirSync(path.join(defs, "hashes"), { recursive: true });
    const sementes = Array.from({ length: MAX_HASH_RECORDS - 2 }, (_, i) => ({
      sha256: i.toString(16).padStart(64, "0"),
      family: "Seed",
      severity: "high",
      source: "built-in",
    }));
    fs.writeFileSync(path.join(defs, "hashes", "default.json"), JSON.stringify(sementes), "utf8");
    const novos = [ "f".repeat(63) + "1", "f".repeat(63) + "2", "f".repeat(63) + "3" ];
    const cabecalho = { chunks: [payloadOk(novos)], corpos: [], pedidos: [] };
    const updater = new DefinitionUpdater(defs, { hashFeedRequest: fakeRequest(cabecalho), hashAuthKey: KEY });
    const avisos = [];
    const original = console.warn;
    console.warn = (...a) => { avisos.push(a.join(" ")); original(...a); };
    try {
      const r = await updater["updateHashFeed"]();
      assert.equal(r.total, MAX_HASH_RECORDS);
      assert.match(avisos.join("\n"), /limitada a \d+ registos/, "o corte é declarado");
      const registros = JSON.parse(fs.readFileSync(path.join(defs, "hashes", "default.json"), "utf8"));
      assert.equal(registros.length, MAX_HASH_RECORDS);
      assert.equal(registros.at(-1).sha256, novos.at(-1), "os mais recentes sobrevivem ao corte");
    } finally { console.warn = original; }
  });
});

describe("falhas da fonte: cada uma com a sua causa, nenhuma como «sucesso»", () => {
  const casos = [
    { nome: "sem rede (error no pedido)", extra: { spawnError: "ECONNREFUSED 127.0.0.1:443" }, esperado: /ECONNREFUSED/ },
    { nome: "HTTP 500", extra: { statusCode: 500 }, esperado: /HTTP 500/ },
    { nome: "HTTP 429 (limite do fornecedor)", extra: { statusCode: 429 }, esperado: /429.*limite de pedidos/i },
    { nome: "resposta não é JSON", extra: { chunks: ["isto não é json"] }, esperado: /não é JSON utilizável/ },
    { nome: "query_status = missing api key", extra: { chunks: [JSON.stringify({ query_status: "missing api key" })] }, esperado: /falta de Auth-Key/i },
    { nome: "query_status = bad auth", extra: { chunks: [JSON.stringify({ query_status: "bad auth" })] }, esperado: /Auth-Key recusada/ },
    { nome: "query_status = exceeding rate", extra: { chunks: [JSON.stringify({ query_status: "exceeding rate" })] }, esperado: /limite de pedidos/i },
    { nome: "query_status desconhecido", extra: { chunks: [JSON.stringify({ query_status: "nhamais" })] }, esperado: /não reconhecido \(nhamais\)/ },
    { nome: "data não é array", extra: { chunks: [JSON.stringify({ query_status: "ok", data: { x: 1 } })] }, esperado: /data não é um array/ },
    { nome: "corpo truncado (aborted)", extra: { chunks: ['{"query_status":"ok","data":['], abort: true }, esperado: /interrompida/i },
    { nome: "fecho sem end", extra: { chunks: [payloadOk(["a".repeat(64)])], semEnd: true }, esperado: /antes do fim/i },
  ];

  for (const c of casos) {
    test(c.nome, async () => {
      const pasta = `falha-${casos.indexOf(c)}`;
      const defs = path.join(ROOT, pasta);
      fs.mkdirSync(path.join(defs, "hashes"), { recursive: true });
      const anterior = JSON.stringify([{ sha256: "9".repeat(64), family: "Intocável", severity: "high", source: "built-in" }]);
      fs.writeFileSync(path.join(defs, "hashes", "default.json"), anterior, "utf8");
      const cabecalho = { chunks: [], corpos: [], pedidos: [], ...c.extra };
      const updater = new DefinitionUpdater(defs, { hashFeedRequest: fakeRequest(cabecalho), hashAuthKey: KEY });
      await assert.rejects(() => updater["updateHashFeed"](), c.esperado);
      assert.equal(
        fs.readFileSync(path.join(defs, "hashes", "default.json"), "utf8"),
        anterior,
        `${c.nome}: uma falha nunca pode deixar base truncada ou substituída`,
      );
      const sobras = fs.readdirSync(path.join(defs, "hashes")).filter((n) => n.endsWith(".tmp"));
      assert.deepEqual(sobras, [], "sem resíduo de staging depois de falhar");
    });
  }
});

describe("sem alterações ≠ atualizado", () => {
  test("o mesmo hash repetido não reescreve a base e devolve alterou=false", async () => {
    const hash = "7".repeat(64);
    const cabecalho1 = { chunks: [payloadOk([hash])], corpos: [], pedidos: [] };
    const updater1 = updaterPara("semalt", cabecalho1);
    const primeiro = await updater1["updateHashFeed"]();
    assert.equal(primeiro.alterou, true);

    const antes = fs.readFileSync(ficheiroHashes("semalt"), "utf8");
    const cabecalho2 = { chunks: [payloadOk([hash])], corpos: [], pedidos: [] };
    const updater2 = updaterPara2("semalt", [payloadOk([hash])]);
    const segundo = await updater2["updateHashFeed"]();
    assert.equal(segundo.alterou, false, "repetir o mesmo hash não é uma atualização");
    assert.equal(segundo.novos, 0);
    assert.equal(fs.readFileSync(ficheiroHashes("semalt"), "utf8"), antes, "o ficheiro não é tocado");
  });

  test("data=null é «não há adições», não «formato não reconhecido»", async () => {
    const payload = JSON.stringify({ query_status: "ok", data: null });
    const cabecalho = { chunks: [payload], corpos: [], pedidos: [] };
    const updater = updaterPara("null", cabecalho);
    const r = await updater["updateHashFeed"]();
    assert.equal(r.alterou, false);
    assert.equal(r.novos, 0);
  });
});

/** Segundo updater sobre a MESMA pasta, a provar que o estado sobrevive ao processo. */
function updaterPara2(pasta, chunks) {
  return new DefinitionUpdater(path.join(ROOT, pasta), {
    hashFeedRequest: fakeRequest({ chunks, corpos: [], pedidos: [] }),
    hashAuthKey: KEY,
  });
}

describe("metadado: a prova de verificação sobrevive à escrita do ciclo", () => {
  test("uma verificação sem alterações avança hashesCheckedAt sem tocar na base", async () => {
    const pasta = "meta-sozinho";
    const hash = "5".repeat(64);
    const cabecalho = { chunks: [payloadOk([hash])], corpos: [], pedidos: [] };
    const updater = updaterPara(pasta, cabecalho);
    await updater["updateHashFeed"]();
    const metaPath = path.join(ROOT, pasta, ".update-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.ok(Number(meta.hashesCheckedAt) > 0, "a verificação fica registada mesmo sem escrita");
    assert.ok(Number(meta.hashesCursorMs) > 0);

    // O ciclo seguinte reescreve o metadado por inteiro (`saveUpdateTimestamp`);
    // se ele não preservasse estes campos, a prova de verificação desaparecia
    // exatamente no momento em que outro componente é gravado.
    updater["saveUpdateTimestamp"]({ yara: true });
    const depois = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.equal(depois.hashesCheckedAt, meta.hashesCheckedAt, "timestamp de outro componente não apaga a prova dos hashes");
    assert.equal(depois.hashesCursorMs, meta.hashesCursorMs);
    assert.ok(Number(depois.components.yara) > 0, "e o componente novo é escrito normalmente");
  });

  // GAPA CONHECIDO e declarado, para não ficar escondido atrás de um ✔:
  // nada aqui prova que o `SignatureDatabase.load()` do motor é chamado depois
  // de uma escrita — isso vive em `engine.ts:660-664` (`afterDefinitionsUpdated`)
  // e não tem teste de recarga do lado do motor. A recarga é o que faz um hash
  // novo contar na próxima deteção, por isso fica como tarefa explícita, não
  // como sucesso desta suite.
});

describe("backoff e concorrência por fonte (requisito 4)", () => {
  const metaPath = (pasta) => path.join(ROOT, pasta, ".update-meta.json");

  test("falha consecutiva escala o backoff e recusa a fonte sem parar as outras", async () => {
    const pasta = "backoff";
    const defs = path.join(ROOT, pasta);
    const cabecalho = { chunks: [], corpos: [], pedidos: [], spawnError: "ECONNREFUSED" };
    const updater = new DefinitionUpdater(defs, { hashFeedRequest: fakeRequest(cabecalho), hashAuthKey: KEY });
    for (let i = 1; i <= 3; i += 1) {
      await assert.rejects(() => updater["updateHashFeed"](), /ECONNREFUSED/);
      updater["registarFalha"]("hashes", `tentativa ${i} falhou`);
      const meta = JSON.parse(fs.readFileSync(metaPath(pasta), "utf8"));
      assert.equal(meta.falhas.hashes.count, i, `contagem de tentativas ${i}`);
      assert.ok(meta.falhas.hashes.nextAllowedAtMs > Date.now(), "ainda em recusa");
    }
    // Base=45min → 45, 90, 180 min. Escalonar por tentativas é o que impede o
    // martelar do fornecedor; o teto existe para nunca crescer sem limite.
    const meta = JSON.parse(fs.readFileSync(metaPath(pasta), "utf8"));
    const esperaMin = Math.round((meta.falhas.hashes.nextAllowedAtMs - Date.now()) / 60000);
    assert.ok(esperaMin > 150 && esperaMin <= 181, `3ª falha deve ~180 min, obtido ${esperaMin}`);
    assert.equal(updater["componentStale"]("hashes"), false, "fonte em backoff não é re-tentada a cada tick");
    assert.equal(updater["componentStale"]("yara"), true, "e o backoff de uma fonte não arrasta as outras");
  });

  test("um sucesso limpa o histórico dessa fonte", () => {
    const pasta = "backoff-limpa";
    const defs = path.join(ROOT, pasta);
    fs.mkdirSync(path.join(defs, "hashes"), { recursive: true });
    const updater = new DefinitionUpdater(defs, { hashFeedRequest: fakeRequest({ chunks: [], corpos: [], pedidos: [] }), hashAuthKey: KEY });
    updater["registarFalha"]("hashes", "erro");
    assert.ok(JSON.parse(fs.readFileSync(metaPath(pasta), "utf8")).falhas.hashes);
    updater["limparFalha"]("hashes");
    assert.equal(JSON.parse(fs.readFileSync(metaPath(pasta), "utf8")).falhas.hashes, undefined);
    assert.equal(updater["componentStale"]("hashes"), true, "sem histórico, volta à cadência normal");
  });

  test("dois ciclos em paralelo: o segundo é recusado e não escreve", async () => {
    const defs = path.join(ROOT, "concorrencia");
    let libertar;
    const bloqueio = new Promise((resolve) => { libertar = resolve; });
    const cabecalho = { chunks: [payloadOk(["8".repeat(64)])], corpos: [], pedidos: [] };
    const updater = new DefinitionUpdater(defs, {
      hashFeedRequest: fakeRequest(cabecalho),
      hashAuthKey: KEY,
      // Seam do construtor, não um método adivinhado: `spawnFreshclam` existe
      // precisamente para permitir um filho que não nasce, sem tocar no spawn real.
      spawnFreshclam: () => {
        throw new Error("freshclam indisponível neste teste");
      },
    });
    updater["downloadText"] = async () => {
      await bloqueio;
      throw new Error("YARA desativado neste teste");
    };
    const primeiro = updater.checkAndUpdate(true);
    const segundo = await updater.checkAndUpdate(true);
    assert.equal(segundo.hashesUpdated, false);
    assert.match(segundo.warnings.join(" "), /já existe um ciclo/i);
    libertar();
    await primeiro;
    assert.ok(updater.operationInProgress === false, "o ciclo liberta a operação");
  });
});
