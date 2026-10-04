/**
 * P1-4 — CANCELAR ANTES DE O TRABALHO DE MOTORES EXISTIR.
 *
 * O contrato a provar: cancelar um scan ANTES de o trabalho de motores existir
 * não pode deixar nascer análise, prefetch nem clamscan, e o estado tem de ficar
 * terminal `cancelled`.
 *
 * ── PORQUÊ ESTE FICHEIRO FOI REESCRITO (o anterior era um falso-verde) ──
 *
 * A suite anterior construía `new ScanManager(engine, TMP)`. O construtor de
 * produção é `constructor(private engine: ScanEngine)` — não recebe baseDir
 * nenhum, e o segundo argumento era DESCARTADO em silêncio. E o `quick` resolve
 * os alvos por `resolvePathsForScan`, que devolve SEMPRE
 * Downloads/Desktop/Start Menu\Programs\Startup/Documents/`os.tmpdir()` do
 * utilizador (scan-manager.ts:767-776).
 *
 * MEDIDO com o harness antigo (probe-p14-vacuous + 3 ficheiros no tmpdir, SEM
 * cancelamento, motor dublê):
 *
 *    150 ms  status=running fase=gathering scanned=0   prefetched=0
 *    400 ms  status=running fase=scanning scanned=0   prefetched=0
 *   1000 ms  status=running fase=scanning scanned=676 prefetched=1
 *   3000 ms  status=completed              scanned=1031 prefetched=1
 *
 * Logo: a janela de 150 ms dos testes antigos terminava ANTES do `prefetch`.
 * `assert.deepEqual(calls.scanned, [])` e `deepEqual(calls.prefetched, [])` eram
 * verdadeiros por construção — passavam com o cancelamento completamente
 * inoperante. E os mesmos testes analisavam 1031 ficheiros REAIS do utilizador
 * (Downloads/Desktop/Documents) através do motor dublê, o que viola o requisito
 * de zero leitura de paths reais.
 *
 * ── A SEAM ──
 *
 * SEAM: a propriedade de instância `resolvePathsForScan`, mais um invólucro de
 * observação sobre `gatherFilesQuick`/`gatherFiles`.
 *
 * É a mesma técnica que o projecto já usa em produção testada —
 * `engine.runTaskkill = ...`, `engine.runAutoKill = ...`, `engine.logsDir = ...`,
 * `engine.queryCimProcesses = ...` (packages/service/test/kill-budget.test.js,
 * process-kill.test.js, auto-kill-guard.test.js). Propriedade de instância que
 * sombreia um método privado, valor por defeito = o método real. NÃO é um flag
 * de "estou em teste" espalhado pelo código, e NÃO exige uma linha de produção.
 *
 * Porque este método: `resolvePathsForScan` é o ÚNICO ponto do pipeline que
 * decide QUAIS paths são enumerados. Controlá-lo dá controlo total sem tocar a
 * decisão de gather, o filtro de risco, a fila do motor ou o cancelamento — que
 * são exactamente o que estes testes têm de medir. Nada de produto é
 * CONDICIONAL ao harness.
 *
 * Os três invariantes que a seam tem de satisfazer, todos verificados por
 * asserção dentro dos testes (não por comentário):
 *   1. a fixture é REALMENTE enumerada (P1-4-G + o `before()`);
 *   2. nenhum path do utilizador entra no scan (`resolverCalls` sem targetPath,
 *      e as raízes são o tmpdir isolado do teste);
 *   3. se a seam deixar de estar selada, a fixture não é visitada e o
 *      `before()`/G FALHAM — a suite não pode voltar a ser um falso-verde.
 *
 * ── SAFETY ──
 *
 * ZERO EICAR. ZERO clamscan. O motor é um dublê que só regista chamadas: nenhum
 * processo arranca. CYBERSAFE_REAL_CLAMSCAN e CYBERSAFE_EICAR_MANUAL não são
 * lidos por este ficheiro. Nada é escrito no runtime do utilizador. As únicas
 * escritas são em tmpdirs isolados, removidas no `after`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ScanManager } from "../dist/scan-manager.js";

/** Extensões de alto risco: o filtro do quick gather aceita-as sem depender de mtime. */
const FIXTURE_FILES = ["alfa.exe", "beta.dll", "gamma.js"];
const FIXTURE_CONTENTS = "ficheiro de fixture, conteudo inerte";

const createdDirs = [];
const USER_PATH_MARKERS = [
  "\\downloads", "\\desktop", "\\documents", "\\start menu", "\\appdata\\roaming",
];

