import type { RealtimeLossSummary } from "@cybersafe/shared-types";

/**
 * Livro de perdas do tempo real (P0 C5, 15/10).
 *
 * Existe porque um número só chegou ao ecrã a dizer duas coisas diferentes ao mesmo
 * tempo: em Windows físico mediram-se 2 493 «eventos não analisados por limite da
 * fila» quando aquela conta somava (a) tentativas de análise rejeitadas por fila
 * cheia e (b) sinais de perda do `fs.watch`, e somava (b) pelo TOTAL CUMULATIVO de
 * cada notificação — a mesma perda contada tantas vezes como notificações.
 *
 * Três leis, e são elas que este módulo existe para garantir:
 *  1. cumulativo nunca se soma: entra o DELTA por raiz;
 *  2. fila e watcher são origens separadas e nunca se misturam num só número;
 *  3. um callback sem `filename` não diz QUANTOS eventos se perderam — e nem prova
 *     que se perdeu algum: o Node não garante `filename` em Windows, e a prova de
 *     transbordo do ReadDirectoryChangesW (`lpBytesReturned` zero) não é exposta
 *     aqui. Conta-se NOTIFICAÇÕES SEM NOME e marca-se a quantidade como
 *     indeterminada. Não se afirma «N ficheiros perdidos», «perda confirmada pelo
 *     SO», e nada aqui autoriza a dizer que algum ficheiro foi analisado.
 */

export interface PerdaWatcherInput {
  path: string;
  novos: number;
  total: number;
}

export class RealtimeLossLedger {
  private readonly maxPaths: number;
  private readonly paths = new Set<string>();
  private readonly ultimosTotais = new Map<string, number>();
  private readonly raizes = new Set<string>();
  queueRejections = 0;
  queuePathsCapped = false;
  watcherSignals = 0;
  watcherNamelessCallbacks = 0;
  private indeterminado = false;

  constructor(opcoes: { maxPaths?: number } = {}) {
    this.maxPaths = opcoes.maxPaths ?? 5_000;
  }

  /** Uma TENTATIVA de análise que não entrou na fila. O mesmo ficheiro a ser
      reescrito conta como tentativa outra vez, mas não como ficheiro novo. */
  noteQueueRejection(caminho: string): void {
    this.queueRejections += 1;
    const chave = caminho.toLowerCase();
    if (this.paths.has(chave)) return;
    if (this.paths.size < this.maxPaths) this.paths.add(chave);
    else this.queuePathsCapped = true;
  }

  /** Um sinal de perda vindo do watcher. Só conta perda NOVA (delta por raiz). */
  noteWatcherSignal({ path, novos, total }: PerdaWatcherInput): void {
    const anterior = this.ultimosTotais.get(path) ?? 0;
    const novosNum = Math.max(0, Number(novos) || 0);
    if (Number.isFinite(total)) {
      // O total por raiz é a única verdade cumulativa. Replay (total repetido) e
      // ordem invertida (total mais pequeno) NÃO somam — foi assim que a C5 chegou
      // a 2 493: a mesma perda era contada outra vez em cada notificação.
      if (total <= anterior) return;
      this.ultimosTotais.set(path, total);
      this.conta(path, total - anterior);
      return;
    }
    // Sem total (lado do pipe que ainda só sabe enviar `novos`): fallback
    // EXPLÍCITO para o delta declarado. Não se inventa cumulativo, e este ramo
    // não pode anular a deduplicação do ramo acima quando um total válido existe.
    if (novosNum === 0) return;
    this.conta(path, novosNum);
  }

  private conta(path: string, valor: number): void {
    this.watcherSignals += 1;
    this.watcherNamelessCallbacks += valor;
    this.indeterminado = true;
    if (path) this.raizes.add(path);
  }

  summary(): RealtimeLossSummary {
    return {
      queueRejections: this.queueRejections,
      queueDistinctPaths: this.paths.size,
      queuePathsCapped: this.queuePathsCapped,
      watcherSignals: this.watcherSignals,
      watcherNamelessCallbacks: this.watcherNamelessCallbacks,
      watcherCallbacksIndeterminate: this.indeterminado,
      raizesComPerda: [...this.raizes],
    };
  }

  reset(): void {
    this.queueRejections = 0;
    this.queuePathsCapped = false;
    this.paths.clear();
    this.ultimosTotais.clear();
    this.raizes.clear();
    this.watcherSignals = 0;
    this.watcherNamelessCallbacks = 0;
    this.indeterminado = false;
  }
}
