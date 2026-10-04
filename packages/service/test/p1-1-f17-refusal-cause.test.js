/**
 * P1-1 — FINDING 17: A CAUSA DO ADIAMENTO TEM DE SER A VERDADE.
 *
 * O contrato que esta classe de testes existe para fechar: quando um update é
 * ADIADO, a causa que o updater escreve tem de descrever o que aconteceu. Uma
 * causa falsa não é um detalhe de texto — o painel diz ao utilizador que ha
 * "scans ClamAV activos que nao drenaram" quando nao ha scan nenhum, e isso
 * aponta o diagnostico para o sitio errado.
 *
 * ── O BUG (CODEX, 10a ronda, finding 17) ──
 *
 * Em `beginUpdateComMotivo`, no bloco de recusa logo apos `this.discard(req)`,
 * a causa era escolhida assim:
 *
 *   amb.owner === req || amb.escritoresSemProvaDeMorte.size > 0
 *     ? "outro-escritor" : "busy-scans"
 *
 * `amb.owner === req` e um RAMO MORTO: `acquireOwnership` so devolve `true`
 * quando promove o PROPRIO pedido a dono, portanto neste ponto e sempre falso.
 * Sobrava `escritoresSemProvaDeMorte.size > 0`, e esse registo so recebe
 * marcadores no `markWriting` — ou seja, um dono que ainda esta a preparar a
 * config NAO esta nele. Resultado: duas situacoes em que o orcamento expira a
 * espera de OUTRO escritor caiam em "busy-scans" com `activeScans === 0`.
 *
 * MEDIDO (output/manual-retest/f17-probe.mjs, ANTES):
 *   caso A (updates concorrentes + reset()): uma das mensagens era
 *           "ha scans ClamAV activos que nao drenaram dentro do orcamento (25 ms)"
 *           com activeScans = 0.
 *   caso B (fila expirada, dono sem markWriting): reason = busy-scans,
 *           activeScans = 0, owner vivo.
 *
 * ── O QUE ESTES TESTES PROVAM ──
 *
 * Atravessam o codigo de PRODUCAO: o `ClamDatabaseGate` real e o
 * `DefinitionUpdater` real (que traduz a causa na frase que o utilizador lê).
 * A logica de classificacao nao e reimplementada aqui — e o `spawnFreshclam` de
 * teste LANCA se for chamado, porque num adiamento nenhum freshclam pode nascer.
 *
 * O âmbito e de PROCESSO, por isso `reiniciarAmbitoDeTeste()` dá a cada teste um
 * âmbito limpo: sem isso, um scan ou um escritor vivo num teste contamina os
 * seguintes e a suite mede lixo.
 *
 * ZERO rede. ZERO freshclam real. ZERO clamscan real. ZERO escrita fora do
 * tmpdir isolado do ficheiro (e um adiamento nem sequer chega a escrever).
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ClamDatabaseGate, reiniciarAmbitoDeTeste } from "../dist/clam-database-gate.js";
import { DefinitionUpdater } from "../dist/updater.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "cs-p11-f17-"));
const ORCAMENTO = 25;

/** A frase que o UTILIZADOR lê. Vem do updater de produção. */
const FRASES = {
  "busy-scans": /ha scans ClamAV activos que nao drenaram/,
  "outro-escritor": /ja ha outra actualizacao de assinaturas em curso/,
};
/**
 * As duas frases de encerramento que o updater real pode escrever: a do
 * adiamento (`descreverAdiamento`, updater.ts:59) e a da posse já concedida e
 * entretanto invalidada (updater.ts:409). As duas dizem a mesma coisa — o
 * serviço está a encerrar — em momentos diferentes do caminho.
 */
const ENCERRAR = /o servico (de proteccao )?esta a encerrar/;

function gate() {
  return new ClamDatabaseGate({ drainBudgetMs: ORCAMENTO });
}

/** `spawnFreshclam` de teste: um adiamento NUNCA pode chegar a um spawn. */
function spawnQueLanca() {
  return () => {
    throw new Error("SPAWN INESPERADO: um update adiado nao pode fazer nascer freshclam");
  };
}

