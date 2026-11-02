import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * §9 exige que a quarentena respeite «Auditoria». Os cortes anteriores mediram o
 * movimento e as recusas olhando para os EVENTOS publicados — e neste motor os
 * eventos vivem enquanto o processo vive. Esta página mede o outro lado: o que
 * fica em `<baseDir>/history.jsonl` depois de a operação acabar.
 *
 * É por isso que este ficheiro não faz stub a `logHistory`: fazer stub ao
 * destino da auditoria para testar a auditoria seria medir o substituto. O
 * motor é instalado num diretório temporário, como nos outros testes de
 * integração daqui, e as linhas são lidas do ficheiro real.
 *
 * Nada fora dos diretórios temporários é tocado, nada é montado, e os alvos são
 * ficheiros benignos criados por este teste — exceto onde o caso precisa de um
 * caminho protegido real, em que se usa o próprio executável do Node e apenas se
 * afirma a recusa.
 */

const CONTEUDO = "Benign disposable fixture for the quarantine audit trail.";

function analysisPara(artifactPath, fileName, sha256) {
  return {
    artifactPath, fileName, size: Buffer.byteLength(CONTEUDO), sha256,
    verdict: "malicious", severity: "critical", riskScore: 100, confidence: 0.99,
    rulesTriggered: ["known_bad_hash"], factors: [], recommendedAction: "quarantined",
    scanTimestamp: new Date().toISOString(),
  };
}

