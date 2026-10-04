/**
 * CLAM DATABASE GATE — P1-1.
 *
 * A CORRIDA QUE ESTE FICHEIRO EXISTE PARA FECHAR, E POR QUE UM CHECK NÃO CHEGA:
 *
 * O scan passa `--database=<defs>/clamav` ao clamscan e o freshclam escreve no
 * MESMO directório. Um `isDatabaseSwapping()` consultado no início do scan é um
 * CHECK SEPARADO DO USO — e um check separado do uso não fecha nada:
 *
 *   scan lê `false`  →  (await, gap)  →  freshclam arranca  →  scan entra na DB
 *   scan já activo    →  freshclam arranca por cima dele
 *
 * O que fecha a corrida bidireccional é um ÚNICO ponto de decisão, consultado
 * com a mesma autoridade pelos dois lados. Aqui esse ponto é a aquisição da
 * lease: o scan não pode chegar ao `--database=` sem a ter, e o update não pode
 * escrever sem que ninguém a tenha.
 *
 * ── Porquê isto NÃO é um mutex genérico ──────────────────────────────────────
 * Porque não é reentrante, não tem variáveis de condição, não tem timeout genérico
 * e não serializa mais nada do serviço. Serializa exactamente uma coisa: a
 * base de assinaturas do ClamAV. Um motor de scan e um actualizador de
 * assinaturas, num runtime de JavaScript de thread única. Tudo o resto do
 * serviço continua a correr em paralelo — e é isso que o torna barato.
 *
 * ── Porque o Node é o que torna isto POSSÍVEL ────────────────────────────────
 * Numa linguagem com threads, `check` e `increment` separados por duas
 * linhas são uma corrida. Aqui não: o JS de thread única executa o método de
 * `tryAcquireScanLease()` INTEIRO sem interrupção — não há await dentro dele,
 * não há callback, não há nada a que o runtime possa ceder o controlo. O `if`
 * e o `activeScans++` são, para o runtime, a mesma instrução.
 *
 * ── As duas direcções, e o que cada uma impede ───────────────────────────────
 *  A) update pendente ou activo  →  `tryAcquireScanLease()` devolve `null`.
 *     Nenhum scan novo começa. A base não está em metamorfose, ou vai estar.
 *
 *  B) `beginUpdate()` regista o pedido ANTES do primeiro await — e é esse
 *     registo que fecha a janela "o update pediu entre o check e o uso do
 *     scan" — e só depois espera `activeScans === 0`. Um scan que já tinha
 *     lease bloqueia o freshclam até libertar.
 *
 * ── O QUE O CODEX ENCONTROU, E O QUE MUDOU NESTE FICHEIRO ────────────────────
 * A primeira versão modelava o lado do update com DOIS BOOLEANOS
 * (`updatePending`, `updateActive`) e um contador (`updateDepth`). Booleanos
 * dizem que há um update a decorrer; não dizem QUEM o tem. O Codex reproduziu,
 * executando o código, quatro consequências:
 *
 *  1. Dois pedidos que aguardam a MESMA drenagem recebiam ambos `true`. Ambos
 *     passavam pelo `if (this.updateActive)` enquanto este era falso, ambos
 *     acordavam com a mesma libertação, e ambos autorizavam escrita — dois
 *     freshclam na mesma base. Um contador sem exclusão não é exclusão.
 *  2. Um pedido que expirava o orçamento chamava `endUpdate()`, que punha
 *     `updateActive = false` sem distinguir o dono: desligava o update VIVO.
 *  3. A passagem de vez deixava uma janela. `endUpdate()` acordava um
 *     waiter, mas acordar uma promise NÃO é correr o waiter: ele só retoma
 *     numa microtarefa. Nesse intervalo `updateActive` já era falso e um
 *     `beginUpdate()` novo entrava — e o waiter acordado entrava à também.
 *  4. `reset()` limpava o estado, mas uma continuação JÁ SUSPENSA no drain
 *     (o `await` do `beginUpdate`) retomava depois e repunha `updateActive`,
 *     autorizando um spawn depois do shutdown.
 *
 * A correcção é a mesma nos quatro casos e é uma só ideia: a posse passa a ser
 * um TOKEN, não um booleano. `owner` é o pedido que tem a vez. A passagem de
 * vez é SÍNCRONA e RESERVA antes de resolver, o que fecha o 3. O pedido que
 * desiste é removido pelo seu próprio token, o que fecha o 2. E a posse é
 * reconfirmada depois de cada `await`, o que fecha o 4.
 */

/** Motivo pelo qual uma lease foi recusada. Entra no diagnóstico do scan. */
export type LeaseDenialReason = "update-pending" | "update-active";

