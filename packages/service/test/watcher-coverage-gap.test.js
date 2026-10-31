import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P0 WATCHER (15/10, verificação independente do OpenCode) — um buraco de
 * cobertura NÃO pode ser tratado como falha do motor.
 *
 * A distinção é o que está em jogo: `watcher.error` no engine faz
 * `stopProtection()` (perda de vigilância = proteção a cair). Um `gap` — fila do
 * Windows transbordada, ou uma raiz apagada em runtime — tem de ser DEGRADAÇÃO
 * VISÍVEL com a proteção a continuar ativa nas restantes pastas. Se este teste
 * passar a falhar porque alguém "simplificou" o gap para erro, a app volta a
 * desligar-se sozinha por uma pasta que deixou de existir.
 *
 * Fixture espelha protection-background-off.test.js / realtime-activation-cause
 * (mesmos seams comprovados, sem watcher/ETW reais, dispose sempre).
 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-coverage-gap-"));
  const e = new ProtectionEngineService(dir);
  for (const part of ["watcher", "processMonitor", "etwConsumer", "wfpFilter", "amsiProvider"]) {
    e[part].start = async () => {};
    e[part].stop = async () => {};
  }
  e.updater.startScheduler = () => {};
  e.updater.stopScheduler = () => {};
  e.processMonitor.list = async () => [];
  e.hardware.getSnapshot = async () => ({});
  e.refreshConnections = async () => {};
  // O fixture não passa por `init()` (pesado e cheio de handles reais), por isso as
  // duas ligações são instaladas à mão: a mesma que põe os eventos no histórico
  // (`bindEventBus`) e a que liga o watcher ao motor (`bindWatchers`, engine.ts:618).
  // É exatamente este par que tem de sobreviver — é ele que transforma um gap do
  // filho num aviso que o utilizador vê.
  e.bindEventBus();
  e.bindWatchers();
  t.after(async () => {
    await e.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });
  return { e, dir };
}

test("gap de cobertura: protecao CONTINUA ativa, contador sobe, evento visivel", async (t) => {
  const { e } = await fixture(t);
  const arrancou = await e.startProtection();
  assert.equal(arrancou.ok, true, "pré-condição: proteção ativa");

  e.watcher.emit("watcher.coverage", {
    motivo: "overflow",
    path: "C:\\Users\\<utilizador>\\Desktop",
    message: "a janela de vigilância transbordou (41 eventos sem nome)",
    eventosSemNome: 41,
  });

  assert.equal(e.protectionState, true, "degradacao de cobertura NUNCA derruba a protecao");
  const health = e.events.filter((ev) => ev.type === "engine.health" && ev.data?.reason === "watcher-coverage");
  assert.equal(health.length, 1, `esperava um aviso de cobertura, vi ${health.length}`);
  assert.equal(health[0].severity, "high", "cobertura perdida é visível, não discreta");
  assert.match(String(health[0].summary), /análise manual/, "a frase tem de dizer o que o utilizador pode fazer");
  /* 15/10, revisão de arquitetura: um callback sem nome NÃO prova transbordo do
     ReadDirectoryChangesW (o Node não garante `filename`; a prova é
     `lpBytesReturned` zero e não é exposta). A frase tem de dizer o que se viu —
     notificações sem nome, pasta nomeada, quantidade de ficheiros em aberto — e
     tem de recusar o que não se sabe. */
  assert.match(String(health[0].summary), /notificações sem nome/, `resumo vago: ${health[0].summary}`);
  assert.match(String(health[0].summary), /Desktop/, "a pasta em causa tem de ser nomeada");
  assert.match(String(health[0].summary), /não se sabe quantos/, `quantidade chumbada em certeza: ${health[0].summary}`);
  assert.doesNotMatch(String(health[0].summary), /perdidos|transbordou/, `o resumo afirma perda provada: ${health[0].summary}`);
  assert.equal(health[0].data?.watcherNamelessCallbacks >= 41, true, "os sinais sem nome têm de ser contados");
  assert.equal(health[0].data?.indeterminado, true, "a quantidade de ficheiros afetados é desconhecida, e diz-se");
});

