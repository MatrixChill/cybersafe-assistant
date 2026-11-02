import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { QuarantineManager } from "../dist/response.js";

/**
 * §9 pede que a quarentena respeite «Identidade do ficheiro» e «Links
 * simbólicos». O `QuarantineManager` já tem testes para o digest trocado, a
 * falha do manifesto antes do movimento, a falha do `rename`, a falha do
 * `chmod` depois do movimento e o destino alterado durante o isolamento
 * (`recovery-quarantine.test.js`). O que não estava medido era a família de
 * guardas do `lstat`: `isFile()`, `!isSymbolicLink()` e `nlink === 1`.
 *
 * A razão pela qual `nlink` interessa não é cosmética: mover um ficheiro com
 * dois nomes tira um dos nomes do sítio e deixa o outro a apontar exatamente
 * para os mesmos bytes. O isolado no manifesto teria o digest certo e o
 * movimento teria acontecido, mas o ficheiro malicioso continuaria alcançável
 * pelo caminho de sempre — que é o oposto do que «isolado» quer dizer.
 *
 * Os casos criam links reais no sistema de ficheiros e recusam-se a afirmar
 * qualquer coisa quando a plataforma não os permite criar: um `skip` com o
 * motivo, nunca uma passagem contada à sorte.
 */

const CONTEUDO = "Benign disposable fixture for the identity guards.";
const SHA = crypto.createHash("sha256").update(CONTEUDO).digest("hex");

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-p3-quarantine-identity-"));
  const dados = path.join(base, "service-data");
  await fs.mkdir(dados, { recursive: true });
  const original = path.join(base, "fixture.txt");
  await fs.writeFile(original, CONTEUDO);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const analysis = {
    artifactPath: original, fileName: "fixture.txt", size: Buffer.byteLength(CONTEUDO), sha256: SHA,
    verdict: "malicious", severity: "critical", riskScore: 100, confidence: 0.99,
    rulesTriggered: ["known_bad_hash"], factors: [], recommendedAction: "quarantined",
    scanTimestamp: new Date().toISOString(),
  };
  const manager = new QuarantineManager(dados);
  await manager.init();
  return { base, dados, manager, original, analysis };
}

/**
 * Criar um link nem sempre é permitido — sem privilégios em Windows, em
 * sistemas de ficheiros sem suporte, num volume diferente. Nestes casos o que
 * se sabe é que a máquina não deixou tentar, não que a guarda funcione; isso
 * vai para o relatório como `skip` com o código de erro.
 */
async function tenta(mutar) {
  try {
    await mutar();
    return null;
  } catch (error) {
    return `${error?.code ?? "erro"}`;
  }
}

test("link simbólico: o isolamento recusa, e o alvo não é tocado", async (t) => {
  const { base, manager, analysis } = await fixture(t);
  const alvo = path.join(base, "alvo.txt");
  await fs.writeFile(alvo, CONTEUDO);
  await fs.unlink(analysis.artifactPath);
  const motivo = await tenta(() => fs.symlink(alvo, analysis.artifactPath));
  if (motivo) {
    t.skip(`a máquina não permitiu criar o link simbólico (${motivo}) — a guarda não é exercitável aqui`);
    return;
  }

  assert.equal(await manager.quarantine(analysis), null, "um link simbólico nunca é isolado");
  assert.deepEqual(await fs.readFile(alvo, "utf8"), CONTEUDO, "o alvo do link fica onde estava");
  const ligacao = await fs.lstat(analysis.artifactPath);
  assert.ok(ligacao.isSymbolicLink(), "e o link continua a ser um link, não um ficheiro movido");
  assert.equal(manager.list().length, 0, "nem uma entrada de recuperação é escrita");
});

test("link físico (nlink 2): recusa mesmo com o digest certo, e nenhum nome desaparece", async (t) => {
  const { base, manager, original, analysis } = await fixture(t);
  const segundoNome = path.join(base, "segundo-nome.txt");
  const motivo = await tenta(() => fs.link(original, segundoNome));
  if (motivo) {
    t.skip(`a máquina não permitiu criar o link físico (${motivo}) — a guarda não é exercitável aqui`);
    return;
  }

  // O digest é o certo e o tamanho também: a recusa só pode vir do `nlink`.
  assert.equal(crypto.createHash("sha256").update(await fs.readFile(original)).digest("hex"), SHA);
  assert.equal((await fs.lstat(original)).nlink, 2, "o link é mesmo dois nomes sobre o mesmo inode");

  assert.equal(await manager.quarantine(analysis), null, "um ficheiro com mais um nome não pode ser isolado");
  assert.deepEqual(await fs.readFile(original, "utf8"), CONTEUDO, "o primeiro nome continua lá");
  assert.deepEqual(await fs.readFile(segundoNome, "utf8"), CONTEUDO, "o segundo nome também — é isto que a guarda protege");
  assert.equal(manager.list().length, 0, "sem entrada, sem manifesto a afirmar um isolamento que não aconteceu");
});

test("link físico sobre a cópia isolada: o restauro recusa e nada é movido", async (t) => {
  const { manager, dados, original, analysis } = await fixture(t);
  const entrada = await manager.quarantine(analysis);
  assert.ok(entrada?.id, "o isolamento de um ficheiro normal tem de acontecer");

  const carona = path.join(dados, "quarantine", "carona.link");
  const motivo = await tenta(() => fs.link(entrada.quarantinePath, carona));
  if (motivo) {
    t.skip(`a máquina não permitiu criar o link físico na cópia isolada (${motivo})`);
    return;
  }

  const resultado = await manager.restore(entrada.id);
  assert.equal(resultado.success, false, "uma cópia com mais de um nome deixa de ser única e o restauro para");
  assert.match(resultado.error ?? "", /quarentena|inv[aá]lido/i, "a recusa tem de dizer porquê");
  await assert.rejects(fs.stat(original), "o destino não é escrito");
  assert.equal(manager.list().some((x) => x.id === entrada.id), true, "a entrada preservada continua recuperável");
});
