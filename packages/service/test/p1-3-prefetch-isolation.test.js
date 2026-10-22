/**
 * P1-3 — ISOLAMENTO DO PREFETCH.
 *
 * O contrato: o prefetch é POR SCAN e tem DONO. O veredicto de um scan nunca
 * pode chegar a outro, e limpar o dono de um scan nunca pode tocar no de outro.
 *
 * ── PORQUÊ ESTE FICHEIRO FOI REESCRITO (a prova anterior não provava) ──
 *
 * MEDIDO com as probes em `output/manual-retest/`:
 *
 * 1) P1-3-A — o 2.º teste antigo chamava `vereditoReal(engine, file)` SEM
 *    scanId. O accessor de produção (engine.ts:1815) faz
 *    `scanId !== undefined ? get(scanId) : undefined`, logo sem scanId o
 *    prefetch NUNCA é consultado. Probe, com o prefetch de A INTACTO e sem
 *    clear nenhum:
 *
 *      sem scanId            : {"verdict":"safe", rules:[dangerous_file_extension, suspicious_location]}
 *      scanId errado (scanB) : {"verdict":"safe", rules:[dangerous_file_extension, suspicious_location]}
 *      dono certo   (scanA)  : {"verdict":"malicious", rules:[..., known_malware, ...]}
 *
 *    Os dois primeiros são IDÊNTTICOS. O "não malicioso" que o teste observava
 *    é o mesmo com a Perry de A ainda viva — o clear de A era irrelevante para
 *    a asserção. Vazio por construção.
 *
 * 2) P1-3-B — o 3.º teste antigo PASSAVA com o Map GLOBAL (o bug que o P1-3
 *    diz ter corrigido) reintroduzido sobre o motor real, porque a entrada de A
 *    já tinha sido limpa antes do prefetch de B. Não matava a regressão que
 *    afirmava impedir. Probe: "com Map GLOBAL, teste 3 observa: safe" → passa.
 *
 * ── O HARNESS ──
 *
 *  - O motor é a `ProtectionEngineService` REAL. Só o `clamav` (o bridge que
 *    fala com o clamscan) é injectado. O Map por scan, a geração, o clear, o
 *    getter e o `scanArtifact` são TODOS de produção.
 *
 *  - O BRIDGE é um planeador de chamadas por ordem de entrada. Cada
 *    `scanFiles` consome o passo seguinte do plano, com o seu veredicto, e
 *    pode ficar retido por um portão. É isto que torna o interleaving
 *    DETERMINÍSTICO: o teste sabe que o batch de A já ENTROU antes de iniciar
 *    o de B, e decide a ordem em que cada um resolve. Nenhum sleep.
 *
 *  - COEXISTÊNCIA: os dois donos são instalados ao mesmo tempo e nenhum é
 *    limpo antes da leitura. Isto é o que distingue isolamento de sequência.
 *    Se um dono tivesse morrido, o seu veredicto seria "safe" — e o teste
 *    falha. Os dois veredictos só podem ser os dois se os dois donos estiverem
 *    vivos JUNTOS. Cada caso afirma `bridge.calls.length === 2` para provar que
 *    os dois scans ATINGIRAM a janela do prefetch.
 *
 *  - NENHUMA asserção de isolamento usa um accessor sem scanId. O único teste
 *    que o faz é o `P1-3-REGISTO`, que existe para deixar registado porquê
 *    (é o achado 1 acima).
 *
 *  - ORDEM DE LEITURA: um veredicto "malicious" põe o ficheiro em quarentena,
 *    e a quarentena RENOMEIA o ficheiro para fora. Por isso o veredicto limpo
 *    lê-se SEMPRE antes do malicioso quando é o mesmo path.
 *
 * ── MUTAÇÕES ──
 *
 * As quatro mutações correm EM MEMÓRIA, sobre a instância do motor, sem tocar
 * em `packages/service/src/`. Activam-se com `CS_P13_MUTACAO=m1|m2|m3|m4` e
 * servem para responder a uma pergunta por mutation: se o teste passa contra a
 * mutação, é porque não prova o contrato.
 *
 * ── SAFETY ──
 *
 * ZERO EICAR. ZERO clamscan. O bridge é injectado: nenhum motor real arranca.
 * CYBERSAFE_REAL_CLAMSCAN e CYBERSAFE_EICAR_MANUAL não são lidos aqui. A
 * baseDir é um tmpdir isolado (e é aí que a quarentena vai parar). Nada é
 * escrito no runtime do utilizador.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "cs-p13-"));
const MUTACAO = process.env.CS_P13_MUTACAO ?? "";

/**
 * Bridge com um PLANO por ordem de entrada.
 *
 * Um passo: `{ verdict }` | `{ throws }` | `{ hold: true }` | `{ waitAbort: true }`.
 * A combinação de `hold` com `throws`/`waitAbort` dá os casos de cancelamento,
 * erro e timeout com a ordem totalmente controlada pelo teste.
 */