/**
 * A lease de um scan sobre a base de assinaturas.
 *
 * `release` é IDEMPOTENTE e nunca deixa o contador abaixo de zero. Um duplo
 * release (um `finally` e um `abort`, por exemplo) tem de ser inofensivo: o
 * contador errado permitiria a um scan `N+1` entrar sem o `N` ter saído, que é
 * exactamente a classe de bug que este ficheiro existe para fechar.
 */
export interface ClamDatabaseLease {
  /** Liberta a lease. Idempotente. Seguro em `finally`. */
  release(): void;
  /** `true` quando esta lease já foi libertada. */
  readonly released: boolean;
}

/** Resultado de pedir uma lease: a lease, ou o motivo da recusa. */
export type LeaseAttempt = { ok: true; lease: ClamDatabaseLease } | { ok: false; reason: LeaseDenialReason };

/**
 * A posse de um update sobre a base. `release` é idempotente pelo mesmo motivo
 * que o da lease do scan: um duplo `release` desligaria a posse do update
 * SEGUINTE, que já a tinha recebido por passagem de vez.
 */
export interface ClamDatabaseUpdateLease {
  /** Devolve a posse. Idempotente. Seguro em `finally`. */
  release(): void;
  /** `true` quando a posse já foi devolvida. */
  readonly released: boolean;
}

export interface ClamDatabaseGateState {
  /** Scans com lease viva — a ler ou a usar a base. */
  activeScans: number;
  /** Um update foi pedido e ainda não acabou. */
  updatePending: boolean;
  /** O freshclam está a correr. */
  updateActive: boolean;
  /** Pedidos de update a aguardar a vez. Diagnóstico. */
  updateWaiters: number;
}

export interface ClamDatabaseGateOptions {
  /**
   * Orçamento para os scans activos drenarem, em ms. Default: 30 s.
   *
   * Medido: um clamscan carrega a base em ~6,2 s e um batch legítimo pode
   * chegar a minutos. 30 s drena o caso comum e recusa o caso patológico,
   * que é o que se quer: melhor adiar a actualização do que matar um scan.
   */
  drainBudgetMs?: number;
}

const DEFAULT_DRAIN_BUDGET_MS = 30_000;

/**
 * Um pedido de update, e a sua identidade. É o token de posse: sem ele não há
 * como distinguir "o update que está a escrever" de "o update que espera a vez",
 * e é essa distinção que os quatro bugs do Codex exigiam.
 */
interface UpdateRequest {
  /** Este pedido tem a vez. Só um pode. */
  granted: boolean;
  /** A promise de posse já resolveu — não se pode resolver duas vezes. */
  settled: boolean;
  /** Temporizador de espera pela vez, para limpar se o pedido desistir antes. */
  timer?: ReturnType<typeof setTimeout>;
  resolveGrant(ok: boolean): void;
}

export class ClamDatabaseGate {
  /**
   * Scans com lease viva.
   *
   * Só é tocado em `tryAcquireScanLease` e no `release` de uma lease, e ambos são
   * MÉTODOS SÍNCRONOS. É por isso que o número nunca fica errado: não há await
   * entre a leitura e a escrita, portanto nenhum outro código corre no meio.
   */
  private activeScans = 0;
  /** Quem tem a vez. É a ÚNICA fonte de `updateActive`. */
  private owner: UpdateRequest | null = null;
  /** Quem espera a vez, por ordem de chegada. */
  private queue: UpdateRequest[] = [];
  /** Todo o pedido em curso, dono ou não. É a fonte de `updatePending`. */
  private requests = new Set<UpdateRequest>();
  /** O serviço está a sair. Depois disto nada adquire posse nova. */
  private disposed = false;
  /** Quem está à espera de `activeScans === 0`. */
  private drainWaiters: Array<(drained: boolean) => void> = [];
  readonly drainBudgetMs: number;

  constructor(options: ClamDatabaseGateOptions = {}) {
    this.drainBudgetMs = options.drainBudgetMs ?? DEFAULT_DRAIN_BUDGET_MS;
  }

  // ── Lado do SCAN ───────────────────────────────────────────────────────────

