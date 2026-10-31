/**
 * P0 SCANNER_POST_BATCH_NO_DOUBLE_CLAMAV — depois do batch, nenhum dos 728
 * candidatos pode voltar a invocar o ClamAV por ficheiro, e a decomposição
 * 800/728/66/6 tem de fechar sem perder nem contar nada duas vezes.
 *
 * ── O que foi MEDIDO em runtime humano ────────────────────────────────────
 *
 *   Quick Scan selecionados = 800
 *   candidatos do batch    = 728   (o clamscan devolveu 728 veredictos)
 *   excluídos              = 66
 *   zip                    = 6
 *   728 + 66 + 6           = 800   (o "remainder" que ninguém explicava)
 *
 * E, na mesma corrida, o utilizador viu um `clamscan` unitário com
 * `priority=user` / `strategy=argv` A DEPOIS do batch ter terminado — trabalho
 * já pago a ser pago outra vez, ficheiro a ficheiro. O progresso também
 * reiniciava (`filesScanned` a 1, 5, 9, ... enquanto `filesAnalyzed` ficava em
 * 728).
 *
 * ── A ARMADILHA 1 (porque é que um teste ingénuo não prova nada) ──────────
 *
 * Afirmar "o resultado é safe/clean" para um ficheiro do batch NÃO prova que o
 * ClamAV não foi invocado outra vez: um clamscan real sobre um ficheiro de
 * texto benigno também devolve `clean`. O que discrimina é a CONTAGEM DE
 * CHAMADAS no bridge injectado — `scanFiles` (batch) e `scanFile` (unitário)
 * são contadores separados, e é `scanFileCalls === 0` que prova a ausência do
 * segundo trabalho. O inverso também importa: se a injecção do bridge estiver
 * partida, o caminho sem cache arranca um clamscan REAL, por isso a primeira
 * asserção depois do prefetch é o próprio contador do batch.
 *
 * ── A ARMADILHA 2 (a quarentena renomeia o ficheiro para fora) ────────────
 *
 * Um veredicto `detected` põe o ficheiro em quarentena, e a quarentena
 * RENOMEIA-O para fora do sítio. Um `scanArtifact` posterior no mesmo path
 * falha no `sha256File` ANTES de chegar à decisão de ClamAV — e o teste mediria
 * um erro de ficheiro inexistente a fingir de "não invocou o ClamAV". Por isso
 * cada leitura de um ficheiro que pode ser detetado é a ÚNICA leitura desse
 * path, e os ficheiros que precisam de ser lidos mais do que uma vez têm
 * sempre veredicto limpo.
 *
 * ── COMO O MOTOR É INJECTADO (e porque é que é por MUTAÇÃO) ───────────────
 *
 * O `MalwareAnalyzer` é construído no arranque com `clamav: this.clamav`, ou
 * seja, guarda a REFERÊNCIA do bridge. Trocar `engine.clamav` por outro objeto
 * não muda o que o analyzer usa. Por isso o bridge REAL é mutado no sítio
 * (`bridge.scanFiles = ...`, `bridge.scanFile = ...`): a mutação é visível
 * tanto para o `prefetchClamav` (que lê `this.clamav` na chamada) como para o
 * analyzer (que guardou o mesmo objeto).
 *
 * ZERO clamscan. ZERO EICAR. `init()` nunca é chamado: sem watcher, sem ETW,
 * sem handles de sistema. A baseDir é um tmpdir isolado.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";

import { ProtectionEngineService } from "../dist/engine.js";
import { ScanManager } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const criados = [];

async function mkTmp(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  criados.push(dir);
  return dir;
}

after(async () => {
  for (const dir of criados) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Muta o bridge REAL do motor para um planeador determinista.
 *
 * `verdicts` decide o veredicto POR CAMINHO; o que não estiver no mapa cai em
 * `defaultVerdict`. Devolve os contadores — são eles, e não o texto do
 * resultado, que medem o trabalho duplicado.
 */