function bridgeControl() {
  const plan = [];
  const calls = [];
  const enteredWaiters = new Map();
  let next = 0;

  const bridge = {
    calls,
    plan(step) { plan.push(step); return bridge; },
    /** Entra em `scanFiles` (ficou com o passo do plano), mesmo que fique presa. */
    callsAt(index) { return calls[index]; },
    async enteredAt(index) {
      if (index < next) return;
      await new Promise((resolve) => enteredWaiters.set(index, resolve));
    },
    open(index) {
      const call = calls[index];
      if (!call?.open) throw new Error(`a chamada ${index} não está retida`);
      call.open();
    },
    async scanFiles(filePaths, options) {
      const index = next++;
      const step = plan[index] ?? { verdict: "clean" };
      const call = { index, files: [...filePaths], verdict: step.verdict, signal: options?.signal };
      calls.push(call);

      if (step.hold) call.opened = new Promise((resolve) => { call.open = resolve; });
      // A escuta do abort é armada ANTES de notificar: quem espera por esta
      // entrada pode abortar sem perder o evento.
      if (step.waitAbort) {
        call.aborted = new Promise((_, reject) => {
          const sinal = call.signal;
          const falha = () => reject(new Error("clamscan abortado por timeout"));
          if (!sinal) { reject(new Error("sem sinal de scan")); return; }
          if (sinal.aborted) { falha(); return; }
          sinal.addEventListener("abort", falha, { once: true });
        });
      }

      const w = enteredWaiters.get(index);
      if (w) { enteredWaiters.delete(index); w(); }

      if (step.waitAbort) await call.aborted;
      else if (step.hold) await call.opened;

      if (step.throws) throw new Error(step.throws);
      return {
        files: filePaths.map((f) => ({
          file: f,
          verdict: step.verdict,
          detected: step.verdict === "detected",
          reason: step.verdict === "detected" ? "Test.Signature" : undefined,
        })),
        detected: step.verdict === "detected",
        errorCount: 0,
        status: { status: "active", detail: "" },
      };
    },
    // O caminho SEM prefetch: um ficheiro de cada vez. É o que dá um veredicto
    // próprio quando o scan não tem dono.
    async scanFile(f) {
      return { detected: false, verdict: "clean", detail: "sem prefetch", file: f, status: { status: "active", detail: "" } };
    },
    async isAvailable() { return true; },
  };
  return bridge;
}

