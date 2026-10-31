import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NativeWindowsWatcher } from "../dist/index.js";

/**
 * P0 (15/10, verificação independente do OpenCode) — o lugar onde a app afirmava
 * cobertura que não existe.
 *
 * Medido por eles: o filho reportava as raízes cujo attach falhou, o pai
 * reenviava isso no evento `ready`, e NINGUÉM subscrevia `ready` — o aviso morria
 * ali. `getMonitoredPaths()` devolvia então todas as `validatedPaths`, e a saúde
 * publicava na UI caminhos que nunca ficaram vigiados. O docstring da própria
 * função diz que uma path descartada não deve aparecer; era exatamente o que
 * acontecia.
 *
 * A prova é feita na fronteira onde a mentira saía: o watcher agregado. O duplo
 * marca como falhada uma raiz QUE LHE FOI ENTREGUE — é assim que o filho real
 * trabalha (reporta o eco exato do que recebeu), e assim o teste não depende da
 * forma normalizada dos caminhos em Windows.
 */

function vigiaEstubada({ falharIndex = -1, motivo = "raiz-inacessivel" } = {}) {
  const vigia = new EventEmitter();
  const estado = { entregues: null };
  vigia.start = async (paths) => {
    estado.entregues = [...paths];
    if (falharIndex >= 0 && paths[falharIndex]) {
      vigia.emit("coverage", {
        motivo,
        path: paths[falharIndex],
        message: `attach falhou em ${paths[falharIndex]}`,
        eventosSemNome: 0,
      });
    }
  };
  vigia.stop = async () => undefined;
  return { vigia, estado };
}

async function cenario(t, opcoes) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-monitored-paths-"));
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  await fs.mkdir(a);
  await fs.mkdir(b);
  const { vigia, estado } = vigiaEstubada(opcoes);
  const w = new NativeWindowsWatcher(() => vigia);
  t.after(async () => {
    // O agregado arma um timer de registo de 30 s: sem `stop()`, o `node --test`
    // fica com handles abertos e nunca fecha.
    await w.stop().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });
  return { a, b, w, vigia, estado };
}

test("raiz com attach falhado NAO aparece como vigiada", async (t) => {
  const { a, b, w, estado } = await cenario(t, { falharIndex: 1 });
  await w.start([a, b]);

  assert.equal(estado.entregues?.length, 2, "pré-condição: as duas raízes chegaram ao filho");
  const vigiadas = w.getMonitoredPaths();
  assert.equal(vigiadas.length, 1, `a UI ia afirmar que vigia ${vigiadas.length} raízes; só uma attachou`);
  assert.equal(vigiadas[0], estado.entregues[0]);
  assert.notDeepEqual(vigiadas, estado.entregues, "a lista de vigiadas não pode ser o eco do que foi pedido");
  const degradadas = w.getDegradedCoverage();
  assert.deepEqual(Object.keys(degradadas), [estado.entregues[1]]);
  assert.equal(degradadas[estado.entregues[1]], "raiz-inacessivel");
});

test("sem falhas, a cobertura afirmada é a cobertura pedida", async (t) => {
  const { a, b, w } = await cenario(t, {});
  await w.start([a, b]);
  assert.deepEqual(w.getMonitoredPaths().slice().sort(), [a, b].sort());
  assert.deepEqual(w.getDegradedCoverage(), {});
});

test("raiz que morre em runtime sai da lista de vigiadas", async (t) => {
  const { a, b, w, vigia, estado } = await cenario(t, {});
  await w.start([a, b]);
  assert.equal(w.getMonitoredPaths().length, 2, "pré-condição: as duas raízes contam-se como vigiadas");

  const morta = estado.entregues[0];
  vigia.emit("coverage", { motivo: "raiz-desaparecida", path: morta, message: "deixou de existir", eventosSemNome: 0 });

  assert.deepEqual(w.getMonitoredPaths(), [estado.entregues[1]], "uma raiz apagada em runtime não pode continuar na cobertura");
  assert.equal(w.getDegradedCoverage()[morta], "raiz-desaparecida");
});

test("degradação é anunciada como evento próprio, nunca como erro", async (t) => {
  const { a, b, w, vigia, estado } = await cenario(t, {});
  const erros = [];
  const coberturas = [];
  w.on("watcher.error", () => erros.push(1));
  w.on("watcher.coverage", (info) => coberturas.push(info));
  await w.start([a, b]);

  vigia.emit("coverage", {
    motivo: "overflow",
    path: estado.entregues[1],
    message: "fila transbordou",
    eventosSemNome: 7,
  });

  assert.equal(coberturas.length, 1);
  assert.equal(coberturas[0].motivo, "overflow");
  assert.equal(coberturas[0].path, estado.entregues[1]);
  assert.equal(erros.length, 0, "cobertura degradada pelo canal de erro derrubaria a proteção inteira");
});
/**
 * P0 C5 fase 2 — a exclusao de uma raiz pelo validador tambem e perda de
 * cobertura, e tem de ser DITA antes do ready com o motivo real. Medido na C5:
 * o painel mostrou 4 raizes quando foram pedidas 6, e a unica coisa que existia
 * era um console.warn que nao chega a lado nenhum.
 */
test("raiz excluida na validacao emite coverage com o motivo real, antes do start", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-validacao-"));
  const viva = path.join(base, "viva");
  await fs.mkdir(viva);
  const morta = path.join(base, "nao-existe");
  const ordem = [];
  const vigia = new EventEmitter();
  vigia.start = async (paths) => { ordem.push(`start:${paths.join("|")}`); };
  vigia.stop = async () => undefined;
  const w = new NativeWindowsWatcher(() => vigia);
  const coberturas = [];
  w.on("watcher.coverage", (i) => coberturas.push(i));
  t.after(async () => {
    await w.stop().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });

  await w.start([viva, morta]);

  assert.equal(coberturas.length, 1, "a raiz rejeitada tinha de ser anunciada");
  assert.equal(coberturas[0].motivo, "raiz-excluida-validacao");
  assert.equal(coberturas[0].code, "ENOENT", "o motivo tem de ser a razao real, nao um generico");
  assert.equal(coberturas[0].path, morta);
  assert.deepEqual(vigia.start ? ordem : [], [`start:${viva}`], "so a raiz viva chega ao filho");
  assert.deepEqual(w.getMonitoredPaths(), [viva]);
});

test("validacao nao re-adiciona raiz que nao esta a ser vigiada", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-validacao2-"));
  const viva = path.join(base, "viva");
  await fs.mkdir(viva);
  const vigia = new EventEmitter();
  vigia.start = async () => undefined;
  vigia.stop = async () => undefined;
  const w = new NativeWindowsWatcher(() => vigia);
  t.after(async () => {
    await w.stop().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });
  await w.start([viva]);
  assert.deepEqual(w.getMonitoredPaths(), [viva]);
  assert.equal(w.getMonitoredPaths().length, 1, "a lista nao pode crescer com raizes que ninguem vigia");
});