function updater(definitionsDir, g) {
  return new DefinitionUpdater(definitionsDir, { gate: g, spawnFreshclam: spawnQueLanca() });
}

/**
 * Corre um `updateClamAV` REAL e devolve a frase com que RECUSOU.
 *
 * MEDIDO: o updater não devolve a frase em `errors` — recusa a promise com ela
 * (`reject(new Error(descreverAdiamento(...)))`, updater.ts:400). Se um update
 * completar, o `spawnQueLanca` rebenta ou o freshclam nasceu, e o teste tem de
 * falhar em vez de dar um veredicto vazio.
 */
async function fraseDeAdiamentoDoUpdater(u) {
  try {
    await u.updateClamAV();
  } catch (e) {
    assert.ok(
      e instanceof Error && typeof e.message === "string" && e.message.length > 0,
      `a recusa tem de ser um Error com mensagem (obtido: ${String(e)})`,
    );
    return e.message;
  }
  assert.fail("o update devia ter sido ADIADO (recusado), não completado");
}

/** Que causa é que ESTA frase descreve? */
function causaDaFrase(frase) {
  if (FRASES["busy-scans"].test(frase)) return "busy-scans";
  if (FRASES["outro-escritor"].test(frase)) return "outro-escritor";
  if (ENCERRAR.test(frase)) return "servico-a-encerrar";
  assert.fail(`frase de adiamento que não corresponde a nenhuma causa conhecida: "${frase}"`);
}

/** Motivo estruturado, pelo caminho do gate. */
async function motivo(g) {
  const r = await g.beginUpdateComMotivo();
  assert.equal(r.lease, null, "o motivo só faz sentido quando não há posse");
  assert.ok(r.refusal?.refused, `esperava uma recusa (obtido: ${JSON.stringify(r.refusal)})`);
  return r.refusal.reason;
}