function injectClamav(engine, { verdicts = new Map(), defaultVerdict = "clean" } = {}) {
  const bridge = engine.clamav;
  const counts = { scanFilesCalls: 0, scanFileCalls: 0, batches: [] };

  const veredictoDe = (filePath) => verdicts.get(filePath) ?? defaultVerdict;
  const outcomeDe = (filePath) => {
    const verdict = veredictoDe(filePath);
    return {
      file: filePath,
      verdict,
      detected: verdict === "detected",
      reason: verdict === "detected" ? "Test.Signature" : undefined,
    };
  };

  bridge.scanFiles = async (filePaths) => {
    counts.scanFilesCalls += 1;
    counts.batches.push([...filePaths]);
    return {
      files: filePaths.map(outcomeDe),
      detected: filePaths.some((f) => veredictoDe(f) === "detected"),
      errorCount: 0,
      status: { status: "active", detail: "" },
    };
  };

  // O caminho SEM batch: uma invocação por ficheiro. É o veredicto de um scan
  // sem dono ou de um ficheiro que nunca entrou no prefetch.
  bridge.scanFile = async (filePath) => {
    counts.scanFileCalls += 1;
    const outcome = outcomeDe(filePath);
    return {
      detected: outcome.detected,
      verdict: outcome.verdict,
      detail: "sem batch: uma invocacao por ficheiro",
      file: filePath,
      status: { status: "active", detail: "" },
    };
  };

  bridge.isAvailable = async () => true;
  engine.clamav = bridge;
  return counts;
}

function novoMotor(baseDir) {
  // NUNCA `init()`: o contrato destes testes é o prefetch e o scanArtifact, não
  // o arranque de watcher/ETW/WFP.
  return new ProtectionEngineService(baseDir);
}

async function escrever(dir, nomes, conteudo = "conteudo benigno") {
  const paths = [];
  for (const nome of nomes) {
    const p = path.join(dir, nome);
    await fs.writeFile(p, conteudo, "utf-8");
    paths.push(p);
  }
  return paths;
}

