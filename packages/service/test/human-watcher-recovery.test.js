import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtectionEngineService } from "../dist/engine.js";
import { RealtimeRecovery } from "../dist/realtime-recovery.js";

/**
 * Regressão INTEGRADA dos seams de tempo real, sem watcher e sem proteção real.
 *
 * porque prototype call: `handleFileObservation` e `reportRealtimeOverflow`
 * são privados e só precisam de um `this` com os campos que lêem. Instanciar o
 * motor ligaria watchers/ClamAV/CIM — proibido aqui e inútil para o que se
 * prova. Nada nesta ficha abre um watcher nem corre um scan.
 *
 * O que trava regressão é a COSTURA entre os dois módulos: a rejeição de
 * admissão tem de agendar uma retoma, deduplicar por caminho, não encadear
 * novas retomas a partir de uma retoma falhada, abortar leituras tardias e
 * limpar quando a proteção pára.
 */
const handleFileObservation = ProtectionEngineService.prototype["handleFileObservation"];
const reportRealtimeOverflow = ProtectionEngineService.prototype["reportRealtimeOverflow"];

function costura({ leitura = null, enqueue = "accepted", reads = 0 } = {}) {
  const recovery = new RealtimeRecovery();
  const eventos = [];
  const e = {
    protectionState: true,
    isShuttingDown: false,
    protectionGeneration: 1,
    fileObservationReads: reads,
    backgroundAbort: new AbortController(),
    realtimeQueue: { size: 0, clear: () => {}, enqueue: (...args) => { eventos.push(["enqueue", args[0]]); return enqueue; } },
    realtimeRecovery: recovery,
    loss: { noteQueueRejection: () => {}, summary: () => ({ queueRejections: 0, queueDistinctPaths: 0, queuePathsCapped: false }) },
    eventBus: { publish: (...args) => eventos.push(["publish", args[1], args[3]?.admissionStage]) },
    publishInconclusiveFile: () => { eventos.push(["inconclusive"]); },
    overflowNoticeAt: 0,
    realtimeDroppedEvents: 0,
    exclusions: { isExcluded: () => false },
    scanArtifact: async () => leitura,
    reportRealtimeOverflow: (caminho, stage, retry) => reportRealtimeOverflow.call(e, caminho, stage, retry),
  };
  const chamar = (filePath, retry = false, signal) =>
    handleFileObservation.call(e, filePath, retry, signal);
  return { e, recovery, chamar, eventos };
}

test("saturação de metadata: rejeita a admissão e agenda UMA retoma", async () => {
  const { e, recovery, chamar, eventos } = costura({ reads: 64 });
  const aceite = await chamar("C:/temp/a.txt");
  assert.equal(aceite, false, "metadata cheia não pode dizer que a observação foi tratada");
  assert.equal(recovery.snapshot().pending, 1, "a primeira rejeição tem de agendar retoma");
  assert.deepEqual(eventos.filter(x => x[0] === "enqueue"), [], "não se pode enfileirar análise sem metadados");
  assert.equal(e.fileObservationReads, 64, "o budget de leituras em voo não pode crescer");
});

test("rejeições repetidas do mesmo caminho deduplicam numa só retoma", async () => {
  const { recovery, chamar } = costura({ reads: 64 });
  await chamar("C:/temp/b.txt");
  await chamar("C:/temp/b.txt");
  await chamar("C:/temp/b.txt");
  assert.equal(recovery.snapshot().pending, 1, "3 rejeições do mesmo caminho não são 3 cadeias");
});

test("fila de análise cheia: rejeita na fase analysis e agenda retoma", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-watcher-"));
  const ficheiro = path.join(dir, "real.txt");
  await fs.writeFile(ficheiro, "conteudo", "utf8");
  const { recovery, chamar, eventos } = costura({ enqueue: "full" });
  const aceite = await chamar(ficheiro);
  assert.equal(aceite, false);
  assert.equal(recovery.snapshot().pending, 1);
  assert.ok(eventos.some(x => x[0] === "enqueue"), "a fase analysis só é alcançada depois de lstat");
  await fs.rm(dir, { recursive: true, force: true });
});

test("uma retoma que falha não cria outra retoma (sem cadeia infinita)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-watcher-"));
  const ficheiro = path.join(dir, "real.txt");
  await fs.writeFile(ficheiro, "conteudo", "utf8");
  const { e, recovery } = costura({ enqueue: "full" });
  // Estado de uma retoma já em curso: é o que o defer() passa ao callback.
  e.fileObservationReads = 0;
  const aceite = await handleFileObservation.call(e, ficheiro, true, new AbortController().signal);
  assert.equal(aceite, false, "a retry falhada reporta que não conseguiu admissão");
  assert.equal(recovery.snapshot().pending, 0, "retry falhada não pode agendar mais uma retoma");
  assert.ok(recovery.snapshot().analysisRejections >= 1, "a recusa da retry fica contada como rejeição");
  await fs.rm(dir, { recursive: true, force: true });
});

test("leitura tardia abortada não lê nem enfileira; conta como tratada", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-watcher-"));
  const ficheiro = path.join(dir, "real.txt");
  await fs.writeFile(ficheiro, "conteudo", "utf8");
  const controlador = new AbortController();
  controlador.abort();
  const { chamar, eventos } = costura();
  const aceite = await chamar(ficheiro, true, controlador.signal);
  assert.equal(aceite, true, "um sinal abortado é um trabalho encerrado, não um trabalho por fazer");
  assert.deepEqual(eventos.filter(x => x[0] === "enqueue"), [], "nunca enfileirar leitura tardia abortada");
  await fs.rm(dir, { recursive: true, force: true });
});

test("admissão aceite: observa, faz lstat e enfileira sem rejeições", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-watcher-"));
  const ficheiro = path.join(dir, "bom.txt");
  await fs.writeFile(ficheiro, "conteudo", "utf8");
  const { recovery, chamar, eventos } = costura();
  const aceite = await chamar(ficheiro);
  assert.equal(aceite, true);
  assert.ok(eventos.some(x => x[0] === "enqueue" && path.isAbsolute(x[1])), "o caminho enfileirado é canónico");
  assert.equal(recovery.snapshot().pending, 0, "sem rejeição não há retoma pendente");
  await fs.rm(dir, { recursive: true, force: true });
});

test("parar a proteção limpa as retomas pendentes", async () => {
  const { e, recovery } = costura({ reads: 64 });
  await handleFileObservation.call(e, "C:/temp/c.txt");
  assert.equal(recovery.snapshot().pending, 1);
  // Mesma sequência do patch: stopProtection() tem de esvaziar a retoma.
  const stop = ProtectionEngineService.prototype["stopProtection"];
  Object.assign(e, {
    updater: { stopScheduler: () => {} },
    watcher: { stop: async () => {} },
    processMonitor: { stop: async () => {} },
    etwConsumer: { stop: async () => {} },
    amsiProvider: { stop: async () => {} },
    wfpFilter: { stop: async () => {} },
    publishProtectionChanged: () => {},
    protectionPausedUntil: null,
    protectionResumeTimer: null,
    networkTimer: null,
    protectionTransition: null,
    realtimeDroppedEvents: 0,
  });
  e.loss.reset = () => {};
  e.loss.summary = () => ({ queueRejections: 0, queueDistinctPaths: 0, queuePathsCapped: false, watcherCallbacksIndeterminate: false });
  const resultado = await stop.call(e);
  assert.equal(resultado.protectionEnabled, false);
  assert.equal(recovery.snapshot().pending, 0, "retomas pendentes não podem sobreviver a um OFF");
});