  /**
   * Tenta entrar. SÍNCRONO DE PROPÓSITO — é a peça que fecha o TOCTOU.
   *
   * O `if` e o `activeScans++` correm sem interrupção: o runtime de JS não pode
   * ceder o controlo aqui, porque não há await, nem callback, nem promessa. Um
   * update que comece "ao mesmo tempo" ou já viu um pedido registado e foi
   * recusado, ou ainda não o registou e vai ver o `activeScans` já incrementado.
   * Não existe terceira hipótese — e era a terceira hipótese que o check
   * separado do uso deixava passar.
   */
  tryAcquireScanLease(): LeaseAttempt {
    if (this.owner !== null) return { ok: false, reason: "update-active" };
    if (this.requests.size > 0) return { ok: false, reason: "update-pending" };

    this.activeScans++;
    let released = false;
    const gate = this;
    const lease: ClamDatabaseLease = {
      release(): void {
        // IDEMPOTENTE. Um duplo release decrementaria duas vezes e deixaria o
        // gate a achar que há menos scans vivos do que há — que é o caminho
        // directo para o freshclam começar por cima de um scan a correr.
        if (released) return;
        released = true;
        gate.activeScans = Math.max(0, gate.activeScans - 1);
        if (gate.activeScans === 0) gate.wakeDrainWaiters(true);
      },
      get released(): boolean {
        return released;
      },
    };
    return { ok: true, lease };
  }

  /** Snapshot para diagnóstico e para os testes. */
  get state(): ClamDatabaseGateState {
    return {
      activeScans: this.activeScans,
      updatePending: this.requests.size > 0,
      updateActive: this.owner !== null,
      updateWaiters: this.queue.length,
    };
  }

  /** Atalho de leitura para o scan recusar sem materializar um `LeaseAttempt`. */
  get databaseIsUnavailable(): boolean {
    return this.owner !== null || this.requests.size > 0;
  }

  // ── Lado do UPDATE ─────────────────────────────────────────────────────────

  /**
   * Pedir a troca da base. É o ponto do contrato (B).
   *
   * Devolve a POSSE, ou `null` se a troca não pode acontecer com honestidade:
   * o orçamento expirou, ou o serviço está a sair. `null` significa sempre a
   * mesma coisa ao chamador — NÃO NASCE FRESHCLAM — e a base actual fica intacta.
   *
   * ORDEM IMPORTA e é esta:
   *  1. regista o pedido — SINCRONO, ANTES de qualquer await. A partir deste
   *     instante nenhum scan novo consegue entrar, e é esta linha que fecha a
   *     corrida "o update pediu entre o check e o uso do scan".
   *  2..await a posse, se outro update a tiver.
   *  3. `await` os scans activos drenarem, com orçamento.
   *  4. só com `activeScans === 0` é que o update escreve.
   */
  async beginUpdate(): Promise<ClamDatabaseUpdateLease | null> {
    // PASSO 1 — antes do primeiro await. Esta linha é o contrato.
    if (this.disposed) return null;
    const req: UpdateRequest = {
      granted: false,
      settled: false,
      resolveGrant: () => {
        /* substituído abaixo, antes de qualquer await */
      },
    };
    this.requests.add(req);

    // PASSO 2 — a exclusão mútua entre UPDATES. Sem ela, dois pedidos que
    // acordam da mesma drenagem escrevem os dois.
    if (!(await this.acquireOwnership(req))) {
      this.discard(req);
      return null;
    }

    // PASSO 3 — drena, se houver alguém a usar a base.
    if (this.activeScans > 0) {
      const drained = await this.waitForDrain(this.drainBudgetMs);
      // A posse é RECONFIRMADA depois do await. Sem esta linha, um `reset()`
      // feito enquanto este pedido estava suspenso no drain limpava o estado e
      // esta continuação voltava a dar `updateActive = true` — autorizando um
      // freshclam em plena paragem do serviço.
      if (!drained || !this.stillOwner(req)) {
        this.discard(req);
        return null;
      }
    } else if (!this.stillOwner(req)) {
      this.discard(req);
      return null;
    }

    // PASSO 4 — a base está livre e a posse é nossa. O update pode escrever.
    let released = false;
    const gate = this;
    return {
      release(): void {
        // IDEMPOTENTE. Um duplo `release` desligaria a posse do update SEGUINTE,
        // que já a tinha recebido por passagem de vez.
        if (released) return;
        released = true;
        gate.endOwnership(req);
      },
      get released(): boolean {
        return released;
      },
    };
  }