function isUserPath(p) {
  const lower = String(p).toLowerCase();
  return USER_PATH_MARKERS.some((m) => lower.includes(m));
}

/** tmpdir isolado, fora de qualquer path do utilizador. */
async function makeFixture(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cs-p14-${label}-`));
  createdDirs.push(dir);
  for (const name of FIXTURE_FILES) {
    await fs.writeFile(path.join(dir, name), `${FIXTURE_CONTENTS}: ${name}\n`, "utf8");
  }
  return dir;
}

/**
 * Portão assíncrono: segura o pipeline no `await` da resolução de alvos.
 *
 * É o que torna "cancel ANTES do trabalho existir" DETERMINÍSTICO em vez de uma
 * corrida com um `sleep(150)`. O `runScanLoop` fica parado em
 * `await this.resolvePathsForScan(...)` (scan-manager.ts:243); o cancelamento
 * chega nesse intervalo; só depois o loop acorda e tenta avançar.
 */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timeout à espera de ${what} (${timeoutMs} ms)`);
}

/** Dublê: regista o que foi pedido. Nenhum motor real arranca. */
function recordingEngine(overrides = {}) {
  const calls = {
    aborted: [],
    scanned: [],
    prefetched: [],
    cleaned: [],
    progress: [],
  };
  return {
    calls,
    abortEngineWork: (id) => { calls.aborted.push(id); },
    emitScanProgress: (s) => {
      calls.progress.push({
        id: s.id,
        status: s.status,
        phase: s.phase,
        filesDiscovered: s.filesDiscovered,
        filesTotal: s.filesTotal,
        filesScanned: s.filesScanned,
      });
    },
    prefetchClamav: async (files, id) => {
      calls.prefetched.push({ id, files: files.length });
      return { spawned: false };
    },
    clearClamavPrefetch: (id) => { calls.cleaned.push(id); },
    isExcluded: () => false,
    listProcesses: async () => [],
    scanArtifact: async (f) => {
      calls.scanned.push(f);
      return { results: [], totalFiles: 0, riskScore: 0 };
    },
    ...overrides,
  };
}

/**
 * A SEAM. Sela as raízes do scan no tmpdir do teste e observa as visitas.
 *
 * `resolvePathsForScan` sombreado → as raízes são as do teste, nada mais.
 * `gatherFilesQuick`/`gatherFiles` sombreados apenas para REGISTAR a visita e
 * delegar na implementação real — a decisão de gather continua a ser a de
 * produção, e é por isso que o P1-4-G é uma prova e não uma tautologia.
 */
function sealRoots(mgr, { roots, gate: g }) {
  const seen = { resolverCalls: [], gatherVisits: [] };

  mgr.resolvePathsForScan = async (type, targetPath) => {
    seen.resolverCalls.push({ type, targetPath });
    if (g) await g.promise;
    return [...roots];
  };

  for (const method of ["gatherFilesQuick", "gatherFiles"]) {
    const original = mgr[method].bind(mgr);
    mgr[method] = async (...args) => {
      seen.gatherVisits.push({ method, dir: args[0] });
      return original(...args);
    };
  }

  return seen;
}

/** Harness sem portão: o pipeline avança sozinho. Para o canário e para o
 *  caminho de PRODUTO em que o motor erra a meio. */
async function harnessLive(label) {
  const fixture = await makeFixture(label);
  const engine = recordingEngine();
  const mgr = new ScanManager(engine);
  const seen = sealRoots(mgr, { roots: [fixture], gate: null });
  return { fixture, engine, mgr, seen };
}

/**
 * Harness de cancelamento: cancel DENTRO do portão, com o pipeline parado
 * antes de qualquer gather.
 */
async function harnessGated(label) {
  const live = await harnessLive(label);
  const { engine, mgr, seen } = live;
  const g = gate();

  // Re-sela com o portão (o `harnessLive` já tinha selado sem portão).
  const sealed = sealRoots(mgr, { roots: [live.fixture], gate: g });
  assert.equal(sealed.gatherVisits.length, 0, "nenhuma visita de gather antes do scan arrancar");

  const id = await mgr.startScan("quick");
  assert.ok(id, "o scan arranca");
  const emittedBeforeCancel = engine.calls.progress.length;

  // O trabalho de motores NÃO EXISTE ainda: o loop está parado no
  // `await this.resolvePathsForScan(...)`, antes de qualquer gather, prefetch
  // ou `scanArtifact`.
  assert.deepEqual(engine.calls.scanned, [], "antes do cancel não houve análise de ficheiros");
  assert.deepEqual(engine.calls.prefetched, [], "antes do cancel não houve prefetch");

  mgr.cancelScan(id);
  assert.equal(mgr.getScan(id)?.status, "cancelled", "o cancel é terminal à saída");

  // 3. depois do cancel, o pipeline tenta avançar.
  g.open();
  await waitFor(
    () => engine.calls.cleaned.includes(id),
    `o pipeline avançar para depois do cancel e limpar o prefetch (vistos: ${JSON.stringify(engine.calls.cleaned)})`,
  );

  return { ...live, id, seen: sealed, emittedBeforeCancel };
}

