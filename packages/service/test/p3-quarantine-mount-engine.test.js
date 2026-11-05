import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { lerPontosDeMontagemReais } from "@cybersafe/core";
import { ProtectionEngineService } from "../dist/engine.js";
import { isProtectedQuarantinePath, hasReparseFreePath } from "../dist/quarantine-path-policy.js";

/**
 * §9 pede que a quarentena respeite os pontos de montagem. As regras puras já
 * têm teste próprio; este instala o MOTOR e pergunta-lhe por um isolamento, para
 * que o que fica provado seja a linha que o produto executa: o evento
 * `quarantine.failed` com o `reason` certo, publicado ANTES de qualquer
 * movimento.
 *
 * Só corre fora de Windows: em `win32` a regra das montagens devolve `null` sem
 * abrir a tabela, e um teste que afirmasse «recusado por montagem» lá seria uma
 * mentira sobre outra plataforma. Em Windows o ficheiro é explicitamente
 * `skip`ado — a razão fica visível em vez de o resultado parecer uma passagem.
 *
 * O alvo é sempre uma montagem REAL da máquina de quem corre, escolhida ao
 * instante a partir da tabela do kernel. Nada é montado, desmontado, escrito
 * dentro da montagem ou movido: quando a recusa é correta, nada deve ter
 * acontecido, e é isso que a última asserção de cada caso vai verificar.
 */

const CONTEUDO_FIXTURE = "Benign disposable fixture for the Linux quarantine gate.";

function analysisPara(artifactPath, fileName, sha256) {
  return {
    artifactPath,
    fileName,
    size: CONTEUDO_FIXTURE.length,
    sha256,
    verdict: "malicious",
    severity: "critical",
    riskScore: 100,
    confidence: 0.99,
    rulesTriggered: ["known_bad_hash"],
    factors: [],
    recommendedAction: "quarantined",
    scanTimestamp: new Date().toISOString(),
  };
}

