import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClamDatabaseGate } from "../dist/clam-database-gate.js";
import { DefinitionUpdater } from "../dist/updater.js";

/**
 * O gate da base de assinaturas com o UPDATER REAL e o GATE REAL.
 *
 * Porque este ficheiro existe: os testes do `ClamDatabaseGate` que já cá estavam
 * cobriam o gate com duplos, e o `checkAndUpdate` nunca corria contra um gate de
 * verdade. O requisito do produto — «um scan em curso não pode ver a base trocada
 * a meio, e o update não pode matar o scan» — só se prova com as duas peças reais
 * a falar uma com a outra.
 *
 * UM gate para todo o ficheiro, porque é assim no serviço: um gate por processo.
 * Descoberta feita a medir ao escrever nisto: o estado do gate não vive no objeto,
 * vive num ambito **à escala do módulo** (`src/clam-database-gate.ts:207`). Quatro
 * instâncias num ficheiro de testes seriam quatro vistas do MESMO estado, e o
 * primeiro caso a não libertar uma lease envenenava os seguintes (passavam
 * isolados, falhavam em conjunto). `reset()` não é «limpar para o próximo caso»: é
 * o encerramento — acorda a drenagem como «não drenada» e fecha a admissão. Por
 * isso cada caso abaixo devolve o que pediu dentro do próprio corpo.
 */

const ORÇAMENTO_DRENAGEM_MS = 120;
const MARCADOR = "BASE-QUE-NAO-PODE-SER-TOCADA";
const GATE = new ClamDatabaseGate({ drainBudgetMs: ORÇAMENTO_DRENAGEM_MS });

function pastaTemporaria(t) {
  const defs = fs.mkdtempSync(path.join(os.tmpdir(), "cs-gate-real-"));
  fs.mkdirSync(path.join(defs, "clamav"), { recursive: true });
  fs.writeFileSync(path.join(defs, "clamav", "main.cvd"), MARCADOR, "utf8");
  t.after(() => fs.rmSync(defs, { recursive: true, force: true }));
  return defs;
}

function updaterComGate(defs, spawnCalls) {
  const child = () => {
    spawnCalls.push(true);
    const c = new EventEmitter();
    c.pid = 42000 + spawnCalls.length;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    setTimeout(() => c.emit("close", 0, null), 5);
    return c;
  };
  const updater = new DefinitionUpdater(defs, { spawnFreshclam: child, gate: GATE });
  updater.updateYaraRules = async () => ({ errors: [], warnings: [] });
  updater.updateHashFeed = async () => ({ alterou: false, novos: 0, total: 0, rejeitados: 0, lacunaCobertura: false });
  return updater;
}

test("scan com lease activa: o freshclam não nasce, a base fica intacta e a causa vem no resultado", async (t) => {
  const defs = pastaTemporaria(t);
  const spawnCalls = [];
  const updater = updaterComGate(defs, spawnCalls);

  const tentativa = GATE.tryAcquireScanLease();
  assert.equal(tentativa.ok, true, "sem update pedido, o scan entra");

  try {
    const resultado = await updater.checkAndUpdate(true);

    assert.equal(resultado.clamUpdated, false, "com scan em curso a base não pode ser dada como atualizada");
    assert.equal(spawnCalls.length, 0, "o freshclam NÃO pode nascer enquanto há uma lease de scan");
    assert.equal(
      fs.readFileSync(path.join(defs, "clamav", "main.cvd"), "utf8"),
      MARCADOR,
      "a base em disco tem de estar byte-a-byte como estava",
    );
    assert.ok(
      (resultado.errors ?? []).some((e) => e.startsWith("ClamAV:") && /scans ClamAV activos/i.test(e)),
      `a causa tem de vir no resultado, recebido: ${JSON.stringify(resultado.errors)}`,
    );
  } finally {
    tentativa.lease.release();
  }
});

test("sem lease nenhuma, um ciclo normal troca a base", async (t) => {
  const defs = pastaTemporaria(t);
  const spawnCalls = [];
  const updater = updaterComGate(defs, spawnCalls);

  const resultado = await updater.checkAndUpdate(true);

  assert.equal(spawnCalls.length, 1, "o gate vazio não é obstáculo");
  assert.equal(resultado.clamUpdated, true);
});

test("a posse de um update fecha a admissão de scans novos, e devolvê-la reabre", async (t) => {
  const defs = pastaTemporaria(t);
  void defs;
  const posse = await GATE.beginUpdateComMotivo();
  assert.equal(posse.lease?.valid, true, "sem scans em curso, o update adquire a posse");

  try {
    const negada = GATE.tryAcquireScanLease();
    assert.equal(negada.ok, false, "um scan novo não pode entrar sobre uma troca declarada");
    assert.ok(["update-pending", "update-active"].includes(negada.reason), `razão recebida: ${negada.reason}`);
  } finally {
    posse.lease.release();
  }

  const reaberta = GATE.tryAcquireScanLease();
  assert.equal(reaberta.ok, true, "devolvida a posse, a admissão volta");
  reaberta.lease.release();
});

test("libertada a lease do scan, o mesmo ciclo escreve: recusa é janela, não congelamento", async (t) => {
  const defs = pastaTemporaria(t);
  const spawnCalls = [];
  const updater = updaterComGate(defs, spawnCalls);

  const scan = GATE.tryAcquireScanLease();
  assert.equal(scan.ok, true);
  try {
    const recusado = await updater.checkAndUpdate(true);
    assert.equal(recusado.clamUpdated, false);
    assert.equal(spawnCalls.length, 0);
  } finally {
    scan.lease.release();
  }

  const segunda = await updater.checkAndUpdate(true);
  assert.equal(spawnCalls.length, 1, "sem scans em curso o freshclam tem de nascer");
  assert.equal(segunda.clamUpdated, true, "e a troca tem de ser dada como feita, com prova");
});