/**
 * O CANÁRIO. O mesmo harness, sem cancelamento, tem de chegar ao motor com
 * ficheiros da fixture.
 *
 * Corre em `before()` para que NENHUM teste deste ficheiro possa ser um
 * falso-verde: se a fixture não for alcançada, o `before()` rebenta e a suite
 * toda fica a vermelho. É a garantia de que `scanned === []` nos testes de
 * cancelamento significa "o cancelamento funcionou" e não "o pipeline nunca lá
 * chegou".
 */
async function controlReachesEngine(label) {
  const { fixture, engine, mgr, seen } = await harnessLive(label);

  const id = await mgr.startScan("quick");
  assert.ok(id, "[controle] o scan arranca");
  await waitFor(
    () => mgr.getScan(id)?.status === "completed",
    "[controle] o scan sem cancelamento a chegar a `completed`",
  );

  const discovered = Math.max(0, ...engine.calls.progress.map((p) => p.filesDiscovered ?? 0));
  const observation = {
    fixture,
    gatherVisits: seen.gatherVisits.length,
    discovered,
    scanned: engine.calls.scanned.length,
    prefetched: engine.calls.prefetched.length,
    status: mgr.getScan(id)?.status,
  };

  // A fixture foi REALMENTE enumerada, não apenas "chamada".
  assert.equal(seen.resolverCalls.length, 1, "[controle] o resolver selado foi chamado uma vez");
  assert.equal(seen.resolverCalls[0].type, "quick", "[controle] e com o tipo certo");
  assert.ok(
    seen.gatherVisits.some((v) => v.dir === fixture),
    `[controle] o gather tem de ser chamado sobre a fixture (visitas: ${JSON.stringify(seen.gatherVisits)})`,
  );
  assert.ok(discovered > 0, `[controle] o scan tem de DESCOBRIR ficheiros da fixture (descobertos: ${discovered})`);
  assert.ok(engine.calls.scanned.length > 0, "[controle] sem cancelamento o motor TEM de trabalhar");
  assert.ok(
    engine.calls.scanned.every((f) => f.startsWith(fixture)),
    `[controle] só a fixture pode chegar ao motor (vistos: ${JSON.stringify(engine.calls.scanned)})`,
  );
  assert.ok(engine.calls.prefetched.length > 0, "[controle] sem cancelamento o prefetch TEM de nascer");
  assert.equal(observation.status, "completed");

  return observation;
}