describe("prefetch nao se repete por ficheiro (motor REAL, bridge injectado)", () => {
  it("os 6 ficheiros do batch sao resolvidos pelo veredicto em cache, sem um unico scanFile", async () => {
    const dir = await mkTmp("cs-nodouble-a-");
    const engine = novoMotor(dir);
    const scanId = "scan-1";
    const files = await escrever(dir, ["a.exe", "b.exe", "c.exe", "d.txt", "e.txt", "f.txt"]);

    // 3 detetados (provam que o veredicto em cache é USADO, não ignorado) e 3
    // limpos (é o que um clamscan unitário de um ficheiro benigno também diria:
    // por si só, "clean" não prova nada — ver ARMADILHA 1).
    const verdicts = new Map([
      [files[0], "detected"],
      [files[1], "detected"],
      [files[2], "detected"],
    ]);
    const counts = injectClamav(engine, { verdicts });

    const outcome = await engine.prefetchClamav(files, scanId);
    assert.equal(outcome.spawned, true);
    assert.equal(outcome.files, 6, "um veredicto terminal por ficheiro pedido");
    assert.equal(
      counts.scanFilesCalls,
      1,
      "se o contador do batch ficar em 0 a injecção do bridge não pegou — e o caminho sem cache arrancaria um clamscan real",
    );
    assert.deepEqual(counts.batches[0].sort(), [...files].sort());

    // O cache é do MOTOR e tem dono: o mesmo resultado, só para este scanId.
    const cached = engine.clamavOutcomeFor(files[0], scanId);
    assert.ok(cached, "o veredicto do batch tem de estar acessível pelo dono");
    assert.equal(cached.file, files[0]);
    assert.equal(engine.clamavOutcomeFor(files[0], "scan-2"), undefined, "outro scan nunca herda este batch");
    assert.equal(engine.clamavOutcomeFor(files[0], undefined), undefined, "sem dono não há veredicto a consultar");

    for (const file of files) {
      const resposta = await engine.scanArtifact(file, "system-scanner", {
        skipVirusTotal: true,
        scanId,
      });
      const entrada = resposta?.results?.[0];
      assert.ok(entrada, `${file}: não há resultado observável`);
      if (verdicts.get(file) === "detected") {
        assert.equal(entrada.verdict, "malicious", `${file}: o veredicto em cache tem de mandar`);
        assert.ok(
          entrada.rulesTriggered.includes("known_malware"),
          `${file}: a regra known_malware tem de aparecer (regras: ${entrada.rulesTriggered.join(",")})`,
        );
      } else {
        assert.equal(entrada.verdict, "safe", `${file}: um veredicto limpo em cache é safe`);
        assert.ok(!entrada.rulesTriggered.includes("known_malware"));
      }
    }

    assert.equal(
      counts.scanFileCalls,
      0,
      "um ficheiro com veredicto terminal em cache NÃO pode voltar a pagar o carregamento da base do clamscan",
    );
    assert.equal(counts.scanFilesCalls, 1, "o batch continua a ser uma única invocação");
  });

  it("batches adicionais do mesmo scan preservam outcomes já obtidos (ZIP não reabre cold start para o resto)", async () => {
    const dir = await mkTmp("cs-nodouble-merge-");
    const engine = novoMotor(dir);
    const scanId = "scan-merge";
    const [regular, zipEntry] = await escrever(dir, ["regular.txt", "zip-entry.txt"]);
    const counts = injectClamav(engine);

    await engine.prefetchClamav([regular], scanId);
    assert.ok(engine.clamavOutcomeFor(regular, scanId), "pré-condição: primeiro batch guardado");

    await engine.prefetchClamav([zipEntry], scanId);

    assert.ok(
      engine.clamavOutcomeFor(regular, scanId),
      "o batch das entradas ZIP não pode substituir os outcomes regulares deste scan",
    );
    assert.ok(engine.clamavOutcomeFor(zipEntry, scanId), "o segundo batch também fica disponível");

    await engine.scanArtifact(regular, "system-scanner", { skipVirusTotal: true, scanId });
    await engine.scanArtifact(zipEntry, "system-scanner", { skipVirusTotal: true, scanId });

    assert.equal(counts.scanFilesCalls, 2, "um batch inicial e um batch de entradas ZIP");
    assert.equal(counts.scanFileCalls, 0, "nenhum outcome de qualquer batch volta a clamscan por ficheiro");
  });

  it("um ficheiro FORA do batch continua a ter o caminho de um clamscan por ficheiro", async () => {
    const dir = await mkTmp("cs-nodouble-b-");
    const engine = novoMotor(dir);
    const scanId = "scan-1";
    const noBatch = await escrever(dir, ["no-batch.txt"]);
    const counts = injectClamav(engine, { verdicts: new Map([[noBatch[0], "detected"]]) });

    await engine.prefetchClamav(noBatch, scanId);
    assert.equal(counts.scanFilesCalls, 1);
    assert.equal(counts.scanFileCalls, 0, "pré-condição: a cache está a cobrir este ficheiro");

    const fora = await escrever(dir, ["fora-do-batch.txt"]);
    // O mesmo scan, mas um ficheiro que o prefetch nunca viu.
    const resposta = await engine.scanArtifact(fora[0], "system-scanner", {
      skipVirusTotal: true,
      scanId,
    });

    assert.equal(
      counts.scanFileCalls,
      1,
      "a cache não pode virar supressão global: um ficheiro não coberto tem de ser analisado",
    );
    assert.ok(resposta?.results?.length, "o ficheiro não coberto devolve resultado na mesma");
  });

  it("outro scanId não vê o batch deste scan (o cache é por dono, não global)", async () => {
    const dir = await mkTmp("cs-nodouble-c-");
    const engine = novoMotor(dir);
    const files = await escrever(dir, ["dono-a.txt"]);
    const counts = injectClamav(engine, { verdicts: new Map([[files[0], "detected"]]) });

    await engine.prefetchClamav(files, "scan-a");
    assert.equal(counts.scanFilesCalls, 1);

    await engine.scanArtifact(files[0], "system-scanner", {
      skipVirusTotal: true,
      scanId: "scan-b",
    });

    assert.equal(
      counts.scanFileCalls,
      1,
      "o veredicto de scan-a não pode servir scan-b: cada scan paga o seu próprio batch",
    );
  });

  it("depois de clearClamavPrefetch o mesmo ficheiro volta a ter o seu próprio clamscan", async () => {
    const dir = await mkTmp("cs-nodouble-d-");
    const engine = novoMotor(dir);
    const scanId = "scan-1";
    // Veredicto LIMPO de propósito: um detetado era posto em quarentena e
    // renomeado para fora, e a segunda leitura media um ficheiro inexistente
    // em vez da cache (ARMADILHA 2).
    const files = await escrever(dir, ["limpo.txt"]);
    const counts = injectClamav(engine);

    await engine.prefetchClamav(files, scanId);
    assert.ok(engine.clamavOutcomeFor(files[0], scanId), "pré-condição: o veredicto está em cache");

    engine.clearClamavPrefetch(scanId);
    assert.equal(
      engine.clamavOutcomeFor(files[0], scanId),
      undefined,
      "limpar o dono tem de largar o veredicto — senão o Map cresce sem fim",
    );

    await engine.scanArtifact(files[0], "system-scanner", { skipVirusTotal: true, scanId });
    assert.equal(counts.scanFileCalls, 1, "sem batch, o motor volta ao caminho de um ficheiro de cada vez");
  });
});

