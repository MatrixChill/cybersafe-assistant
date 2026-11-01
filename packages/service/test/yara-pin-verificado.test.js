import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DefinitionUpdater, YARA_PIN, pinoInvalido } from "../dist/updater.js";

/**
 * Pin verificado das fontes YARA (decisão D4 do proprietário, 2026-11-01).
 *
 * Antes disto o updater buscava `…/master/<ficheiro>`: aceitava o que uma branch
 * mutável publicasse, desde que compilasse. O pedido foi explícito — «não confiar
 * automaticamente em conteúdo novo apenas porque compila» e «preferir um corpus
 * revisto, distribuído por um canal de confiança». Aqui o que se verifica é essa
 * propriedade: fonte imutável por commit, conteúdo por SHA-256, recusa antes de
 * tocar no corpus, e o corpus anterior preservado.
 */

const REV = "1edbe8e0ddc32dc47b76e370beb51db16c07f487";
const REGRAS = "rule pin_ok { condition: true }\n";
const DIGESTO = createHash("sha256").update(REGRAS, "utf8").digest("hex");

async function cenário(pin) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-yara-pin-"));
  await fs.mkdir(path.join(dir, "yara"), { recursive: true });
  const corpus = path.join(dir, "yara", "default.yar");
  const anterior = "rule corpus_anterior { condition: filesize > 0 }\n";
  await fs.writeFile(corpus, anterior, "utf8");
  const pedidos = [];
  const updater = new DefinitionUpdater(dir, { yaraPin: Array.isArray(pin) ? pin : pin });
  updater.downloadText = async (url) => {
    pedidos.push(url);
    return REGRAS;
  };
  updater.updateClamAV = async () => { throw new Error("desligado neste lote"); };
  updater.updateHashFeed = async () => ({ alterou: false, novos: 0, total: 0, rejeitados: 0, lacunaCobertura: false });
  return { dir, corpus, anterior, updater, pedidos };
}

const PIN_OK = {
  id: "pin_ok.yar", repo: "fixture/yara", file: "rules/pin_ok.yar",
  revision: REV, sha256: DIGESTO, ruleClass: "production",
};

describe("fonte pinada por commit e digesto", () => {
  it("o URL pedido é o do commit, nunca uma branch", async () => {
    const { dir, updater, pedidos } = await cenário([PIN_OK]);
    try {
      const resultado = await updater.checkAndUpdate(true);
      assert.equal(pedidos.length, 1, "uma descarga por fonte pinada");
      assert.ok(pedidos[0].includes(`/${REV}/`), `esperava o commit no URL: ${pedidos[0]}`);
      assert.equal(/\/(master|main|develop)\//.test(pedidos[0]), false, "branch mutável no URL de runtime");
      assert.equal(resultado.yaraUpdated, true);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("conteúdo que não bate com o pin é recusado e o corpus anterior fica", async () => {
    const { dir, corpus, anterior, updater, pedidos } = await cenário([{ ...PIN_OK, sha256: "f".repeat(64) }]);
    try {
      const resultado = await updater.checkAndUpdate(true);
      assert.equal(pedidos.length, 1, "a recusa é depois da descarga, não antes de ir à rede");
      assert.equal(resultado.yaraUpdated, false, "conteúdo não revisado não pode dar o corpus por atualizado");
      assert.equal(await fs.readFile(corpus, "utf8"), anterior, "o corpus em uso não pode ser substituído por conteúdo não pinado");
      assert.ok(
        resultado.errors.some((e) => /não corresponde ao pin revisto/i.test(e)),
        `a causa tem de vir no resultado: ${JSON.stringify(resultado.errors)}`,
      );
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("pin malformado nunca vai à rede", () => {
    const casos = [
      [{ ...PIN_OK, revision: "master" }, /SHA-1/],
      [{ ...PIN_OK, revision: "abc" }, /SHA-1/],
      [{ ...PIN_OK, sha256: "muito-curto" }, /digesto|64 hex/i],
      [{ ...PIN_OK, repo: "sem-barra" }, /dono/],
      [{ ...PIN_OK, file: "/fora/da/raiz.yar" }, /fora do repositório/],
      [{ ...PIN_OK, file: "../../etc.yar" }, /fora do repositório/],
    ];
    for (const [pin, regex] of casos) {
      assert.match(String(pinoInvalido(pin)), regex, `deveria recusar ${JSON.stringify(pin.revision ?? pin.file ?? pin.repo)}`);
    }
    assert.equal(pinoInvalido(PIN_OK), null, "o pin bom não pode ser recusado");
  });

  it("sem nenhuma fonte pinada não se escreve nem se descarrega", async () => {
    const { dir, corpus, anterior, updater, pedidos } = await cenário([]);
    try {
      const resultado = await updater.checkAndUpdate(true);
      assert.equal(pedidos.length, 0, "lista de pin vazia é erro de configuração, não licença para descarregar o que estiver na branch");
      assert.equal(await fs.readFile(corpus, "utf8"), anterior);
      assert.ok(resultado.errors.some((e) => /nenhuma fonte pinada/i.test(e)), JSON.stringify(resultado.errors));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("as fontes do produto estão todas pinadas por commit e digesto", () => {
    assert.ok(YARA_PIN.length >= 1, "o produto tem de trazer fontes pinadas");
    for (const pin of YARA_PIN) {
      assert.equal(pinoInvalido(pin), null, `${pin.id} malformado: ${pinoInvalido(pin)}`);
      assert.match(pin.revision, /^[0-9a-f]{40}$/, `${pin.id} sem commit de 40 hex`);
      assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${pin.id} sem digesto de 64 hex`);
      assert.ok(["production", "test", "reference"].includes(pin.ruleClass), `${pin.id} sem classe declarada`);
    }
  });
});