async function motor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-p3-quarantine-engine-"));
  const e = new ProtectionEngineService(dir);
  await e.quarantine.init();
  // Nada disto escreve fora do diretório temporário; são as alças que o teste
  // nunca quer que toquem no disco de quem corre a suite.
  e.logHistory = async () => {};
  e.actionsLog.write = async () => {};
  const eventos = [];
  e.eventBus.on("event", (event) => eventos.push(event));
  t.after(async () => {
    await e.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { e, dir, eventos };
}

/**
 * A montagem a usar, ou `null` quando a máquina não tem nenhuma montagem que
 * este portão seja o único a proteger. `hasReparseFreePath` é chamada aqui pelo
 * teste (não pelo motor) só para confirmar que o caso exercita mesmo a regra das
 * montagens: se um dos dois portões anteriores já recusasse, o `reason` esperado
 * seria outro e o teste provaria a coisa errada.
 *
 * `/` é excluída de propósito: é uma montagem verdadeira, mas é também a
 * ascendente do diretório temporário do terceiro caso. Recusar `/` e permitir um
 * filho seu no mesmo teste deixaria as duas asserções a discutir o mesmo caminho.
 */
async function escolheMontagemExercitavel(baseDir) {
  const tabela = lerPontosDeMontagemReais();
  if (!tabela.ok || tabela.ilegiveis > 0) return null;
  for (const montagem of tabela.montagens) {
    if (montagem === "/" || montagem === process.execPath) continue;
    if (isProtectedQuarantinePath(montagem, { baseDir, execPath: process.execPath })) continue;
    if (!(await hasReparseFreePath(montagem))) continue;
    return montagem;
  }
  return null;
}

test("Linux: o motor recusa uma montagem real antes de a mover", { skip: process.platform === "win32" ? "a regra das montagens só existe fora de Windows" : false }, async (t) => {
  const { e, dir, eventos } = await motor(t);
  const montagem = await escolheMontagemExercitavel(dir);
  if (!montagem) {
    t.skip("nenhuma montagem da máquina é protegida apenas por esta regra — o caso não é exercitável aqui");
    return;
  }
  const antes = await fs.lstat(montagem);
  t.diagnostic(`montagem escolhida na máquina: ${montagem}`);

  // `TS private` não existe em runtime: chamamos o portão do motor, não o
  // `dispatch` do IPC, porque é aqui que a decisão de mover é tomada.
  const isolado = await e.requestQuarantine(analysisPara(montagem, path.basename(montagem), "a".repeat(64)), "manual");

  assert.equal(isolado.success, false, "um ponto de montagem nunca pode ser isolado");
  const falha = eventos.find((event) => event.type === "quarantine.failed");
  assert.ok(falha, "a recusa tem de ser publicada");
  assert.equal(falha.data.reason, "mount-point", `motivo esperado «mount-point», veio «${falha.data.reason}»`);
  assert.equal(falha.data.artifactPath, montagem);
  assert.equal(eventos.some((event) => event.type === "quarantine.requested"), false, "o pedido de quarentena nem deve ser anunciado");
  assert.equal(eventos.some((event) => event.type === "quarantine.added"), false);
  const depois = await fs.lstat(montagem);
  assert.equal(depois.ino, antes.ino, "nada se pode ter movido: a montagem está exatamente onde estava");
});

function resumeEventos(eventos) {
  return eventos.map((event) => `${event.type}(${event.data?.reason ?? "sem motivo"})`).join(", ") || "nenhum";
}

test("Linux: o motor recusa o próprio interpretador pelo motivo de sempre", async (t) => {
  const { e, eventos } = await motor(t);
  const antes = await fs.lstat(process.execPath);

  const isolado = await e.requestQuarantine(analysisPara(process.execPath, path.basename(process.execPath), "a".repeat(64)), "manual");

  assert.equal(isolado.success, false);
  assert.match(String(isolado.error), /caminho protegido/);
  const falha = eventos.find((event) => event.type === "quarantine.failed");
  assert.equal(falha.data.reason, "protected-path", "o motivo histórico de Windows não pode ter mudado de nome");
  assert.equal(falha.summary, `Isolamento recusado por caminho protegido: ${path.basename(process.execPath)}`);
  const depois = await fs.lstat(process.execPath);
  assert.equal(depois.ino, antes.ino, "o executável que corre o teste tem de continuar no sítio");
});

test("Linux: o motor isola mesmo um ficheiro descartável fora da raiz do serviço", async (t) => {
  const { e, eventos } = await motor(t);
  // O ficheiro NÃO pode estar dentro da raiz de dados do motor: `baseDir` é uma
  // raiz protegida, e um fixture lá dentro seria recusado por caminho protegido
  // — que é a resposta correcta do produto, mas não é o que este caso procura.
  const alvo = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cs-p3-quarantine-alvo-")), "fixture.txt");
  t.after(async () => {
    await fs.rm(path.dirname(alvo), { recursive: true, force: true });
  });
  await fs.writeFile(alvo, CONTEUDO_FIXTURE);
  const sha256 = crypto.createHash("sha256").update(CONTEUDO_FIXTURE).digest("hex");

  const isolado = await e.requestQuarantine(analysisPara(alvo, "fixture.txt", sha256), "manual");

  assert.equal(isolado.success, true, `o portão novo não pode ter desligado o isolamento; eventos: ${resumeEventos(eventos)}`);
  assert.equal(isolado.error, undefined, "um isolamento confirmado não transporta erro");
  assert.equal(eventos.some((event) => event.type === "quarantine.failed"), false, `eventos: ${resumeEventos(eventos)}`);
  const entrada = eventos.find((event) => event.type === "quarantine.added")?.data;
  assert.ok(entrada?.id, "o evento de sucesso transporta a entrada da quarentena");
  await assert.rejects(fs.stat(alvo), "o ficheiro deixou de estar no caminho original");
  assert.ok(await fs.stat(entrada.quarantinePath), "e passou a estar na quarentena");
});
