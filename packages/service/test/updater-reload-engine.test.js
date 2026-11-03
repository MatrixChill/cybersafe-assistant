import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

/**
 * PROVA DE RECARREGAMENTO EFETIVO da HashDB dentro do MOTOR.
 *
 * Porque este ficheiro existe: `engine.ts:660-664` recarrega o
 * `SignatureDatabase` quando `result.hashesUpdated` é verdadeiro, e até agora
 * NADA o provava. A suíte do core证明了 `SignatureDatabase.load()` lê o que está
 * em disco; a suíte do updater provou que o ficheiro é escrito atomicamente. Entre
 * as duas havia um buraco: um hash novo podia ser escrito e nunca contar, porque
 * a memória do processo ficava com o Map antigo. É precisamente «o motor usa o
 * novo corpus depois da atualização», pedido no requisito 3.
 *
 * Como é feito sem rede: as fronteiras do updater são substituídas na instância
 * (o padrão já usado em `dev-windows-readonly.test.js:452`), e o pedido de hashes
 * vem de um duplo. Nada toca o fornecedor. YARA e freshclam são deliberadamente
 * fazidos falhar: o que se mede é o eixo dos hashes, e uma fonte que falha não
 * pode invalidar o recarregamento das outras.
 */
const RAIZ = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cs-reload-"));
after(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

const KEY = "0123456789abcdef0123456789abcdef";
const NOVO_HASH = "4".repeat(64);

function fakeFeed() {
  return (_url, _opts, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.destroy = () => {};
      callback(res);
      queueMicrotask(() => {
        res.emit("data", JSON.stringify({
          query_status: "ok",
          data: [{ sha256_hash: NOVO_HASH, signature: "ReloadProof" }],
        }));
        res.emit("end");
      });
    };
    req.on = req.on ?? (() => {});
    return req;
  };
}

test("um hash escrito pelo updater é reconhecido pelo motor SEM reiniciar o processo", async () => {
  const { ProtectionEngineService } = await import("../dist/engine.js");
  const servico = new ProtectionEngineService(RAIZ);

  const defs = servico.definitionsDir;
  fs.mkdirSync(path.join(defs, "hashes"), { recursive: true });
  fs.mkdirSync(path.join(defs, "yara"), { recursive: true });
  const hashesFile = path.join(defs, "hashes", "default.json");
  // Estado inicial: só built-ins, e o hash novo NÃO é conhecido.
  fs.rmSync(hashesFile, { force: true });
  await servico.signatures.load(hashesFile);
  assert.ok(!servico.signatures.match(NOVO_HASH), "ponto de partida: o hash ainda não existe em memória");

  // Fronteiras: feed de hashes = duplo; YARA e freshclam = recusados de caso.
  servico.updater.hashFeedRequest = fakeFeed();
  servico.updater.hashAuthKey = KEY;
  servico.updater.downloadText = async () => {
    throw new Error("YARA desativado neste teste de recarga");
  };
  servico.updater.spawnFreshclam = () => {
    throw new Error("freshclam desativado neste teste de recarga");
  };

  const resultado = await servico.updater.checkAndUpdate(true);

  assert.equal(resultado.hashesUpdated, true, `o feed tinha um hash novo: ${JSON.stringify(resultado.errors)}`);
  // A asserção que falta em todo o lado: depois do ciclo, o MOTOR em memória
  // conhece o hash novo. Sem o re-carregamento do hook, isto falha.
  const hit = servico.signatures.match(NOVO_HASH);
  assert.ok(hit, "o SignatureDatabase do processo tem de ter o hash recém-escrito");
  assert.equal(hit.source, "malwarebazaar");
  assert.equal(hit.severity, "high", "sem 'critical' automático");

  // E o disco está coerente com a memória.
  const emDisco = JSON.parse(fs.readFileSync(hashesFile, "utf8"));
  assert.ok(emDisco.some((r) => r.sha256 === NOVO_HASH), "a base em disco contém o hash");
});

test("sem alteração escrita o motor NÃO recarrega, e isso não é uma falha", async () => {
  const { ProtectionEngineService } = await import("../dist/engine.js");
  const servico = new ProtectionEngineService(RAIZ);
  const defs = servico.definitionsDir;
  const hashesFile = path.join(defs, "hashes", "default.json");

  // Pré-condição declarada, não presumida: o hash JÁ está na base em disco, por
  // isso esta ida ao mesmo feed não pode produzir alteração. Não depende do que
  // o teste anterior escreveu — cada teste constrói o seu estado.
  fs.mkdirSync(path.dirname(hashesFile), { recursive: true });
  fs.writeFileSync(hashesFile, JSON.stringify([{ sha256: NOVO_HASH, family: "ReloadProof", severity: "high", source: "malwarebazaar" }]), "utf8");

  let recargas = 0;
  const loadOriginal = servico.signatures.load.bind(servico.signatures);
  servico.signatures.load = async (p) => {
    recargas += 1;
    return loadOriginal(p);
  };
  servico.updater.hashFeedRequest = fakeFeed();
  servico.updater.hashAuthKey = KEY;
  servico.updater.downloadText = async () => {
    throw new Error("YARA desativado neste teste de recarga");
  };
  servico.updater.spawnFreshclam = () => {
    throw new Error("freshclam desativado neste teste de recarga");
  };

  const resultado = await servico.updater.checkAndUpdate(true);
  assert.equal(resultado.hashesUpdated, false, "repetir o mesmo hash não é uma atualização");
  assert.equal(recargas, 0, "sem alteração não se recarrega — e a recarga não é um custo pago por nada");
});