test("raiz desaparecida em runtime: aviso nomeia a pasta e nao ha teardown", async (t) => {
  const { e } = await fixture(t);
  await e.startProtection();
  const paragens = [];
  const original = e.stopProtection.bind(e);
  e.stopProtection = async (...args) => {
    paragens.push("stopProtection");
    return original(...args);
  };

  e.watcher.emit("watcher.coverage", {
    motivo: "raiz-desaparecida",
    path: "C:\\Users\\<utilizador>\\Downloads",
    message: "C:\\Users\\<utilizador>\\Downloads deixou de existir",
    eventosSemNome: 0,
  });

  assert.deepEqual(paragens, [], "nenhuma raiz que desapareceu pode fechar a proteção inteira");
  assert.equal(e.protectionState, true);
  const aviso = e.events.filter((ev) => ev.type === "engine.health" && ev.data?.motivo === "raiz-desaparecida");
  assert.equal(aviso.length, 1);
  assert.match(String(aviso[0].summary), /Downloads/, "tem de dizer QUAL pasta deixou de estar vigiada");
  assert.match(String(aviso[0].summary), /deixou de estar vigiada|desapareceu/);
});

test("25 sinais CRESCENTES dao 1 aviso, mas a contagem cresce ate ao total real", async (t) => {
  const { e } = await fixture(t);
  await e.startProtection();
  for (let i = 1; i <= 25; i++) {
    // total cumulativo a crescer (2 por sinal): e o que o filho manda depois do
    // fix — um replay do MESMO total nao e perda nova, e estava a inflar o numero.
    e.watcher.emit("watcher.coverage", { motivo: "overflow", path: "C:/a", message: `sinal ${i}`, novos: 2, total: i * 2 });
  }
  const avisos = e.events.filter((ev) => ev.type === "engine.health" && ev.data?.reason === "watcher-coverage");
  assert.equal(avisos.length, 1, "25 sinais nao podem produzir 25 avisos iguais na UI");
  const resumo = e.loss.summary();
  assert.equal(resumo.watcherNamelessCallbacks, 50, `a contagem tem de chegar ao cumulativo real (recebi ${resumo.watcherNamelessCallbacks})`);
  assert.equal(resumo.watcherSignals, 25, "cada sinal com total NOVO e uma notificacao contada");
  assert.equal(resumo.queueRejections, 0, "nada disto foi rejeicao de fila");
  assert.equal(avisos.at(-1).data?.indeterminado, true, "o Windows nao diz quantos ficheiros ficaram por ver");
});

test("REPLAY do mesmo total cumulativo nao volta a contar (a inflao medida na C5)", async (t) => {
  const { e } = await fixture(t);
  await e.startProtection();
  for (let i = 0; i < 25; i++) {
    e.watcher.emit("watcher.coverage", { motivo: "overflow", path: "C:/a", message: "mesmo total", novos: 2, total: 2 });
  }
  const resumo = e.loss.summary();
  assert.equal(resumo.watcherNamelessCallbacks, 2, `a mesma perda contada 25 vezes: ${resumo.watcherNamelessCallbacks}`);
  assert.equal(resumo.watcherSignals, 1);
});

test("REGRESSAO C5: gaps cumulativos 3 -> 7 somam +4, nao +10, e nao tocam na fila", async (t) => {
  const { e } = await fixture(t);
  await e.startProtection();
  const antes = Number(e.realtimeDroppedEvents);
  e.watcher.emit("watcher.coverage", { motivo: "overflow", path: "C:/a", message: "sinais", novos: 3, total: 3 });
  e.watcher.emit("watcher.coverage", { motivo: "overflow", path: "C:/a", message: "sinais", novos: 4, total: 7 });
  const resumo = e.loss.summary();
  assert.equal(resumo.watcherNamelessCallbacks, 7, `o acumulativo foi somado outra vez: ${resumo.watcherNamelessCallbacks}`);
  assert.equal(resumo.watcherSignals, 2);
  assert.equal(resumo.watcherCallbacksIndeterminate, true, "o Windows nao diz quantos eventos se perderam");
  assert.equal(Number(e.realtimeDroppedEvents), antes, "perda do watcher nao e rejeicao de fila — os contadores nao se misturam");
});

test("REGRESSAO C5: rejeicoes de fila contam tentativas e caminhos distintos a parte", async (t) => {
  const { e } = await fixture(t);
  e.reportRealtimeOverflow("C:/temp/hot.dat");
  e.reportRealtimeOverflow("C:/temp/hot.dat");
  e.reportRealtimeOverflow("C:/outro.dat");
  const resumo = e.loss.summary();
  assert.equal(resumo.queueRejections, 3);
  assert.equal(resumo.queueDistinctPaths, 2, "o mesmo ficheiro reescrito nao e dois ficheiros");
  assert.equal(resumo.watcherNamelessCallbacks, 0);
});