describe("entradas de ZIP passam por UM batch, nunca por um clamscan cada", () => {
  it("scanZipWithSafety agrupa as entradas extraidas e nenhuma paga a base outra vez", async () => {
    const dir = await mkTmp("cs-zip-batch-");
    const zipPath = path.join(dir, "benigno.zip");
    const zip = new AdmZip();
    for (let i = 0; i < 5; i++) {
      zip.addFile(`docs/item-${i}.txt`, Buffer.from(`entrada benigna ${i}\n`, "utf-8"));
    }
    zip.writeZip(zipPath);

    const engine = novoMotor(dir);
    const counts = injectClamav(engine);
    const mgr = new ScanManager(engine);

    const threats = await mgr.scanZipWithSafety("scan-zip", zipPath);

    // 1 batch para as 5 entradas extraidas; o prefetch do scan externo e' outro.
    assert.equal(counts.scanFilesCalls, 1, "as entradas extraidas tem de ir num so batch");
    assert.deepEqual(counts.batches[0].length, 5, "o batch cobre exatamente as 5 entradas");
    assert.equal(
      counts.scanFileCalls,
      0,
      "nenhuma entrada pode pagar o carregamento da base num clamscan unitario",
    );
    assert.equal(threats, 0, "conteudo benigno nao produz ameacas");
  });
});

/**
 * Motor de teste do ScanManager. Reencena o CONTRATO do cache de produção: o
 * batch instala um conjunto por scanId e o `scanArtifact` conta, por ficheiro,
 * se estava coberto ou não. É esta contabilidade que dá nome ao `remainder`.
 */
