import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ProtectionEngineService } from "../dist/engine.js";
import { loadQuarantinePolicy } from "../dist/quarantine-policy.js";

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

/** Isolar de verdade, pelo motor, e devolver a entrada confirmada pela linha de sucesso. */
async function isolar(e, analysis) {
  assert.equal(await e.requestQuarantine(analysis, "manual"), true, "o isolamento tem de acontecer primeiro");
  const linhas = await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.added"),
    "o isolamento tinha de ficar no registo antes de se falar do restauro");
  const entrada = linhas.find((l) => l.type === "quarantine.added").entry;
  assert.ok(entrada?.id, "a linha de sucesso traz a entrada");
  return entrada;
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

/**
 * O restauro é a outra metade do ciclo, e era a única mutação da quarentena sem
 * registo em disco: publicava `quarantine.restored` no bus e devolvia o resultado
 * à janela, mas nada ficava no `history.jsonl`. Os três casos abaixo medem o
 * registo do caminho que a janela da Quarentena usa (`restoreQuarantine`), com o
 * `QuarantineManager` real a mover ficheiros de verdade.
 */

test("restauro pela janela fica numa linha que nomeia o ficheiro devolvido", async (t) => {
  const { e } = await motor(t);
  const { ficheiro, analysis, sha256 } = await alvoForaDoServico(t);
  const entrada = await isolar(e, analysis);

  const resultado = await e.restoreQuarantine(entrada.id);
  assert.equal(resultado.success, true, `restauro falhou: ${resultado.error}`);

  const linha = (await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.restored"),
    "um ficheiro restaurado tinha de ficar no registo"))
    .find((l) => l.type === "quarantine.restored");
  // É isto que a linha tem de permitir responder sem estar a adivinhar: o `id`
  // que a janela mostra não diz a ninguém que ficheiro voltou a existir.
  assert.equal(linha.id, entrada.id);
  assert.equal(linha.sha256, sha256, "com o digest do que voltou");
  assert.equal(linha.fileName, "ameostra.txt");
  assert.equal(linha.artifactPath, ficheiro, "e o caminho onde voltou a existir");
  assert.equal(linha.trustAfterRestore, false, "sem pedido de confiança, a linha diz que não houve");
  assert.equal(linha.error, undefined, "um restauro completo não fica com erro pendente na linha");
  assert.deepEqual(await fs.readFile(ficheiro, "utf8"), CONTEUDO, "e o ficheiro está lá, com os bytes certos");
});

test("restauro recusado é auditado com o motivo e o ficheiro continua isolado", async (t) => {
  const { e, dir } = await motor(t);
  const { ficheiro, analysis } = await alvoForaDoServico(t);
  const entrada = await isolar(e, analysis);

  const bytes_alheios = "escrito por outra coisa entretanto — não pode ser substituído";
  await fs.writeFile(ficheiro, bytes_alheios);
  const resultado = await e.restoreQuarantine(entrada.id);
  assert.equal(resultado.success, false, "um destino ocupado nunca é substituído");

  const linha = (await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.restore.failed"),
    "a recusa do restauro tinha de ser auditável"))
    .find((l) => l.type === "quarantine.restore.failed");
  assert.equal(linha.id, entrada.id);
  assert.equal(linha.artifactPath, ficheiro, "a linha diz em que caminho a recusa aconteceu");
  assert.ok(/destino/i.test(linha.error ?? ""), `a linha tem de dizer porquê, veio: ${linha.error}`);
  assert.equal(await fs.readFile(ficheiro, "utf8"), bytes_alheios, "e nada foi substituído");
  const manifesto = JSON.parse(await fs.readFile(path.join(dir, "quarantine", "manifest.json"), "utf8"));
  assert.equal(manifesto.some((x) => x.id === entrada.id), true, "a entrada continua recuperável");
  assert.equal(linha.trustAfterRestore, false);
});

test("o pedido de confiança permanente fica na linha, e só então o hash é permitido", async (t) => {
  const { e } = await motor(t);
  const { analysis } = await alvoForaDoServico(t);
  const entrada = await isolar(e, analysis);
  const permitidos = [];
  const allowHashOriginal = e.allowHash.bind(e);
  e.allowHash = async (hash) => { permitidos.push(hash); return allowHashOriginal(hash); };

  assert.equal((await e.restoreQuarantine(entrada.id, true)).success, true);
  const linha = (await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.restored"),
    "o restauro com confiança tinha de ficar no registo"))
    .find((l) => l.type === "quarantine.restored");
  assert.equal(linha.trustAfterRestore, true,
    "a decisão de nunca mais voltar a assinalar este ficheiro é a consequência mais duradoura do restauro e não pode ficar fora da auditoria");
  assert.deepEqual(permitidos, [linha.sha256], "e a linha não afirma confiança que o motor não aplicou");
});

/**
 * §9 pede também «Confirmação», e é aqui que as duas alíneas se costuram: sem o
 * consentimento literal o motor não aceita `automatic-high-confidence`, e a
 * pergunta que um registo tem de responder dias depois é precisamente «quem
 * deixou o motor isolar sozinho?». O canal é o real (`quarantine.policy.set`),
 * pelo `dispatch`, como a janela faz.
 */

test("o consentimento literal para isolar sozinho fica no registo e no ficheiro", async (t) => {
  const { e, dir } = await motor(t);
  const politica = path.join(dir, "protection-policy.json");

  assert.deepEqual(await e.dispatch("quarantine.policy.set", { policy: "automatic-high-confidence", consent: true }),
    { ok: true, policy: "automatic-high-confidence" });

  const linha = (await esperaLinha(e, (ls) => ls.some((l) => l.type === "quarantine.policy.changed"),
    "a decisão de consentir isolamento automático tinha de ficar auditável"))
    .find((l) => l.type === "quarantine.policy.changed");
  assert.equal(linha.policy, "automatic-high-confidence");
  assert.equal(linha.authorization, "user-consent",
    "é esta linha que permite a uma linha posterior com authorization «automatic» significar «o utilizador tinha consentido»");
  assert.ok(typeof linha.timestamp === "string" && !Number.isNaN(Date.parse(linha.timestamp)));
  // O que a janela mostra depois de reiniciar vem do ficheiro, não da memória.
  assert.equal(await loadQuarantinePolicy(politica), "automatic-high-confidence");
});

test("sem o consentimento literal não há linha, nem política mudada", async (t) => {
  const { e, dir } = await motor(t);
  const { ficheiro, analysis } = await alvoForaDoServico(t);
  const politica = path.join(dir, "protection-policy.json");
  // Uma escrita conhecida primeiro: `logHistory` não espera pelo `appendFile`, por
  // isso só se pode afirmar a AUSÊNCIA de uma linha depois de provar que o
  // escritor já está vivo — senão seria a corrida a parecer uma recusa.
  await isolar(e, analysis);

  assert.deepEqual(await e.dispatch("quarantine.policy.set", { policy: "automatic-high-confidence" }),
    { ok: false, policy: "warn", error: "consent_required" });
  assert.equal(e.quarantinePolicy, "warn", "o motor continua em aviso");
  assert.equal(await loadQuarantinePolicy(politica), "warn", "e o ficheiro também");

  const linhas = await linhasHistorico(e);
  assert.equal(linhas.some((l) => l.type === "quarantine.policy.changed"), false,
    "nada mudou, logo nada tem de estar no registo");
  assert.ok(!(await fs.stat(ficheiro).catch(() => null)), "o alvo continua isolado, nada foi tocado pela recusa");
});