async function motor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-p3-quarantine-audit-"));
  const e = new ProtectionEngineService(dir);
  await e.quarantine.init();
  const eventos = [];
  e.eventBus.on("event", (event) => eventos.push(event));
  t.after(async () => {
    await e.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { e, dir, eventos };
}

/** Ficheiro benigno FORA da raiz do serviço: dentro dela seria caminho protegido. */
async function alvoForaDoServico(t) {
  const fora = await fs.mkdtemp(path.join(os.tmpdir(), "cs-p3-quarantine-alvo-"));
  t.after(() => fs.rm(fora, { recursive: true, force: true }));
  const ficheiro = path.join(fora, "ameostra.txt");
  await fs.writeFile(ficheiro, CONTEUDO);
  const sha256 = crypto.createHash("sha256").update(CONTEUDO).digest("hex");
  return { ficheiro, analysis: analysisPara(ficheiro, "ameostra.txt", sha256), sha256 };
}

async function linhasHistorico(e) {
  const bruto = await fs.readFile(e.historyPath, "utf8").catch(() => "");
  return bruto.split("\n").filter(Boolean).map((linha) => JSON.parse(linha));
}

/**
 * O motor chama `void this.logHistory(...)` — não espera pelo `appendFile`. Ler
 * o ficheiro logo a seguir à chamada é por isso uma corrida, e a mesma razão
 * faz este helper existir: o que se quer provar é que a linha aparece, não com
 * que atraso do escalonador. O prazo é curto e a falha diz o que veio.
 */
async function esperaLinha(e, previsao, descricao) {
  const ate = Date.now() + 3000;
  for (;;) {
    const linhas = await linhasHistorico(e);
    if (previsao(linhas)) return linhas;
    if (Date.now() > ate) {
      assert.fail(`${descricao} — em 3 s o ficheiro tinha ${linhas.length} linha(s): ${JSON.stringify(linhas.map((l) => l.type))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("isolamento confirmado fica numa linha que nomeia o mesmo objeto do manifesto", async (t) => {
  const { e, dir } = await motor(t);
  const { ficheiro, analysis, sha256 } = await alvoForaDoServico(t);

  assert.equal(await e.requestQuarantine(analysis, "manual"), true, "o isolamento tem de acontecer");

  const linhas = await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.added"),
    "um isolamento confirmado tinha de ficar numa linha de história");
  const sucesso = linhas.filter((l) => l.type === "quarantine.added");
  assert.equal(sucesso.length, 1, `uma linha de sucesso por isolamento, vieram ${sucesso.length}`);
  const linha = sucesso[0];

  // A auditoria tem de apontar para o objeto real, não apenas dizer que algo
  // aconteceu: as três coisas abaixo são o que permite a alguém, mais tarde,
  // provar o que foi isolado e onde está.
  const manifesto = JSON.parse(await fs.readFile(path.join(dir, "quarantine", "manifest.json"), "utf8"));
  assert.equal(manifesto.length, 1);
  assert.equal(linha.entry.id, manifesto[0].id, "a linha e o manifesto nomeiam a mesma entrada");
  assert.equal(linha.entry.sha256, sha256, "a linha regista o digest dos bytes movidos");
  assert.equal(linha.entry.originalPath, ficheiro);
  await assert.rejects(fs.stat(ficheiro), "o caminho original ficou vazio");
  assert.ok(await fs.stat(manifesto[0].quarantinePath), "e a cópia isolada está onde a linha diz");
  assert.ok(typeof linha.timestamp === "string" && !Number.isNaN(Date.parse(linha.timestamp)), "com instante analisável");
});

test("a linha de sucesso diz se foi o utilizador que autorizou", async (t) => {
  const { e } = await motor(t);
  const { ficheiro, analysis } = await alvoForaDoServico(t);
  assert.equal(await e.requestQuarantine(analysis, "manual"), true);

  const linha = (await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.added"),
    "o isolamento confirmado tinha de ficar numa linha de história"))
    .find((l) => l.type === "quarantine.added");
  assert.equal(linha.authorization, "manual",
    "sem o modo de autorização na linha de sucesso, o registo em disco não distingue um pedido do utilizador de um automático");
});

test("recusa por caminho protegido é auditada com o motivo", async (t) => {
  const { e, eventos } = await motor(t);
  const antes = await fs.lstat(process.execPath);

  assert.equal(await e.requestQuarantine(analysisPara(process.execPath, path.basename(process.execPath), "a".repeat(64)), "manual"), false);

  const linhas = await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.failed"),
    "a recusa tinha de ficar no ficheiro, não só nos eventos");
  const linha = linhas.find((l) => l.type === "quarantine.failed");
  assert.equal(linha.reason, "protected-path");
  assert.equal(linha.artifactPath, process.execPath);
  assert.equal(linha.authorization, "manual");
  assert.equal(linhas.some((l) => l.type === "quarantine.added"), false,
    "uma recusa não pode deixar registo de sucesso");
  const depois = await fs.lstat(process.execPath);
  assert.equal(antes.ino, depois.ino, "e nada se moveu");
  assert.equal(eventos.filter((x) => x.type === "quarantine.failed").length, 1, "um evento, uma linha");
});

test("isolamento não confirmado regista a falha e não o sucesso", async (t) => {
  const { e } = await motor(t);
  const { ficheiro, analysis } = await alvoForaDoServico(t);
  // O que se mede aqui é o registo, não o manager: este stub é o resultado
  // possível do manager (devolve `null` quando a operação não se confirma).
  e.quarantine.quarantine = async () => null;

  assert.equal(await e.requestQuarantine(analysis, "automatic"), false);

  const linhas = await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.failed"),
    "a falta de confirmação tinha de ser auditável");
  assert.equal(linhas.some((l) => l.type === "quarantine.added"), false);
  const falha = linhas.find((l) => l.type === "quarantine.failed");
  assert.equal(falha.authorization, "automatic", "o modo de quem pediu fica na linha");
  assert.equal(falha.sha256, analysis.sha256, "com o digest a que o pedido dizia respeitar");
  assert.deepEqual(await fs.readFile(ficheiro, "utf8"), CONTEUDO, "o ficheiro ficou onde estava");
});

test("repetir o pedido sobre o mesmo alvo não duplica nem inventa", async (t) => {
  const { e } = await motor(t);
  const { ficheiro, analysis } = await alvoForaDoServico(t);

  assert.equal(await e.requestQuarantine(analysis, "manual"), true);
  assert.equal(await e.requestQuarantine(analysis, "manual"), false, "o segundo pedido não tem ficheiro para mover");

  const linhas = await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.failed"),
    "a segunda tentativa tinha de ficar registada como falha");
  assert.equal(linhas.filter((l) => l.type === "quarantine.added").length, 1, "uma linha de sucesso, não duas");
  assert.equal(linhas.filter((l) => l.type === "quarantine.failed").length, 1, "uma linha de falha, não duas");
  assert.ok(!(await fs.stat(ficheiro).catch(() => null)), "o alvo continua ausente");
});
