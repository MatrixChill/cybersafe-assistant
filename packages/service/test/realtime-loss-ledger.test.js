import assert from "node:assert/strict";
import test from "node:test";

import { RealtimeLossLedger } from "../dist/realtime-loss.js";

/**
 * P0 C5 (15/10, fase 2) — a contagem da perda tem de dizer a VERDADE.
 *
 * Medido na sessão da C5: `realtimeDroppedEvents` chegou a 2493 e o painel chamava-lhe
 * «eventos não analisados por limite da fila». Ele misturava duas coisas sem relação:
 * tentativas de análise rejeitadas porque a fila estava cheia, e sinais de perda do
 * `fs.watch` — e ainda somava o total CUMULATIVO de cada sinal, contando a mesma perda
 * vezes o número de notificações.
 *
 * As leis que este ficheiro prende:
 *  1. cumulativo nunca se soma: o que entra é o DELTA (3 → 7 vale +4, não +10);
 *  2. as origens separam-se: fila != watcher;
 *  3. tentativas != ficheiros, e um `filename === null` do Windows não diz QUANTOS
 *     eventos se perderam — isso fica marcado como indeterminado, nunca como contagem
 *     de ficheiros perdidos nem de ficheiros analisados.
 */

test("delta, não cumulativo: sinais 3 depois 7 valem +4", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteWatcherSignal({ path: "C:/a", novos: 3, total: 3 });
  ledger.noteWatcherSignal({ path: "C:/a", novos: 4, total: 7 });
  assert.equal(ledger.watcherNamelessCallbacks, 7, `esperava 7 callbacks sem nome, obtive ${ledger.watcherNamelessCallbacks}`);
  assert.equal(ledger.watcherSignals, 2, "as NOTIFICAÇÕES contam-se à parte dos callbacks");
});

test("um sinal repetido sem delta novo não volta a contar", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteWatcherSignal({ path: "C:/a", novos: 5, total: 5 });
  ledger.noteWatcherSignal({ path: "C:/a", novos: 0, total: 5 });
  assert.equal(ledger.watcherNamelessCallbacks, 5);
  assert.equal(ledger.watcherSignals, 1, "notificação sem perda nova não é perda de observação");
});

test("origens separadas: fila cheia não aumenta a perda do watcher e vice-versa", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteQueueRejection("C:/temp/hot.dat");
  ledger.noteQueueRejection("C:/temp/hot.dat");
  ledger.noteQueueRejection("C:/outro.dat");
  ledger.noteWatcherSignal({ path: "C:/temp", novos: 2, total: 2 });

  assert.equal(ledger.queueRejections, 3, "três TENTATIVAS rejeitadas");
  assert.equal(ledger.summary().queueDistinctPaths, 2, "mas só DOIS caminhos distintos — o mesmo ficheiro reescrito não é dois ficheiros");
  assert.equal(ledger.watcherNamelessCallbacks, 2);
  assert.equal(ledger.queueDistinctPaths + ledger.watcherNamelessCallbacks !== 5, true, "somar as duas origens não faria sentido");
});

test("o teto é declarado, nunca silencioso", () => {
  const ledger = new RealtimeLossLedger({ maxPaths: 3 });
  for (let i = 0; i < 10; i++) ledger.noteQueueRejection(`C:/ficheiro-${i}`);
  assert.equal(ledger.queueRejections, 10, "as tentativas continuam a contar todas");
  assert.equal(ledger.summary().queueDistinctPaths, 3, "o registo de caminhos é limitado");
  assert.equal(ledger.summary().queuePathsCapped, true, "e o facto de ter batido no teto é dito, não escondido");
});

test("quantidade indeterminada fica marcada como indeterminada", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteWatcherSignal({ path: "C:/temp", novos: 1, total: 1 });
  const sum = ledger.summary();
  assert.equal(sum.watcherCallbacksIndeterminate, true, "o Windows não diz quantos eventos a fila perdeu");
  assert.equal(typeof sum.queueRejections, "number");
  assert.ok(!("ficheirosPerdidos" in sum), "não se inventa contagem de ficheiros perdidos");
  assert.ok(!("ficheirosAnalisados" in sum), "nada aqui autoriza dizer que ficheiros foram analisados");
});

test("contador limpa entre sessões de proteção sem perder a distinção de origens", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteQueueRejection("C:/x");
  ledger.noteWatcherSignal({ path: "C:/y", novos: 4, total: 4 });
  ledger.reset();
  assert.deepEqual(ledger.summary(), {
    queueRejections: 0,
    queueDistinctPaths: 0,
    queuePathsCapped: false,
    watcherSignals: 0,
    watcherNamelessCallbacks: 0,
    watcherCallbacksIndeterminate: false,
    raizesComPerda: [],
  });
});

test("a raiz que perdeu fica nomeada", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteWatcherSignal({ path: "C:/temp", novos: 2, total: 2 });
  ledger.noteWatcherSignal({ path: "C:/Desktop", novos: 1, total: 1 });
  ledger.noteWatcherSignal({ path: "C:/temp", novos: 3, total: 5 });
  assert.deepEqual(ledger.summary().raizesComPerda.slice().sort(), ["C:/Desktop", "C:/temp"]);
});
test("REPLAY de notificacao cumulativa repetida NAO soma (total 7, novos 4, duas vezes = 7)", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteWatcherSignal({ path: "C:/a", novos: 3, total: 3 });
  ledger.noteWatcherSignal({ path: "C:/a", novos: 4, total: 7 });
  ledger.noteWatcherSignal({ path: "C:/a", novos: 4, total: 7 });
  ledger.noteWatcherSignal({ path: "C:/a", novos: 4, total: 7 });
  assert.equal(ledger.summary().watcherNamelessCallbacks, 7, "a mesma perda cumulativa nao pode ser contada outra vez");
  assert.equal(ledger.summary().watcherSignals, 2, "so as duas notificacoes com total NOVO contam");
});

test("total FORA DE ORDEM (mais pequeno que o visto) nao sobe e nao rebenta", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteWatcherSignal({ path: "C:/a", novos: 9, total: 9 });
  ledger.noteWatcherSignal({ path: "C:/a", novos: 1, total: 3 });
  assert.equal(ledger.summary().watcherNamelessCallbacks, 9);
  assert.equal(ledger.summary().watcherSignals, 1);
});

test("LEGADO sem total: usa o delta declarado, explicitamente, sem inventar cumulativo", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteWatcherSignal({ path: "C:/a", novos: 5, total: Number.NaN });
  ledger.noteWatcherSignal({ path: "C:/a", novos: 0, total: Number.NaN });
  assert.equal(ledger.summary().watcherNamelessCallbacks, 5);
  assert.equal(ledger.summary().watcherSignals, 1, "notificacao sem perda nova nao e perda");
});

test("um total valido NUNCA e anulado por um fallback de novos", () => {
  const ledger = new RealtimeLossLedger();
  ledger.noteWatcherSignal({ path: "C:/a", novos: 100, total: 4 });
  assert.equal(ledger.summary().watcherNamelessCallbacks, 4, "o cumulativo manda; os 100 so valeriam sem total");
});