describe("P1-1 F17 — a causa do adiamento é a causa real", () => {
  beforeEach(() => {
    reiniciarAmbitoDeTeste();
  });

  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  });

  it("F17-A — adiamento com activeScans=0 por outro escritor NUNCA é busy-scans", async () => {
    const g = gate();

    // Um escritor VIVO que segura a vez e ainda não declarou escrita: o
    // `markWriting` é o que põe o marcador no registo de processo, e este dono
    // ainda não passou por lá. Este é o caso que a classificação antiga
    // classificava como "busy-scans".
    const dono = await g.beginUpdate();
    assert.ok(dono, "o primeiro pedido tem de ficar com a posse");
    assert.equal(g.state.activeScans, 0, "não há scans vivos: é este o dado que torna a causa busy-scans falsa");

    const recusa = await motivo(g);

    assert.equal(
      recusa, "outro-escritor",
      `activeScans=0 e o orçamento a expirar à espera de um dono vivo: a causa é outro-escritor (obtido: "${recusa}")`,
    );
    assert.notEqual(recusa, "busy-scans", "e nunca busy-scans: não há scan nenhum para drenar");
    assert.ok(dono.valid, "e o dono continua válido: o adiamento do outro não lhe tirou a vez");

    dono.release();
  });

  it("F17-B — com leases de scan vivas e orçamento expirado a causa é busy-scans", async () => {
    const g = gate();

    const tentativa = g.tryAcquireScanLease();
    assert.equal(tentativa.ok, true, `a lease devia ser concedida (obtido: ${tentativa.reason})`);
    assert.equal(g.state.activeScans, 1, "há um scan vivo: é o que torna busy-scans a causa verdadeira");

    const recusa = await motivo(g);

    assert.equal(
      recusa, "busy-scans",
      `com ${g.state.activeScans} scan(s) vivo(s) e o orçamento expirado, a causa é busy-scans (obtido: "${recusa}")`,
    );
    tentativa.lease.release();
  });

  it("F17-C — disposed dá servico-a-encerrar, nunca busy-scans", async () => {
    const g = gate();
    g.reset();

    const recusa = await motivo(g);

    assert.equal(
      recusa, "servico-a-encerrar",
      `depois de reset() a causa é que o serviço está a encerrar (obtido: "${recusa}")`,
    );
    assert.notEqual(recusa, "busy-scans", "e nunca busy-scans: ninguém está a usar a base");
  });

  it("F17-D — dois updates concorrentes em gates distintos + reset(): a causa certa para cada um", async () => {
    // Reproduz o caso A do probe. DOIS DefinitionUpdater REAIS, cada um com o seu
    // gate, sobre o mesmo âmbito de processo — que é a coordenação real, e o que
    // torna este teste diferente de testar o gate sozinho.
    const dirA = path.join(TMP, "D-a");
    const dirB = path.join(TMP, "D-b");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    const gA = gate();
    const gB = gate();
    const uA = updater(dirA, gA);
    const uB = updater(dirB, gB);

const emVooA = fraseDeAdiamentoDoUpdater(uA);
    const emVooB = fraseDeAdiamentoDoUpdater(uB);

    gA.reset();

    const [fraseA, fraseB] = await Promise.all([emVooA, emVooB]);

    assert.equal(gA.state.activeScans, 0, `o bug era anunciar scans com activeScans=0 (obtido: ${gA.state.activeScans})`);

    for (const [nome, frase] of [["A", fraseA], ["B", fraseB]]) {
      const causa = causaDaFrase(frase);
      assert.equal(
        causa, "servico-a-encerrar",
        `após reset() o serviço ESTÁ a encerrar: o update ${nome} não pode dizer outra coisa (frase: "${frase}")`,
      );
      assert.doesNotMatch(
        frase, FRASES["busy-scans"],
        `o update ${nome} anunciou scans ClamAV activos com activeScans=0 — é o finding 17 (frase: "${frase}")`,
      );
    }
  });

  it("F17-E — dono na fila sem markWriting e activeScans=0: nunca busy-scans, e a fila continua ordenada", async () => {
    const g = gate();

    // O dono segura a vez. Nenhum dos pedidos seguintes passa por `markWriting`.
    const dono = await g.beginUpdate();
    assert.ok(dono, "o primeiro pedido tem de ficar com a posse");
    assert.equal(dono.valid, true, "e a posse é válida antes do markWriting");

    // Três pedidos em fila, um atrás do outro. Todos expiram o orçamento a
    // espera do mesmo dono.
    const recusas = [];
    for (let i = 0; i < 3; i++) {
      recusas.push(await motivo(g));
    }

    for (const [i, r] of recusas.entries()) {
      assert.equal(
        r, "outro-escritor",
        `o pedido ${i} esperou um dono vivo sem markWriting, com activeScans=0: a causa é outro-escritor (obtido: "${r}")`,
      );
    }

    assert.equal(g.state.activeScans, 0, "nenhum scan foi criado: a causa busy-scans nunca teve base");
    assert.equal(g.state.updateWaiters, 0, "e a fila ficou limpa: cada pedido descartado só mexe em si próprio");
    assert.equal(dono.valid, true, "o dono sobreviveu aos três adiamentos");
    assert.equal(g.state.updateActive, false, "e continua a NÃO estar a escrever: sem markWriting não há freshclam");

    dono.release();
  });

  it("F17-F — a CAUSA traduzida nunca vira a frase dos scans quando não há scans (updater real, via do gate)", async () => {
    // Fecha o contrato pelo lado do utilizador: o que o painel mostra é a frase
    // do updater, e ela tem de concordar com o motivo estruturado.
    const dir = path.join(TMP, "F");
    await fs.mkdir(dir, { recursive: true });
    const g = gate();
    const u = updater(dir, g);

    const dono = await g.beginUpdate();
    assert.equal(g.state.activeScans, 0, "premissa: zero scans vivos");

    const frase = await fraseDeAdiamentoDoUpdater(u);

    assert.equal(
      causaDaFrase(frase), "outro-escritor",
      `havia um dono vivo e zero scans: o painel não pode dizer "ha scans activos" (frase: "${frase}")`,
    );
    assert.doesNotMatch(frase, FRASES["busy-scans"], "a frase dos scans não pode aparecer neste caminho");
    assert.equal(dono.valid, true, "o dono continua com a posse: o adiamento não lhe tirou a vez");
    assert.equal(g.state.updateActive, false, "e nenhum freshclam nasceu: `updateActive` é falso");

    dono.release();
  });
});