  /**
   * Torna este pedido o dono, ou espera a vez.
   *
   * O caminho rápido é SÍNCRONO: sem dono, o pedido é promovido na mesma, sem
   * passar por uma promise. Isso não é só efficiencies — é o que garante que
   * dois pedidos seguidos nunca dependem do tempo de arranque de uma promise
   * para se excluírem.
   */
  private acquireOwnership(req: UpdateRequest): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.owner === null) {
      this.owner = req;
      req.granted = true;
      req.settled = true;
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      req.resolveGrant = resolve;
      const timer = setTimeout(() => {
        if (req.settled) return;
        req.settled = true;
        const at = this.queue.indexOf(req);
        if (at >= 0) this.queue.splice(at, 1);
        resolve(false);
      }, this.drainBudgetMs);
      timer.unref?.();
      req.timer = timer;
      this.queue.push(req);
    });
  }

  /**
   * Este pedido desistiu. Se tinha a posse, passa-a; se estava à espera, só
   * desaparece.
   *
   * O segundo caso é o bug 2 do Codex: um pedido que expirou o orçamento tem de
   * mexer APENAS em si próprio. Desligar `updateActive` aqui desligava o update
   * que estava vivo a escrever, e o próximo pedido entrava por cima dele.
   */
  private discard(req: UpdateRequest): void {
    if (this.owner === req) {
      this.endOwnership(req);
      return;
    }
    const at = this.queue.indexOf(req);
    if (at >= 0) this.queue.splice(at, 1);
    if (!req.settled) {
      req.settled = true;
      if (req.timer) clearTimeout(req.timer);
    }
    this.requests.delete(req);
  }

  /**
   * O update terminou. Devolve a posse e passa-a a UM, SYNCRONAMENTE.
   *
   * O `this.owner = next` ANTES de resolver a promise do próximo é o que fecha
   * o bug 3 do Codex. Resolver uma promise não a executa: o waiter só retoma
   * numa microtarefa. Se a posse ficasse `null` durante esse intervalo, um
   * `beginUpdate()` novo encontrava o gate livre e entrava — e o waiter
   * acordado entrava à também. Reservar ANTES de resolver faz com que o
   * intervalo já tenha dono.
   */
  private endOwnership(req: UpdateRequest): void {
    // Não é o dono (ou já foi): um duplo `release` não pode desligar outro.
    if (this.owner !== req) return;
    this.owner = null;
    this.requests.delete(req);

    const next = this.queue.shift();
    if (next && !next.settled && !this.disposed) {
      next.granted = true;
      next.settled = true;
      if (next.timer) clearTimeout(next.timer);
      this.owner = next; // RESERVADO antes de resolver. Ver o comentário acima.
      next.resolveGrant(true);
    }
  }

  /** Este pedido continua a ser o dono depois do `await` que veio a seguir? */
  private stillOwner(req: UpdateRequest): boolean {
    return !this.disposed && this.owner === req;
  }

  // ── Drenagem ───────────────────────────────────────────────────────────────

  /**
   * Espera que `activeScans` chegue a zero, ou que o orçamento expire.
   *
   * `true` = drenou. `false` = orçamento esgotado, e o chamador NÃO escreve.
   *
   * Não há polling: quem resolve é o próprio `release` da lease, o que evita o
   * atraso de um intervalo e torna o teste determinístico.
   */
  private waitForDrain(budgetMs: number): Promise<boolean> {
    if (this.activeScans === 0) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const at = this.drainWaiters.indexOf(finish);
        if (at >= 0) this.drainWaiters.splice(at, 1);
        resolve(drained);
      };

      const timer = setTimeout(() => finish(false), budgetMs);
      // `unref` para o temporizador não segurar o event loop de um serviço que
      // está a shutting down com um update pendente.
      timer.unref?.();

      // Rede de segurança: se o último scan libertou entre o `if` de cima e
      // este registo, ninguem mais resolve esta promise e o update ficava
      // pendurado até ao orçamento — à espera de um drain que já aconteceu.
      if (this.activeScans === 0) {
        finish(true);
        return;
      }
      this.drainWaiters.push(finish);
    });
  }

  private wakeDrainWaiters(drained: boolean = true): void {
    // Copia antes de resolver: um `finish` remove-se a si próprio da lista, e
    // iterar o array enquanto ele muda seria um bug de fácil leitura difícil.
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w(drained);
  }

  /**
   * Liberta o gate inteiro. Só para `dispose`/shutdown do serviço.
   *
   * Não é o caminho normal de um update — esse é o `release` da posse — e não
   * tocar no estado a meio de um `beginUpdate` é o ponto.
   *
   * CODEX (2026-10-03): os pedidos são woken com `false`, e o `disposed` é posto
   * antes de qualquer coisa. Sem `disposed`, um `beginUpdate` que começasse
   * depois do shutdown voltava a adquirir posse sobre uma base que já não
   * interessa. Com ele, o pedido novo é recusado e a continuação já suspensa
   * falha em `stillOwner`.
   */
  reset(): void {
    this.disposed = true;

    // Quem estava à espera da vez recebe `false`: não vai escrever.
    const waiting = this.queue;
    this.queue = [];
    for (const req of waiting) {
      if (req.settled) continue;
      req.settled = true;
      if (req.timer) clearTimeout(req.timer);
      req.resolveGrant(false);
    }

    this.wakeDrainWaiters(false);
    this.owner = null;
    this.requests.clear();
    this.activeScans = 0;
  }
}