/** Aplica a mutação pedida por `CS_P13_MUTACAO`. Nunca toca em disco. */
function aplicarMutacao(engine) {
  if (MUTACAO === "m1") {
    // M1 — ignorar o scanId no getter. O getter passa a varrer TODOS os donos.
    engine.clamavOutcomeFor = function (filePath) {
      for (const entry of this.clamavPrefetches.values()) {
        const v = entry.files.get(ProtectionEngineService.prefetchKey(filePath));
        if (v) return v;
      }
      return undefined;
    };
    return;
  }
  if (MUTACAO === "m2") {
    // M2 — clear global em vez de clear por owner.
    engine.clearClamavPrefetch = function () {
      this.clamavPrefetchGeneration++;
      this.clamavPrefetches.clear();
    };
    return;
  }
  if (MUTACAO === "m3") {
    // M3 — owner errado: limpar A apaga o dono de B.
    const original = engine.clearClamavPrefetch.bind(engine);
    engine.clearClamavPrefetch = () => original("scanB");
    return;
  }
  if (MUTACAO === "m4") {
    // M4 — a generation guard REMOVIDA, e nada mais.
    //
    // Escreve-se `if (entry)` e NÃO `get(owner)!`: o `!` lançaria TypeError
    // quando o dono já foi removido, o `catch` engoliria, e o teste passaria
    // por uma EXCEPÇÃO em vez de pela ausência da guarda. Assim a mutação só
    // remove a igualdade de GERAÇÃO, e é o comportamento — não um throw — que
    // o caso P1-3-GERACAO tem de apanhar.
    engine.prefetchClamav = async function (filePaths, scanId) {
      if (filePaths.length === 0) return { spawned: false };
      const generation = ++this.clamavPrefetchGeneration;
      const owner = scanId ?? `sem-id-${generation}`;
      this.clamavPrefetches.set(owner, { generation, files: new Map() });
      try {
        const batch = await this.clamav.scanFiles(filePaths, { signal: this.signalForScan(scanId) });
        const files = new Map(batch.files.map((f) => [ProtectionEngineService.prefetchKey(f.file), f]));
        const entry = this.clamavPrefetches.get(owner); // SEM GUARDA DE GERAÇÃO
        if (entry) entry.files = files;
        return { spawned: true };
      } catch (err) {
        this.clamavPrefetches.delete(owner);
        return { spawned: false, error: (err && err.message) || undefined };
      }
    };
  }
}

/**
 * Reconstrói o bug que o P1-3 diz ter corrigido: UM dono para toda a gente, e um
 * getter que não pergunta pelo scanId.
 *
 * Reutiliza o `prefetchClamav` e o `prefetchKey` DE PRODUÇÃO — muda só o que o
 * P1-3 mudou (o dono e o getter), para a comparação ser honesta.
 */
function degradarParaMapGlobal(engine) {
  const donoUnico = "GLOBAL";
  const original = engine.prefetchClamav.bind(engine);
  engine.prefetchClamav = (files, _scanId) => original(files, donoUnico);
  engine.clamavOutcomeFor = function (filePath) {
    return this.clamavPrefetches.get(donoUnico)?.files.get(ProtectionEngineService.prefetchKey(filePath));
  };
}

function novoMotor(bridge) {
  const engine = new ProtectionEngineService(TMP);
  engine.clamav = bridge;
  aplicarMutacao(engine);
  return engine;
}

/**
 * O veredicto que o runtime REAL atribuiu, pelo caminho real
 * `scanArtifact` -> `analyzer.analyze(..., clamavOutcome)`.
 *
 * `scanId` é SEMPRE explícito: sem ele o accessor de produção devolve
 * `undefined` por desenho e o teste não mede nada.
 */
async function vereditoReal(engine, file, scanId) {
  const r = await engine.scanArtifact(file, "manual", { scanId });
  const entry = r?.results?.[0];
  return entry ? { verdict: entry.verdict, rules: entry.rulesTriggered ?? [] } : null;
}

function assertMalicious(visto, msg) {
  assert.ok(visto, `${msg}: não há resultado observável`);
  assert.equal(visto.verdict, "malicious", `${msg} — obtido "${visto.verdict}", regras: ${visto.rules.join(",")}`);
  assert.ok(visto.rules.includes("known_malware"), `${msg}: a regra known_malware tem de estar presente`);
}

function assertSafe(visto, msg) {
  assert.ok(visto, `${msg}: não há resultado observável`);
  assert.equal(visto.verdict, "safe", `${msg} — obtido "${visto.verdict}", regras: ${visto.rules.join(",")}`);
  assert.ok(!visto.rules.includes("known_malware"), `${msg}: known_malware não pode aparecer`);
}

