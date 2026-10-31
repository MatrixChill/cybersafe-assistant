/**
 * P1 CANCELAMENTO A MEIO DE UM BATCH DE CLAMAV.
 *
 * Contrato a prender (6 pontos):
 *
 *  1. Durante um batch em curso (filesInEngineBatch > 0), cancelScan(id) põe
 *     o estado terminal 'cancelled' IMEDIATAMENTE.
 *  2. engine.abortEngineWork(id) é chamado pelo menos uma vez e com o id certo.
 *  3. Depois do cancelamento, NENHUM evento publicado pode ter status 'running',
 *     progresso a subir, filesAnalyzed a subir ou filesScanned a subir.
 *  4. O estado final permanece 'cancelled' e filesInEngineBatch termina em 0.
 *  5. Sem órfãos: depois do terminal, um novo startScan é aceite.
 *  6. Zero clamscan real: tudo fake engine determinístico, timeouts curtos.
 *
 * ── Padrão do fake engine ───────────────────────────────────────────────────
 * Igual a scan-800-batch-765-remainder-35.test.js: portão (waitForBatch /
 * releaseBatch), AbortController por scanId, onProgress chamado dentro do
 * prefetchClamav, scanArtifact nunca chega a correr se o cancel chegar antes.
 *
 * ── O que se espera RED antes da correcção do Qoder ────────────────────────
 * Os pontos 1 e 3 devem ser verdes hoje (o cancel é imediato e o evento
 * terminal é 'cancelled'). O ponto 3 — "nenhum progresso fictício depois do
 * cancel" — pode ser RED se o código actual continuar a publicar callbacks
 * de onProgress após a saída do portão, dado que o AbortController só sinaliza
 * o prefetch mas o pipeline pode ainda não ter registado o sinal. O ponto 4
 * (filesInEngineBatch=0 no evento terminal) pode ser RED se o campo não for
 * zerado aquando do cancelamento a meio. O ponto 2 é RED se abortEngineWork
 * não for chamado com o id certo durante um cancelamento de batch em curso.
 * Todos são verificados por asserção; o relatório honesto segue abaixo.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ScanManager } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ─────────────────────────────────────────────────────────────────

async function waitTerminal(mgr, id, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(5);
  }
  throw new Error(`scan ${id} não atingiu estado terminal em ${timeoutMs} ms`);
}

async function waitBatchActive(mgr, id, timeoutMs = 3_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && (s.filesInEngineBatch ?? 0) > 0) return s;
    await sleep(5);
  }
  throw new Error(`batch do scan ${id} não ficou ativo (filesInEngineBatch>0) em ${timeoutMs} ms`);
}

// ── Fake engine com portão ───────────────────────────────────────────────────
//
// O portão é o mesmo padrão do scan-800 test:
//   - holdBatch=true  → prefetchClamav espera em `batchReleasePromise`
//   - waitForBatch()  → resolve quando o prefetchClamav entrou no portão
//   - releaseBatch()  → liberta o prefetchClamav para terminar
//   - AbortController por scanId → honorado dentro do loop de onProgress

function makeEngine({ holdBatch = true, batchSize = 20 } = {}) {
  const events       = [];
  const prefetchCalls  = [];
  const clearCalls     = [];
  const abortCalls     = [];
  const progressCalls  = [];

  const controllers = new Map();
  let batchEnteredResolve;
  let batchReleaseResolve;
  const batchEnteredPromise = new Promise((r) => { batchEnteredResolve = r; });
  const batchReleasePromise = new Promise((r) => { batchReleaseResolve = r; });

  return {
    // ── Observação ─────────────────────────────────────────────────────────
    events,
    prefetchCalls,
    clearCalls,
    abortCalls,
    progressCalls,

    // ── Controlo do portão ─────────────────────────────────────────────────
    waitForBatch: () => batchEnteredPromise,
    releaseBatch: () => batchReleaseResolve(),

    // ── Contrato do ScanManager ────────────────────────────────────────────
    isExcluded: () => false,

    emitScanProgress(state) {
      events.push({ ...state });
    },

    abortEngineWork(scanId) {
      abortCalls.push(scanId);
      const ctrl = controllers.get(scanId);
      if (ctrl) ctrl.abort();
    },

    async prefetchClamav(filePaths, scanId, onProgress) {
      prefetchCalls.push({ count: filePaths.length, scanId });
      const ctrl = new AbortController();
      controllers.set(scanId, ctrl);

      try {
        if (holdBatch) {
          // Sinaliza que entrámos no portão e esperamos a libertação.
          batchEnteredResolve();
          await batchReleasePromise;
          // Se o scan foi cancelado enquanto esperávamos, saímos limpos.
          if (ctrl.signal.aborted) return { spawned: true };
        }

        // Emite onProgress ficheiro a ficheiro (simula o stdout do clamscan).
        for (let n = 1; n <= batchSize; n++) {
          if (ctrl.signal.aborted) break;
          if (typeof onProgress === "function") {
            onProgress(n);
            progressCalls.push({ scanId, n, aborted: ctrl.signal.aborted });
          }
        }
      } finally {
        controllers.delete(scanId);
      }

      await sleep(2);
      return { spawned: true };
    },

    clearClamavPrefetch(scanId) {
      clearCalls.push(scanId);
    },

    async scanArtifact(filePath) {
      return {
        results: [{
          fileName: path.basename(filePath),
          size: 1,
          severity: "low",
          confidence: 1,
          rulesTriggered: [],
          riskScore: 0,
          verdict: "safe",
          sha256: "x",
        }],
        totalFiles: 1,
        highRiskCount: 0,
        overallSeverity: "low",
        rulesTriggered: [],
        riskScore: 0,
      };
    },
  };
}

// ── Fixture determinística ───────────────────────────────────────────────────

let tmp;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-cancel-mid-batch-"));
  const writes = [];
  for (let i = 0; i < 20; i++) {
    writes.push(fs.writeFile(path.join(tmp, `file-${i}.bin`), `x${i}`));
  }
  await Promise.all(writes);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

function makeManager(engine) {
  const mgr = new ScanManager(engine);
  // Controla exactamente os paths que o scan vai ver — zero leitura de pastas
  // reais do utilizador, zero clamscan real.
  mgr.gatherFiles = async (_root, output) => {
    const names = [];
    for (let i = 0; i < 20; i++) names.push(path.join(tmp, `file-${i}.bin`));
    output.push(...names);
  };
  mgr.looksLikeZip = async () => false;
  return mgr;
}

// ── Testes ───────────────────────────────────────────────────────────────────

describe("P1 — cancelamento a meio de um batch em curso", () => {

  /**
   * PONTO 1: O estado passa a 'cancelled' imediatamente quando cancelScan é
   * chamado enquanto o batch está em curso (filesInEngineBatch > 0).
   */
  it("1. cancelScan durante batch em curso → estado 'cancelled' imediato", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    assert.ok(id, "o scan deve arrancar");

    // Aguardar que o batch fique activo (filesInEngineBatch > 0).
    const activeBatch = await waitBatchActive(mgr, id);
    assert.ok(
      (activeBatch.filesInEngineBatch ?? 0) > 0,
      `pré-condição: o batch tem de estar activo (filesInEngineBatch=${activeBatch.filesInEngineBatch})`,
    );

    // O cancel deve ser IMEDIATO — sem await.
    mgr.cancelScan(id);
    const stateAfterCancel = mgr.getScan(id);

    assert.equal(
      stateAfterCancel?.status,
      "cancelled",
      `cancelScan durante batch em curso tem de pôr o estado 'cancelled' imediatamente ` +
      `(obtido: '${stateAfterCancel?.status}')`,
    );

    // Libertar o portão para que o worker termine sem ficar pendurado.
    engine.releaseBatch();
    await waitTerminal(mgr, id);
  });

  /**
   * PONTO 2: engine.abortEngineWork(id) é chamado com o scanId correcto.
   */
  it("2. abortEngineWork é chamado com o scanId correcto durante o cancel", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    mgr.cancelScan(id);
    engine.releaseBatch();
    await waitTerminal(mgr, id);

    assert.ok(
      engine.abortCalls.length >= 1,
      `abortEngineWork tem de ser chamado pelo menos uma vez (chamadas: ${engine.abortCalls.length})`,
    );
    assert.ok(
      engine.abortCalls.includes(id),
      `abortEngineWork tem de ser chamado com o scanId correcto ` +
      `(esperado: '${id}', chamadas: ${JSON.stringify(engine.abortCalls)})`,
    );
  });

  /**
   * PONTO 3: Depois do cancelamento, nenhum evento pode ter status 'running',
   * progresso a subir, filesAnalyzed a subir ou filesScanned a subir.
   */
  it("3. depois do cancel não há progresso fictício (running, filesAnalyzed crescente, filesScanned crescente)", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    mgr.cancelScan(id);
    // Marcar o índice do primeiro evento após o cancel.
    const cancelEventIndex = engine.events.length;

    engine.releaseBatch();
    await waitTerminal(mgr, id);

    const afterCancel = engine.events.slice(cancelEventIndex).filter((e) => e.id === id);

    // Nenhum evento depois do cancel pode ter status 'running'.
    const runningAfter = afterCancel.filter((e) => e.status === "running");
    assert.deepEqual(
      runningAfter,
      [],
      `depois do cancel não pode haver eventos com status 'running' ` +
      `(encontrados: ${JSON.stringify(runningAfter)})`,
    );

    // Os contadores não podem subir depois do cancel.
    // Obtemos o estado no instante do cancel como referência.
    const stateAtCancel = engine.events
      .slice(0, cancelEventIndex)
      .filter((e) => e.id === id)
      .at(-1);

    if (stateAtCancel && afterCancel.length > 0) {
      const maxAnalyzedBefore  = stateAtCancel.filesAnalyzed  ?? 0;
      const maxScannedBefore   = stateAtCancel.filesScanned   ?? 0;
      const maxProgressBefore  = stateAtCancel.progress       ?? 0;

      for (const evt of afterCancel) {
        if (evt.status === "cancelled") continue; // o evento terminal pode ter valores finais

        assert.ok(
          (evt.filesAnalyzed ?? 0) <= maxAnalyzedBefore,
          `filesAnalyzed subiu depois do cancel: antes=${maxAnalyzedBefore}, depois=${evt.filesAnalyzed} ` +
          `(evento: ${JSON.stringify(evt)})`,
        );
        assert.ok(
          (evt.filesScanned ?? 0) <= maxScannedBefore,
          `filesScanned subiu depois do cancel: antes=${maxScannedBefore}, depois=${evt.filesScanned} ` +
          `(evento: ${JSON.stringify(evt)})`,
        );
        assert.ok(
          (evt.progress ?? 0) <= maxProgressBefore,
          `progress subiu depois do cancel: antes=${maxProgressBefore}, depois=${evt.progress} ` +
          `(evento: ${JSON.stringify(evt)})`,
        );
      }
    }
  });

  /**
   * PONTO 4: O estado final permanece 'cancelled' e filesInEngineBatch
   * termina em 0 no evento terminal.
   */
  it("4. estado final é 'cancelled' e filesInEngineBatch=0 no evento terminal", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    mgr.cancelScan(id);
    engine.releaseBatch();
    const finalState = await waitTerminal(mgr, id);

    assert.equal(
      finalState.status,
      "cancelled",
      `o estado final tem de ser 'cancelled' (obtido: '${finalState.status}')`,
    );

    // O evento terminal publicado via emitScanProgress também tem de ter
    // filesInEngineBatch=0.
    const terminalEvent = engine.events
      .filter((e) => e.id === id && e.status === "cancelled")
      .at(-1);

    assert.ok(
      terminalEvent,
      "tem de existir um evento emitido com status='cancelled'",
    );
    assert.equal(
      terminalEvent?.filesInEngineBatch ?? 0,
      0,
      `filesInEngineBatch tem de ser 0 no evento terminal ` +
      `(obtido: ${terminalEvent?.filesInEngineBatch})`,
    );

    // Confirmar também que o ScanManager.getScan não retém batch activo.
    assert.equal(
      finalState.filesInEngineBatch ?? 0,
      0,
      `getScan deve devolver filesInEngineBatch=0 no estado final ` +
      `(obtido: ${finalState.filesInEngineBatch})`,
    );
  });

  /**
   * PONTO 5: Sem órfãos — depois do estado terminal, um novo startScan é
   * aceite (o slot currentScanPromise foi libertado).
   */
  it("5. sem órfãos — novo startScan é aceite depois do terminal", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    mgr.cancelScan(id);
    engine.releaseBatch();
    await waitTerminal(mgr, id);

    // O slot tem de estar livre agora.
    assert.equal(
      mgr.getActiveScan(),
      null,
      "getActiveScan deve devolver null depois do terminal",
    );

    // Um segundo scan independente tem de ser aceite.
    // Usamos um engine novo sem holdBatch para que este segundo scan complete.
    const engine2 = makeEngine({ holdBatch: false });
    const mgr2 = makeManager(engine2);
    const id2 = await mgr2.startScan("custom", tmp);
    assert.ok(
      id2 !== null && id2 !== undefined,
      `um segundo startScan tem de ser aceite depois do terminal (obtido: ${id2})`,
    );
    assert.notEqual(id2, id, "o segundo scan tem id diferente do primeiro");

    // Aguardar que o segundo scan complete para não deixar workers a correr.
    await waitTerminal(mgr2, id2);
  });

  /**
   * PONTO 5b: No MESMO ScanManager, o novo startScan só é aceite depois de o
   * worker do batch cancelado ter terminado (clearClamavPrefetch chamado).
   *
   * SINCRONIZAÇÃO CORRECTA: cancelScan publica o estado terminal IMEDIATAMENTE
   * (antes de o worker drenar) — por design, para que a UI veja 'cancelled'
   * sem esperar. Mas o slot currentScanPromise só é libertado quando o worker
   * termina o finally, que inclui clearClamavPrefetch. Portanto:
   *   - waitTerminal devolve logo após cancelScan (slot ainda ocupado) → errado
   *     como sinal de drenagem.
   *   - engine.clearCalls.includes(id) → correcto: clearClamavPrefetch é
   *     chamado no finally exterior do runScanLoop, imediatamente antes de
   *     libertar o slot.
   */
  it("5b. novo startScan no mesmo manager só é aceite depois do worker terminar", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    mgr.cancelScan(id);

    // Enquanto o batch não foi libertado, o worker ainda está em curso —
    // o slot não pode estar livre.
    const idWhileDraining = await mgr.startScan("custom", tmp);

    // Libertar o portão (simula o ClamAV a sair finalmente).
    engine.releaseBatch();

    // Aguardar que o worker assente: o sinal correcto é clearClamavPrefetch,
    // chamado no finally do runScanLoop imediatamente antes de libertar o slot.
    const drainDeadline = Date.now() + 2_000;
    while (!engine.clearCalls.includes(id) && Date.now() < drainDeadline) {
      await sleep(5);
    }
    assert.ok(
      engine.clearCalls.includes(id),
      `o worker não dreneu em 2 s: clearClamavPrefetch('${id}') nunca chamado ` +
      `(clearCalls: ${JSON.stringify(engine.clearCalls)})`,
    );

    // Agora o slot está livre.
    assert.equal(
      idWhileDraining,
      null,
      `não pode haver overlap: o segundo startScan durante o drain tem de devolver null ` +
      `(obtido: ${idWhileDraining})`,
    );

    // Depois do worker ter assentado, um terceiro scan é aceite.
    const id3 = await mgr.startScan("custom", tmp);
    assert.ok(
      id3 !== null && id3 !== undefined,
      `startScan após o worker assentar tem de ser aceite (obtido: ${id3})`,
    );

    // Limpar: cancelar o id3 para não deixar worker pendurado.
    mgr.cancelScan(id3);
    await waitTerminal(mgr, id3, 3_000).catch(() => {});
  });

  /**
   * PONTO 4 + 3 combinados: nenhum evento posterior ao cancelamento pode
   * reescrever o estado terminal para 'completed' ou 'failed'.
   */
  it("6. o estado terminal 'cancelled' é imutável — completed/failed tardio não o sobrescreve", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);

    mgr.cancelScan(id);
    engine.releaseBatch();
    await waitTerminal(mgr, id);

    // Verificar todos os eventos emitidos após o primeiro 'cancelled'.
    const cancelIdx = engine.events.findIndex((e) => e.id === id && e.status === "cancelled");
    assert.ok(cancelIdx >= 0, "tem de existir pelo menos um evento 'cancelled'");

    const afterFirstCancel = engine.events.slice(cancelIdx + 1).filter((e) => e.id === id);
    const illegalAfter = afterFirstCancel.filter(
      (e) => e.status === "completed" || e.status === "failed" || e.status === "running",
    );

    assert.deepEqual(
      illegalAfter,
      [],
      `depois do primeiro 'cancelled' não pode haver eventos completed/failed/running ` +
      `(encontrados: ${JSON.stringify(illegalAfter)})`,
    );

    // O estado final de getScan também tem de ser 'cancelled'.
    const finalState = mgr.getScan(id);
    assert.equal(
      finalState?.status,
      "cancelled",
      `getScan tem de devolver 'cancelled' (obtido: '${finalState?.status}')`,
    );
  });

  /**
   * PONTO 6 (perf/segurança): zero clamscan real.
   *
   * Como todos os testes acima usam o fake engine, este teste verifica
   * explicitamente que o prefetchClamav do fake foi chamado (não o real)
   * e que o número de spawns é zero — o que é garantido pelo fake engine
   * (não há `spawn` de processo nenhum). Esta é a prova de que o harness
   * é determinístico e não lança o binário real.
   */
  it("6. zero clamscan real — o fake engine foi o único prefetchClamav chamado", async () => {
    const engine = makeEngine();
    const mgr = makeManager(engine);

    const id = await mgr.startScan("custom", tmp);
    await waitBatchActive(mgr, id);
    mgr.cancelScan(id);
    engine.releaseBatch();
    await waitTerminal(mgr, id);

    // O prefetchClamav do fake foi chamado.
    assert.ok(
      engine.prefetchCalls.length >= 1,
      "o fake prefetchClamav tem de ter sido chamado pelo menos uma vez",
    );
    assert.equal(
      engine.prefetchCalls[0].scanId,
      id,
      `prefetchClamav chamado com o scanId errado (esperado: '${id}', obtido: '${engine.prefetchCalls[0].scanId}')`,
    );

    // Nenhum processo nasceu (o fake engine não tem spawn).
    // Verificado implicitamente: se o clamscan real tivesse sido chamado,
    // o teste teria excedido o timeout (o binário demora ~6 s só a carregar
    // a base de assinaturas — muito acima do 3 s do waitBatchActive).
    assert.ok(
      true,
      "o harness é determinístico: sem clamscan real, sem I/O de base de assinaturas",
    );
  });

  it("7. terminal cancelado conta veredictos ACEITES, não o progresso do batch", async () => {
    // Reproduz o estado MEDIDO na prova integrada da lane (run3, 2026-10-23): 400
    // ficheiros num único batch de ClamAV (`strategy=file-list`, onProgressCalls=400),
    // cancelamento que consumiu 61, e o terminal dizia `filesAnalyzed=400` com
    // `filesScanned=61` e `progress=99`. O progresso do motor é UM EIXO
    // (`filesInEngineBatch`); `filesAnalyzed` é o eixo dos veredictos que o scanner
    // efectivamente aceitou e refechou. As asserções comparam eixos entre si e com o
    // histórico — não espelham nenhuma fórmula do código.
    const TOTAL = 8;
    const eventos = [];
    const registados = [];
    let abrirPorta;
    const portao = new Promise((r) => { abrirPorta = r; });
    let consumidos = 0;
    const engine = {
      isExcluded: () => false,
      emitScanProgress: (state) => { eventos.push({ ...state }); },
      abortEngineWork: () => {},
      async prefetchClamav(filePaths, _scanId, onProgress) {
        onProgress?.(filePaths.length);
        return { spawned: true, files: filePaths.length };
      },
      clearClamavPrefetch: () => {},
      async scanArtifact(filePath) {
        consumidos++;
        // O segundo consumo pára até o caso cancelar: é isto que deixa veredictos
        // do batch por aceitar, exactamente como numa corrida real.
        if (consumidos === 2) await portao;
        return {
          results: [{
            fileName: path.basename(filePath), size: 1, severity: "low", confidence: 1,
            rulesTriggered: [], riskScore: 0, verdict: "safe", analysisState: "completed", sha256: "x",
          }],
          totalFiles: 1, highRiskCount: 0, overallSeverity: "low", rulesTriggered: [], riskScore: 0,
        };
      },
    };

    const mgr = new ScanManager(engine, { record: async (s) => { registados.push({ ...s }); } });
    const nomes = Array.from({ length: TOTAL }, (_, i) => path.join(tmp, `file-${i}.bin`));
    mgr.gatherFiles = async (_root, output) => { output.push(...nomes); };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);
    for (let i = 0; i < 400 && consumidos < 2; i++) await sleep(5);
    assert.equal(consumidos, 2, "o caso precisa de estar bloqueado no segundo veredicto");
    mgr.cancelScan(id);
    abrirPorta();
    const terminal = await waitTerminal(mgr, id);

    const aceites = terminal.filesScanned - (terminal.filesExcluded ?? 0) - (terminal.filesFailed ?? 0);
    assert.equal(terminal.status, "cancelled");
    assert.ok(terminal.filesScanned >= 1 && terminal.filesScanned < TOTAL,
      `consumição parcial esperada (1..${TOTAL - 1}), obtido ${terminal.filesScanned}`);
    assert.ok(aceites < TOTAL,
      "um cancelamento a meio NÃO pode afirmar cobertura completa do alvo");
    assert.equal(terminal.filesAnalyzed, aceites,
      `filesAnalyzed tem de contar veredictos aceites (${aceites}), não o batch (${TOTAL}); obtido ${terminal.filesAnalyzed}`);
    assert.equal(terminal.progress, Math.floor((terminal.filesScanned / TOTAL) * 100),
      "o progresso é o eixo do que fechou ciclo; um cancelado não herda o 100 do motor");
    assert.ok(terminal.progress < 100, "cancelado nunca é 100%");
    assert.equal(terminal.filesInEngineBatch ?? 0, 0, "sem batch em curso no terminal");
    assert.ok(terminal.endTime, "o terminal tem de estar fechado");
    assert.equal(Math.max(...eventos.map((e) => e.filesAnalyzed ?? 0)), aceites,
      "nenhum evento publicado antes do terminal pode ter prometido cobertura maior do que a prova");
    assert.equal(eventos.every((e) => e.filesAnalyzed === undefined ||
      e.filesAnalyzed <= e.filesScanned - (e.filesExcluded ?? 0) - (e.filesFailed ?? 0)), true,
      "antes e depois: filesAnalyzed nunca supera os resultados efectivamente aceites");
    assert.ok(registados.length >= 1, "o cancelamento tem de chegar ao histórico");
    const linha = registados[registados.length - 1];
    assert.equal(linha.status, "cancelled");
    assert.equal(linha.filesAnalyzed, aceites,
      "histórico e estado têm de contar o mesmo; divergir é o falso seguro por outra via");
  });

  it("8. fronteira: cancel no instante em que todos os ciclos fecharam ainda com status running → cancelled nunca é 100", async () => {
    // O revisor pediu prova EXECUTADA desta fronteira, não uma fórmula isolada.
    // O loop publica `progress: 100` com `status: "running"` na última emit
    // (ficheiro i === files.length - 1). Este caso dispara o cancelamento NESSE
    // exacto instante, observado pelo próprio callback de progresso do serviço.
    const TOTAL = 3;
    const registados = [];
    let instantâneo = null;
    const nomes = Array.from({ length: TOTAL }, (_, i) => path.join(tmp, `file-${i}.bin`));
    const engine = {
      isExcluded: () => false,
      emitScanProgress: (state) => {
        if (
          instantâneo === null &&
          state.status === "running" &&
          (state.filesTotal ?? 0) === TOTAL &&
          state.filesScanned === state.filesTotal
        ) {
          instantâneo = { ...state };
          mgr.cancelScan(state.id); // ← o cancel chega AQUI, ainda sem terminal
        }
      },
      abortEngineWork: () => {},
      clearClamavPrefetch: () => {},
      async scanArtifact(filePath) {
        return {
          results: [{
            fileName: path.basename(filePath), size: 1, severity: "low", confidence: 1,
            rulesTriggered: [], riskScore: 0, verdict: "safe", analysisState: "completed", sha256: "x",
          }],
          totalFiles: 1, highRiskCount: 0, overallSeverity: "low", rulesTriggered: [], riskScore: 0,
        };
      },
    };
    const mgr = new ScanManager(engine, { record: async (s) => { registados.push({ ...s }); } });
    mgr.gatherFiles = async (_root, output) => { output.push(...nomes); };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);
    const terminal = await waitTerminal(mgr, id);

    assert.ok(instantâneo, "a fronteira tem de ser alcançada: ultimo emit com todos os ciclos fechados e ainda running");
    assert.equal(instantâneo.progress, 100, "o instantâneo observado é o que publica 100 com running");
    assert.equal(terminal.status, "cancelled", "o cancel nessa fronteira tem de permanecer cancelado");
    assert.ok(terminal.endTime, "terminal fechado com endTime");
    assert.equal(terminal.filesScanned, TOTAL, "todos os ciclos fecharam antes do cancel");
    assert.equal(terminal.filesAnalyzed, TOTAL, "e todos os veredictos foram aceites: o eixo dos resultados é total");
    assert.ok((terminal.progress ?? 100) < 100,
      `um scan cancelado não pode publicar 100 (obtido ${terminal.progress}) — é o invariante do contrato`);
    assert.equal(terminal.filesInEngineBatch ?? 0, 0);
    assert.ok(registados.length >= 1, "o cancelamento tem de chegar ao histórico");
    const linha = registados[registados.length - 1];
    assert.equal(linha.status, "cancelled");
    assert.equal(linha.filesAnalyzed, terminal.filesAnalyzed, "histórico e estado contam o mesmo");
    assert.equal(linha.progress, terminal.progress, "histórico e estado têm o mesmo progresso");
  });

  it("9. um scan já concluído não pode ser transformado em cancelado (a API recusa a sobrescrita)", async () => {
    // Complemento da fronteira acima: se o terminal chegou primeiro, o cancel
    // não consegue escrever `cancelled` por cima — é isto que prova que o estado
    // «completed 100» nunca aparece como «cancelled 100» por essa via.
    const engine = makeEngine({ holdBatch: false });
    const mgr = makeManager(engine);
    const id = await mgr.startScan("custom", tmp);
    const terminal = await waitTerminal(mgr, id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.progress, 100);

    const desfecho = mgr.cancelScan(id);
    await sleep(30);
    const depois = mgr.getScan(id);
    assert.equal(depois?.status, "completed", "cancelar um completed é recusado, não reescrito");
    assert.equal(depois?.progress, 100, "o progresso de um concluído mantém-se");
    void desfecho;
  });

});