function makeScanEngine({ hold, onEnter } = {}) {
  const events = [];
  const prefetchCalls = [];
  const clearCalls = [];
  const batches = new Map();
  const counts = { hits: 0, misses: 0, artifacts: 0, zips: 0 };
  return {
    events,
    prefetchCalls,
    clearCalls,
    counts,
    batches,
    isExcluded: (filePath) => path.extname(filePath).toLowerCase() === ".tmp",
    emitScanProgress: (state) => events.push({ ...state }),
    abortEngineWork: () => {},
    async prefetchClamav(filePaths, scanId, onProgress) {
      prefetchCalls.push({ count: filePaths.length, scanId, paths: [...filePaths] });
      // Reencena o CONTRATO de producao: um batch adicional do MESMO scanId faz
      // merge no mapa existente, nao o substitui (o ficheiro externo do ZIP e as
      // entradas extraidas sao acrescentados depois do batch principal).
      const batchSet = batches.get(scanId) ?? new Set();
      for (const p of filePaths) batchSet.add(p);
      batches.set(scanId, batchSet);
      if (onEnter) onEnter();
      for (let n = 1; n <= filePaths.length; n++) {
        if (typeof onProgress === "function") onProgress(n);
      }
      if (hold) await hold.promise;
      return { spawned: true, files: filePaths.length };
    },
    clearClamavPrefetch(scanId) {
      clearCalls.push(scanId);
      batches.delete(scanId);
    },
    async scanArtifact(filePath, _source, options = {}) {
      counts.artifacts += 1;
      const coberto = options && options.scanId ? batches.get(options.scanId) : undefined;
      if (coberto && coberto.has(filePath)) counts.hits += 1;
      else counts.misses += 1;
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

function makeManager(engine, scanPaths) {
  const mgr = new ScanManager(engine);
  // Só o ScanManager interessa aqui: a enumeração do disco não é o contrato.
  mgr.gatherFiles = async (_root, output) => { output.push(...scanPaths); };
  mgr.looksLikeZip = async () => false;
  // Nenhum zip real é aberto: a contagem, essa, tem de aparecer.
  mgr.scanZipWithSafety = async () => { engine.counts.zips += 1; return 0; };
  return mgr;
}

async function waitTerminal(mgr, id, timeoutMs = 20000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(10);
  }
  throw new Error("o scan não atingiu estado terminal");
}

async function waitAssentou(mgr, timeoutMs = 20000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (mgr.currentScanPromise === null) return;
    await sleep(5);
  }
  throw new Error("o worker do scan não largou o lock");
}

describe("800 = 728 batch + 66 excluidos + 6 zip, sem double count", () => {
  it("a decomposicao fecha em 800 e nenhum ficheiro do batch volta aos motores", async () => {
    const dir = await mkTmp("cs-800-");
    const nomes = [];
    for (let i = 0; i < 728; i++) nomes.push(`doc-${i}.txt`);
    for (let i = 0; i < 66; i++) nomes.push(`cache-${i}.tmp`);
    for (let i = 0; i < 6; i++) nomes.push(`pack-${i}.zip`);
    await escrever(dir, nomes);
    const selecionados = nomes.map((n) => path.join(dir, n));
    assert.equal(selecionados.length, 800);

    const engine = makeScanEngine();
    const mgr = makeManager(engine, selecionados);
    const id = await mgr.startScan("custom", dir);
    assert.ok(id, "startScan devolveu um id");
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed");
    assert.equal(state.filesTotal, 800, "o denominador é o total SELECIONADO");
    assert.equal(state.filesScanned, 800, "todos os 800 chegam a outcome terminal");
    assert.equal(state.filesProcessed, 800, "o contador de pipeline é o mesmo dos dois nomes");
    assert.equal(state.filesExcluded, 66, "os 66 são excluídos, não desaparecem");
    assert.equal(
      state.filesAnalyzed,
      734,
      "728 do batch + 6 zip que passam pelos motores; o batch é um prefetch, nunca uma soma sobre os mesmos ficheiros",
    );
    assert.equal(state.filesFailed, 0);
    assert.equal(state.progress, 100);

    // A decomposição, com nomes: nenhum ficheiro sem causa.
    assert.equal(engine.prefetchCalls.length, 2, "batch principal + batch dos ZIP externos");
    assert.equal(engine.prefetchCalls[0].count, 728, "o batch recebe só os 728 candidatos");
    assert.equal(engine.prefetchCalls[0].scanId, id, "o batch tem de ter o scanId do scan");
    assert.equal(engine.prefetchCalls[1].count, 6, "o segundo batch cobre os 6 ficheiros externos de ZIP");
    assert.equal(engine.prefetchCalls[1].scanId, id, "o batch dos ZIP pertence ao mesmo scan");
    assert.equal(engine.counts.hits, 734, "os 728 + os 6 ZIP externos são resolvidos pelo cache do batch");
    assert.equal(
      engine.counts.misses,
      0,
      "nenhum ficheiro do scan volta a pagar um cold start do clamscan",
    );
    assert.equal(engine.counts.zips, 6, "os 6 zip passam pelo caminho de arquivo seguro");
    assert.equal(728 + 66 + 6, 800, "selecionados = candidatos + excluídos + zip");
    assert.equal(734 + 66, 800, "pipeline terminal + excluídos = selecionados");
    assert.equal(engine.clearCalls.filter((c) => c === id).length, 1, "o batch é largado exatamente uma vez");
  });

  it("filesScanned e progress sao monotonicos e nunca passam o total", async () => {
    const dir = await mkTmp("cs-800-mono-");
    const nomes = [];
    for (let i = 0; i < 40; i++) nomes.push(`doc-${i}.txt`);
    for (let i = 0; i < 5; i++) nomes.push(`cache-${i}.tmp`);
    await escrever(dir, nomes);
    const selecionados = nomes.map((n) => path.join(dir, n));

    const engine = makeScanEngine();
    const mgr = makeManager(engine, selecionados);
    const id = await mgr.startScan("custom", dir);
    await waitTerminal(mgr, id);

    assert.ok(engine.events.length > 0, "o scan tem de publicar estado");
    let scannedAnterior = 0;
    let progressoAnterior = 0;
    for (const evento of engine.events) {
      const scanned = evento.filesScanned ?? 0;
      const progresso = evento.progress ?? 0;
      assert.ok(scanned >= scannedAnterior, `filesScanned recuou: ${scannedAnterior} -> ${scanned}`);
      assert.ok(scanned <= 45, `filesScanned passou o total: ${scanned}`);
      assert.ok(progresso >= progressoAnterior, `progress recuou: ${progressoAnterior} -> ${progresso}`);
      assert.ok(progresso >= 0 && progresso <= 100, `progress fora de [0,100]: ${progresso}`);
      scannedAnterior = scanned;
      progressoAnterior = progresso;
    }
    // O estado terminal, por si: a contagem acaba no total e a barra em 100%.
    const ultimo = engine.events[engine.events.length - 1];
    assert.equal(ultimo.status, "completed");
    assert.equal(ultimo.filesScanned, 45);
    assert.equal(ultimo.progress, 100);
  });
});

describe("cancelar durante o batch nao deixa trabalho orfao", () => {
  it("o cancel corta o loop, larga o prefetch e nao volta a correr motores", async () => {
    const dir = await mkTmp("cs-cancel-");
    const nomes = [];
    for (let i = 0; i < 12; i++) nomes.push(`doc-${i}.txt`);
    await escrever(dir, nomes);
    const selecionados = nomes.map((n) => path.join(dir, n));

    let release;
    const gate = new Promise((r) => { release = r; });
    let marcarEntrou;
    const entrou = new Promise((r) => { marcarEntrou = r; });

    const engine = makeScanEngine({ hold: { promise: gate }, onEnter: marcarEntrou });
    const mgr = makeManager(engine, selecionados);
    const id = await mgr.startScan("custom", dir);
    assert.ok(id);

    await entrou;
    assert.equal(mgr.getScan(id)?.status, "running", "pré-condição: o scan está a correr com o batch em voo");

    mgr.cancelScan(id);
    assert.equal(mgr.getScan(id)?.status, "cancelled", "o cancel é imediato e visível ao utilizador");

    release();
    await waitAssentou(mgr);
    const state = mgr.getScan(id);

    assert.equal(state.status, "cancelled", "um cancelamento não pode ser reescrito por um completed tardio");
    assert.ok(
      engine.clearCalls.includes(id),
      "o prefetch tem de ser largado mesmo em cancelamento (senão o Map cresce sem fim)",
    );
    assert.equal(
      engine.counts.artifacts,
      0,
      "depois do cancel nenhum ficheiro do batch pode voltar aos motores",
    );
    assert.equal(mgr.getActiveScan(), null, "um scan cancelado não é um scan ativo");
  });
});

describe("um segundo scan.start e recusado enquanto o primeiro nao assentou", () => {
  it("o lock e largado so quando o worker terminou, e ai o pedido seguinte e aceite", async () => {
    const dir = await mkTmp("cs-lock-");
    await escrever(dir, ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"]);

    let release;
    const gate = new Promise((r) => { release = r; });
    let marcarEntrou;
    const entrou = new Promise((r) => { marcarEntrou = r; });

    const engine = makeScanEngine({ hold: { promise: gate }, onEnter: marcarEntrou });
    // Sem override de gatherFiles: o diretório pequeno é enumerado a sério.
    const mgr = new ScanManager(engine);

    const primeiro = await mgr.startScan("custom", dir);
    assert.ok(primeiro, "o primeiro scan é aceite");
    await entrou;

    const recusado = await mgr.startScan("custom", dir);
    assert.equal(recusado, null, "um segundo scan a meio do primeiro é recusado, não posto em fila");

    release();
    await waitAssentou(mgr);

    const terceiro = await mgr.startScan("custom", dir);
    assert.ok(terceiro, "depois de o primeiro assentar, o slot volta a estar livre");
    assert.notEqual(terceiro, primeiro);

    // Limpeza: o terceiro scan já não precisa de correr para o teste ser válido.
    mgr.cancelScan(terceiro);
    await waitAssentou(mgr);
  });
});