/**
 * O contrato de isolamento para um scan que foi ABORTADO (casos D e F).
 *
 * MEDIDO: com o signal de A abortado, `scanArtifact` passa esse signal ao
 * analyzer e o analyzer devolve `inconclusive` com a regra `scan_inconclusive`.
 * Isso é o comportamento HONESTO e é o que o motor documenta: o controller não
 * é apagado no abort porque o `scanFile` ainda pode estar a ler o signal.
 *
 * O que o isolamento proíbe não é o valor do veredicto: é A receber uma
 * DETECÇÃO. Por isso a asserção é `sem detecção`, não `safe` — exigir `safe`
 * aqui seria inventar um contrato que o produto não promete.
 */
function assertSemDeteccao(visto, msg) {
  assert.ok(visto, `${msg}: não há resultado observável`);
  assert.notEqual(visto.verdict, "malicious", `${msg} — obtido "${visto.verdict}"`);
  assert.ok(!visto.rules.includes("known_malware"), `${msg}: known_malware não pode aparecer (regras: ${visto.rules.join(",")})`);
}

/** Os scans têm de ter ATINGIDO a janela do prefetch, senão o resto é vazio. */
function assertAtingiuPrefetch(bridge, quantos, msg) {
  assert.equal(
    bridge.calls.length, quantos,
    `${msg}: ${quantos} scans têm de entrar no prefetch (entraram: ${JSON.stringify(bridge.calls.map((c) => c.files))})`,
  );
}