describe("P1-4 — cancelar antes de o trabalho de motores nascer", () => {
  let control = null;

  before(async () => {
    // Se isto rebentar, a suite toda falha — que é o comportamento pretendido.
    control = await controlReachesEngine("control");
  });

  after(async () => {
    for (const dir of createdDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  /** A enumeração entrou pelas raízes seladas, e só por elas. */
  function assertSealed(seen) {
    assert.equal(
      seen.resolverCalls.length, 1,
      `a resolução de alvos tem de correr uma vez, pelas raízes seladas (vistas: ${JSON.stringify(seen.resolverCalls)})`,
    );
    assert.equal(seen.resolverCalls[0].type, "quick");
    assert.equal(
      seen.resolverCalls[0].targetPath, undefined,
      "nenhum path do utilizador entra no scan: as raízes são as do tmpdir isolado",
    );
    assert.ok(
      seen.gatherVisits.every((v) => !isUserPath(v.dir)),
      `nenhum path do utilizador pode ser enumerado (visitas: ${JSON.stringify(seen.gatherVisits)})`,
    );
  }

  it("P1-4-A — cancel antes de o controller existir deixa o estado terminal `cancelled`", async () => {
    const { engine, mgr, id, seen, emittedBeforeCancel } = await harnessGated("a");

    assertSealed(seen);
    assert.equal(
      mgr.getScan(id)?.status, "cancelled",
      `o estado final tem de ser cancelled (obtido: ${mgr.getScan(id)?.status})`,
    );
    assert.ok(mgr.getScan(id)?.endTime, "um cancelado sem hora de fim não é um cancelado");

    // O `running/preparing` publicado ANTES do cancel é honesto — o scan
    // chegou mesmo a arrancar. O que não pode é haver DEPOIS do cancel.
    const depois = engine.calls.progress.slice(emittedBeforeCancel).filter((p) => p.id === id);
    const naoTerminais = depois.filter((p) => p.status !== "cancelled");
    assert.deepEqual(
      naoTerminais, [],
      `depois do cancel nada pode voltar a running/queued (vistos: ${JSON.stringify(naoTerminais)})`,
    );
    assert.equal(
      depois.filter((p) => p.status === "cancelled").length, 1,
      "e o estado `cancelled` publica-se uma vez só",
    );
  });

  it("P1-4-B — depois do cancel o gathering termina e o scan não reentra em running/scanning", async () => {
    const { engine, mgr, id, seen, emittedBeforeCancel } = await harnessGated("b");

    assertSealed(seen);
    assert.equal(mgr.getScan(id)?.status, "cancelled");

    const todas = engine.calls.progress.filter((p) => p.id === id);
    const fases = todas
      .slice(emittedBeforeCancel)
      .map((p) => `${p.status}/${p.phase}`);
    assert.deepEqual(
      fases.filter((f) => !f.startsWith("cancelled/")),
      [],
      `nenhuma fase de trabalho pode ser publicada depois do cancel (vistas: ${JSON.stringify(fases)})`,
    );
    // Cancelar antes de o controller existir significa que o pipeline NUNCA
    // entrou na fase de análise: `scanning` não pode ter sido publicada nem
    // antes (o scan nem gathered) nem depois.
    assert.ok(
      !todas.some((p) => p.phase === "scanning"),
      `o scan não pode entrar na fase de analise (publicadas: ${JSON.stringify(todas.map((p) => `${p.status}/${p.phase}`))})`,
    );
    assert.ok(
      mgr.getScan(id)?.phase !== "scanning",
      `a fase final não pode ser \`scanning\` (obtida: ${mgr.getScan(id)?.phase})`,
    );
    assert.equal(
      engine.calls.cleaned.filter((x) => x === id).length, 1,
      "o pipeline foi até ao fim e largou o prefetch uma vez",
    );
  });

  it("P1-4-C — depois do cancel nenhum prefetch começa", async () => {
    const { engine, id, seen } = await harnessGated("c");

    assertSealed(seen);
    assert.deepEqual(
      engine.calls.prefetched, [],
      `nenhum clamscan pode nascer depois de um cancel antes do controller (prefetches: ${engine.calls.prefetched.length})`,
    );
    assert.ok(id, "sanidade: o scan existia");
  });

  it("P1-4-D — depois do cancel nenhum scan de motor começa", async () => {
    const { engine, id, seen } = await harnessGated("d");

    assertSealed(seen);
    assert.deepEqual(
      engine.calls.scanned, [],
      `nenhum ficheiro pode ser analisado depois de um cancel antes do controller (analisados: ${engine.calls.scanned.length})`,
    );
    assert.ok(id, "sanidade: o scan existia");
  });

  it("P1-4-E — cancel repetido é idempotente: um aborto, um estado, um fim", async () => {
    const { engine, mgr, id, seen, emittedBeforeCancel } = await harnessGated("e");

    // Três pedidos de cancel sobre o MESMO scan, já terminal.
    mgr.cancelScan(id);
    mgr.cancelScan(id);
    mgr.cancelScan(id);

    assertSealed(seen);
    assert.equal(
      engine.calls.aborted.filter((a) => a === id).length, 1,
      `o motor aborta uma vez só, mesmo com três pedidos (abortos: ${engine.calls.aborted.length})`,
    );
    assert.equal(
      engine.calls.progress
        .slice(emittedBeforeCancel)
        .filter((p) => p.id === id && p.status === "cancelled").length,
      1,
      "e o estado `cancelled` publica-se uma vez só: três pedidos não são três eventos",
    );
    assert.equal(mgr.getScan(id)?.status, "cancelled", "o estado final continua `cancelled`");
    assert.deepEqual(engine.calls.scanned, [], "e continua a não haver análise");
    assert.deepEqual(engine.calls.prefetched, [], "nem prefetch");
  });

  it("P1-4-F — um callback tardio depois do cancel não altera o estado terminal", async () => {
    // Este teste está VERMELHO de propósito: é INFORMAÇÃO sobre um bug de
    // produto, não uma falha de harness. Duas vias para o mesmo defeito, e as
    // duas são recolhidas antes de as asserções falharem.
    const violacoes = [];

    // ── VIA 1: o `updateScan` interno a tentar reescrever o terminal ────────
    const tardio = await harnessGated("f-update");
    const antes = tardio.engine.calls.progress.length;
    tardio.mgr.updateScan(tardio.id, { status: "running", progress: 50, filesScanned: 99 });
    tardio.mgr.updateScan(tardio.id, { phase: "scanning", filesScanned: 42, filesAnalyzed: 42 });
    tardio.mgr.updateScan(tardio.id, { status: "completed", progress: 100 });

    const estado1 = tardio.mgr.getScan(tardio.id)?.status;
    if (estado1 !== "cancelled") {
      violacoes.push(`updateScan tardio trocou o terminal: esperado "cancelled", obtido "${estado1}"`);
    }
    if (tardio.engine.calls.progress.length !== antes) {
      violacoes.push(
        `updateScan tardio publicou ${tardio.engine.calls.progress.length - antes} snapshot(s): ${JSON.stringify(tardio.engine.calls.progress.slice(antes))}`,
      );
    }

    // ── VIA 2: o MESMO defeito por um caminho de PRODUTO ────────────────────
    // `prefetchClamav` rejeita DEPOIS do cancel → o `catch` exterior de
    // `runScanLoop` (scan-manager.ts:467-474) escreve `status: "failed"` por
    // cima do `cancelled`. Sem nenhum método privado tocado: isto é o que o
    // utilizador vê quando cancela a meio e o clamscan falha a fechar.
    const live = await harnessLive("f-engine");
    let rejeitarPrefetch;
    live.engine.prefetchClamav = (files, id) => {
      live.engine.calls.prefetched.push({ id, files: files.length });
      return new Promise((_res, rej) => { rejeitarPrefetch = rej; });
    };

    const idLive = await live.mgr.startScan("quick");
    await waitFor(() => rejeitarPrefetch !== undefined, "o prefetch entrar em voo");
    live.mgr.cancelScan(idLive);
    const antesDoErro = live.mgr.getScan(idLive)?.status;
    rejeitarPrefetch(new Error("clamscan indisponivel"));
    await waitFor(
      () => live.engine.calls.cleaned.includes(idLive),
      "o pipeline terminar depois do erro tardio",
    );

    const estado2 = live.mgr.getScan(idLive)?.status;
    if (estado2 !== "cancelled") {
      violacoes.push(
        `erro de motor tardio trocou o terminal: cancelado estava "${antesDoErro}", `
        + `estado final "${estado2}" (publicações: ${JSON.stringify(live.engine.calls.progress.map((p) => `${p.status}/${p.phase}`))})`,
      );
    }

    assert.deepEqual(
      violacoes, [],
      `um estado terminal tem de ser intocável:\n  - ${violacoes.join("\n  - ")}`,
    );
  });

  it("P1-4-G — a fixture foi REALMENTE enumerada (o canário que torna os outros honestos)", async () => {
    // Se este teste passa, o harness chegou à janela em que o defeito se
    // manifesta. Se a fixture deixar de ser visitada, ele FALHA — e o `before()`
    // leva a suite toda com ele.
    assert.ok(control, "o `before()` tem de ter corrido o controlo");
    assert.ok(control.gatherVisits > 0, `o gather tem de ter visitado a fixture (visitas: ${control.gatherVisits})`);
    assert.ok(control.discovered > 0, `o scan tem de descobrir ficheiros da fixture (descobertos: ${control.discovered})`);
    assert.equal(control.scanned, FIXTURE_FILES.length, `e o motor tem de analisar a fixture inteira (analisados: ${control.scanned})`);
    assert.equal(control.prefetched, 1, `e o prefetch tem de nascer uma vez sem cancelamento (prefetches: ${control.prefetched})`);
    assert.equal(control.status, "completed", "sem cancelamento o scan completa");

    // O outro lado da moeda: com as MESMAS raízes seladas, o cancelamento acima
    // provou que nada nasce. Comparar as duas metades é o que dá sentido a
    // `scanned === []`.
    const cancelado = await harnessGated("g-cancelado");
    assertSealed(cancelado.seen);
    assert.deepEqual(cancelado.engine.calls.scanned, [], "com a mesma fixture selada e cancel, zero análise");
    assert.deepEqual(cancelado.engine.calls.prefetched, [], "e zero prefetch");
    assert.equal(
      cancelado.engine.calls.cleaned.filter((x) => x === cancelado.id).length, 1,
      "o pipeline avançou e limpou o prefetch uma vez",
    );
  });
});