describe("P1-3 — o prefetch de um scan não pode vazar para outro", () => {
  before(() => {
    if (MUTACAO === "") return;
    const conhecidas = ["m1", "m2", "m3", "m4"];
    assert.ok(
      conhecidas.includes(MUTACAO),
      `CS_P13_MUTACAO inválida: "${MUTACAO}" (esperado: ${conhecidas.join(", ")}) — sem esta guarda, um nome errado não mutava nada e a suite passava toda a dar uma falsa segurança`,
    );
    console.log(`[P1-3] MUTAÇÃO ACTIVA: ${MUTACAO} — os testes vermelhos são a mutação a ser apanhada`);
  });

  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  });

  it("P1-3-A — isolamento básico: o veredicto de A e o de B não se cruzam", async () => {
    const bridge = bridgeControl().plan({ verdict: "detected" }).plan({ verdict: "clean" });
    const engine = novoMotor(bridge);
    const x = path.join(TMP, "A-isolamento.exe");
    await fs.writeFile(x, "conteudo", "utf8");

    // Os dois donos instalam-se e NENHUM é limpo: é a coexistência.
    await engine.prefetchClamav([x], "scanA");
    await engine.prefetchClamav([x], "scanB");
    assertAtingiuPrefetch(bridge, 2, "A e B");

    // O ficheiro limpo lê-se primeiro: um veredicto malicioso manda-o para a
    // quarentena, e a quarentena renomeia o ficheiro para fora do sítio.
    const porB = await vereditoReal(engine, x, "scanB");
    const porA = await vereditoReal(engine, x, "scanA");

    assertSafe(porB, "B tem de ler o SEU veredicto (clean), nunca o de A");
    assertMalicious(porA, "A tem de ler o SEU veredicto (detected), nunca o de B");

    // COEXISTÊNCIA, provada pelo par: se o dono de um tivesse morrido, o seu
    // veredicto seria "safe" e uma destas duas asserções rebentava.
  });

  it("P1-3-B — REGRESSÃO MAP GLOBAL: reintroduzir o bug antigo TEM de fazer este cenário vazar", async () => {
    const bridge = bridgeControl().plan({ verdict: "detected" }).plan({ verdict: "clean" });
    const engine = novoMotor(bridge);
    degradarParaMapGlobal(engine);

    const x = path.join(TMP, "B-mapglobal.exe");
    await fs.writeFile(x, "conteudo", "utf8");
    await engine.prefetchClamav([x], "scanA");
    await engine.prefetchClamav([x], "scanB");
    assertAtingiuPrefetch(bridge, 2, "A e B com o Map GLOBAL");

    // Esta asserção afirma o BUG, de propósito. Se o bug reintroduzido NÃO
    // fizesse A herdar o veredicto de B, este teste falhava — e a leitura
    // correcta seria: "o cenário do caso A deixou de distinguir a
    // implementação", ou seja, a prova voltou a ser vazia.
    const porA = await vereditoReal(engine, x, "scanA");
    assertSafe(
      porA,
      "com Map GLOBAL, A tem de HERDAR o veredicto de B (regressão reintroduzida)",
    );
  });

  it("P1-3-C — clear de A: A perde o prefetch, o ficheiro de B fica intacto", async () => {
    const bridge = bridgeControl().plan({ verdict: "detected" }).plan({ verdict: "detected" });
    const engine = novoMotor(bridge);
    const a = path.join(TMP, "C-A.exe");
    const b = path.join(TMP, "C-B.exe");
    await fs.writeFile(a, "a", "utf8");
    await fs.writeFile(b, "b", "utf8");

    await engine.prefetchClamav([a], "scanA");
    await engine.prefetchClamav([b], "scanB");
    assertAtingiuPrefetch(bridge, 2, "A e B");

    // É o que o `finally` do scan loop de A faz, pelo dono.
    engine.clearClamavPrefetch("scanA");

    const porB = await vereditoReal(engine, b, "scanB");
    assertMalicious(porB, "limpar A não pode tocar no prefetch de B — B observado POR scanId");
    const porA = await vereditoReal(engine, a, "scanA");
    assertSafe(porA, "A já não tem dono: tem de cair no caminho de um ficheiro de cada vez");
  });

  it("P1-3-D — cancel de A com o batch em voo: o veredicto tardio não volta, B continua", async () => {
    const bridge = bridgeControl().plan({ verdict: "detected", hold: true }).plan({ verdict: "detected" });
    const engine = novoMotor(bridge);
    const a = path.join(TMP, "D-A.exe");
    const b = path.join(TMP, "D-B.exe");
    await fs.writeFile(a, "a", "utf8");
    await fs.writeFile(b, "b", "utf8");

    const pendingA = engine.prefetchClamav([a], "scanA");
    await bridge.enteredAt(0); // o batch de A entrou e ficou pendente
    await engine.prefetchClamav([b], "scanB");
    assertAtingiuPrefetch(bridge, 2, "A e B");

    // Cancelar A: aborta o motor, e o `finally` do scan loop larga o dono.
    engine.abortEngineWork("scanA");
    engine.clearClamavPrefetch("scanA");

    // Só agora o clamscan de A fecha — a atribuição acontece DEPOIS do clear.
    bridge.open(0);
    const desfechoA = await pendingA;
    assert.equal(
      desfechoA.spawned, true,
      `o batch correu, foi descartado (não falhou): ${JSON.stringify(desfechoA)}`,
    );

    const porB = await vereditoReal(engine, b, "scanB");
    assertMalicious(porB, "B tem de continuar funcional depois do cancel de A");
    const porA = await vereditoReal(engine, a, "scanA");
    assertSemDeteccao(porA, "o veredicto tardio de A não pode ser reinstalado depois do clear");
  });

  it("P1-3-E — erro no prefetch de A: A fica sem veredicto e B continua inteiro", async () => {
    const bridge = bridgeControl().plan({ throws: "clamscan morreu a meio" }).plan({ verdict: "detected" });
    const engine = novoMotor(bridge);
    const a = path.join(TMP, "E-A.exe");
    const b = path.join(TMP, "E-B.exe");
    await fs.writeFile(a, "a", "utf8");
    await fs.writeFile(b, "b", "utf8");

    const desfechoA = await engine.prefetchClamav([a], "scanA");
    assert.equal(desfechoA.spawned, false, "um prefetch que falha não diz que correu");
    assert.match(desfechoA.error ?? "", /clamscan morreu a meio/, `o erro tem de ser reportado (obtido: ${desfechoA.error})`);

    await engine.prefetchClamav([b], "scanB");
    assertAtingiuPrefetch(bridge, 2, "A e B");

    const porB = await vereditoReal(engine, b, "scanB");
    assertMalicious(porB, "o erro de A não pode levar o prefetch de B com ele");
    const porA = await vereditoReal(engine, a, "scanA");
    assertSafe(porA, "A falhou o prefetch: sem veredicto próprio, tem de cair no scanFile");
  });

  it("P1-3-F — timeout de A: nada de A sobra, e B continua inteiro", async () => {
    const bridge = bridgeControl().plan({ waitAbort: true }).plan({ verdict: "detected" });
    const engine = novoMotor(bridge);
    const a = path.join(TMP, "F-A.exe");
    const b = path.join(TMP, "F-B.exe");
    await fs.writeFile(a, "a", "utf8");
    await fs.writeFile(b, "b", "utf8");

    const pendingA = engine.prefetchClamav([a], "scanA");
    await bridge.enteredAt(0); // o batch de A entrou e ficou à espera do signal
    await engine.prefetchClamav([b], "scanB");
    assertAtingiuPrefetch(bridge, 2, "A e B");

    // O signal de A aborta: é o que um clamscan morto a meio produz.
    engine.abortEngineWork("scanA");
    engine.clearClamavPrefetch("scanA");

    const desfechoA = await pendingA;
    assert.equal(desfechoA.spawned, false, "um batch abortado não diz que correu");
    assert.ok(desfechoA.error, "o timeout tem de ser reportado");

    const porB = await vereditoReal(engine, b, "scanB");
    assertMalicious(porB, "o timeout de A não pode levar o prefetch de B com ele");
    const porA = await vereditoReal(engine, a, "scanA");
    assertSemDeteccao(porA, "depois de um timeout, A não pode ter nenhuma deteção pendurada");
  });

  it("P1-3-G — cleanup de A: só o dono de A sai, e o MESMO ficheiro continua vivo em B", async () => {
    const bridge = bridgeControl().plan({ verdict: "detected" }).plan({ verdict: "detected" });
    const engine = novoMotor(bridge);
    const x = path.join(TMP, "G-partilhado.exe");
    await fs.writeFile(x, "conteudo", "utf8");

    await engine.prefetchClamav([x], "scanA");
    await engine.prefetchClamav([x], "scanB");
    assertAtingiuPrefetch(bridge, 2, "A e B");

    // A termina normalmente e o `finally` larga o DONO, não o ficheiro.
    engine.clearClamavPrefetch("scanA");

    // O mesmo path, lido por B: tem de continuar malicioso. É isto que separa
    // "limpo o dono de A" de "limpei o ficheiro que A tinha em cache".
    const porB = await vereditoReal(engine, x, "scanB");
    assertMalicious(porB, "limpar A não pode levar o path de B com ele");
    const porA = await vereditoReal(engine, x, "scanA");
    assertSafe(porA, "A perdeu o dono: sem prefetch, cai no scanFile");
  });

  it("P1-3-H — concorrência: dois batches em voo ao mesmo tempo, sem se cruzarem", async () => {
    const bridge = bridgeControl().plan({ verdict: "detected", hold: true }).plan({ verdict: "clean", hold: true });
    const engine = novoMotor(bridge);
    const x = path.join(TMP, "H-concorrencia.exe");
    await fs.writeFile(x, "conteudo", "utf8");

    const pendingA = engine.prefetchClamav([x], "scanA");
    await bridge.enteredAt(0);
    const pendingB = engine.prefetchClamav([x], "scanB");
    await bridge.enteredAt(1);

    // COEXISTÊNCIA DE VERDADE: os dois batches estão em voo ao mesmo tempo, e
    // nenhum limpou o dono do outro.
    assertAtingiuPrefetch(bridge, 2, "A e B em simultâneo");

    // Interleaving DETERMINÍSTICO: B resolve primeiro, A depois. A ordem não é
    // um sleep — é uma decisão do teste.
    bridge.open(1);
    await pendingB;
    bridge.open(0);
    await pendingA;

    const porB = await vereditoReal(engine, x, "scanB");
    const porA = await vereditoReal(engine, x, "scanA");
    assertSafe(porB, "B resolveu primeiro e tem de continuar com o veredicto dele");
    assertMalicious(porA, "A resolveu depois e tem de continuar com o veredicto dele");
  });

  it("P1-3-I — o MESMO path em dois scans: cada um lê o seu, nunca o do outro", async () => {
    const bridge = bridgeControl().plan({ verdict: "detected" }).plan({ verdict: "clean" });
    const engine = novoMotor(bridge);
    const x = path.join(TMP, "I-partilhado.exe");
    await fs.writeFile(x, "conteudo", "utf8");

    await engine.prefetchClamav([x], "scanA");
    await engine.prefetchClamav([x], "scanB");
    assertAtingiuPrefetch(bridge, 2, "A e B");

    // Os dois batches pediram EXACTAMENTE o mesmo path: a chave é o path, o
    // dono é o scanId. É esta combinação que o Map por scan tem de resolver.
    assert.deepEqual(
      bridge.calls[0].files, bridge.calls[1].files,
      "os dois scans têm de ter prefetcheado o mesmo path — é o que torna o caso forte",
    );

    // B lê primeiro: é o dono que NÃO tem detecção. Se tivesse o de A, a
    // quarentena do veredicto errado disparava e o read de A já nãoellia nada.
    const porB = await vereditoReal(engine, x, "scanB");
    const porA = await vereditoReal(engine, x, "scanA");
    assertSafe(porB, "B não pode ler o resultado de A");
    assertMalicious(porA, "A não pode ler o resultado de B");
  });

  it("P1-3-GERACAO — o mesmo dono com dois batches em voo: o resultado velho é descartado", async () => {
    const bridge = bridgeControl().plan({ verdict: "clean", hold: true }).plan({ verdict: "detected", hold: true });
    const engine = novoMotor(bridge);
    const x = path.join(TMP, "GERACAO.exe");
    await fs.writeFile(x, "conteudo", "utf8");

    // Dois prefetch do MESMO dono, em voo ao mesmo tempo. O segundo instala um
    // dono NOVO (geração 2) por baixo do primeiro — é exactamente o que a
    // generation guard distingue.
    const velho = engine.prefetchClamav([x], "scanA");
    await bridge.enteredAt(0);
    const novo = engine.prefetchClamav([x], "scanA");
    await bridge.enteredAt(1);
    assertAtingiuPrefetch(bridge, 2, "o batch velho e o novo");

    bridge.open(1);
    await novo; // geração 2: instala "detected"
    bridge.open(0);
    await velho; // geração 1: já não é a geração do dono — tem de ser descartado

    const porA = await vereditoReal(engine, x, "scanA");
    assertMalicious(
      porA,
      "o batch NOVO tem de ganhar: o velho é de uma geração que já não é a do dono",
    );
  });

  it("P1-3-REGISTO — sem scanId o prefetch nunca é consultado (a origem do falso-verde antigo)", async () => {
    const bridge = bridgeControl().plan({ verdict: "detected" });
    const engine = novoMotor(bridge);
    const x = path.join(TMP, "REGISTO.exe");
    await fs.writeFile(x, "conteudo", "utf8");

    await engine.prefetchClamav([x], "scanA");
    assertAtingiuPrefetch(bridge, 1, "A");

    // SEM scanId: é o que o 2.º teste antigo fazia. O accessor de produção
    // devolve `undefined` por desenho, e o prefetch não é consultado.
    const semDono = await engine.scanArtifact(x, "manual", {});
    const comDono = await engine.scanArtifact(x, "manual", { scanId: "scanA" });

    const regrasSemDono = semDono?.results?.[0]?.rulesTriggered ?? [];
    assert.ok(
      !regrasSemDono.includes("known_malware"),
      `sem scanId o prefetch não pode ser consultado (regras: ${regrasSemDono.join(",")})`,
    );
    assert.ok(
      (comDono?.results?.[0]?.rulesTriggered ?? []).includes("known_malware"),
      "o dono certo tem de ver a detecção: senão o accessor está errado e este ficheiro não mede nada",
    );
  });
});