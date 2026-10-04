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
 * ── A DECISÃO DE DESENHO, E O QUE A FORÇOU ──────────────────────────────────
 * A raiz de tudo está aqui: o estado é de PROCESSO e a coordenação tem de ser
 * de PROCESSO. Uma versão anterior tinha o inverso — estado de processo
 * (contadores e registos partilhados) com coordenação por instância (filas e
 * waiters por gate). O Codex reproduziu as três consequências, todas por
 * executarem o código:
 *
 *  1. A exclusão entre UPDATES só existia dentro de uma instância. Dois gates
 *     diferentes concediam posse ao mesmo tempo, e ambos continuavam `valid`
 *     até ao `markWriting`. Em produção há um gate por motor — mas um motor
 *     recriado no mesmo processo (reload, reinício do serviço) nasce com um
 *     gate novo que não sabia de nada. Reproduzido 100/100.
 *  2. A drenagem também era por instância. O `release` de uma lease acordava
 *     apenas os waiters do SEU gate; o outro esperava pelo orçamento com a base
 *     já livre. Reproduzido 100/100.
 *  3. Um scan libertado depois de um `reset` desaparecia do estado do gate novo,
 *     e o freshclam seguinte entrava por cima dele — o contrato B pela porta do
 *     shutdown. Reproduzido 30/30 com `ClamavBridge` e `DefinitionUpdater` reais.
 *
 * Por isso existe um ÚNICO `Ambito`: fila, waiters, dono e registos vivem lá,
 * e `ClamDatabaseGate` é uma façade para ele. Duas instâncias no mesmo processo
 * partilham o mesmo âmbito e portanto coordenar de facto.
 *
 * ── Porquê isto NÃO é um mutex genérico ──────────────────────────────────────
 * Porque não é reentrante, não tem variáveis de condição, não tem timeout genérico
 * e não serializa mais nada do serviço. Serializa exactamente uma coisa: a
 * base de assinaturas do ClamAV.
 *
 * ── Porque o Node é o que torna isto POSSÍVEL ────────────────────────────────
 * Numa linguagem com threads, `check` e `increment` separados por duas linhas
 * são uma corrida. Aqui não: o JS de thread única executa `tryAcquireScanLease`
 * INTEIRO sem interrupção — não há await dentro dele, nem callback, nem promessa.
 */

/** Motivo pelo qual uma lease foi recusada. Entra no diagnóstico do scan. */
export type LeaseDenialReason = "update-pending" | "update-active" | "gate-disposed";

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
  /**
   * A posse ainda é válida? É o que o updater consulta ANTES de fazer spawn.
   *
   * CODEX (2026-10-03): `beginUpdate` pode resolver, e o `reset` do shutdown
   * correr na microtarefa seguinte, ANTES de o `.then` arrancar o freshclam. O
   * gate estava certo e o spawn acontecia na mesma. Reconfirmar no próprio
   * sítio que vai escrever é o que fecha a janela.
   */
  readonly valid: boolean;
  /** Marca que o freshclam vai MESMO escrever, a partir de já. */
  markWriting(): void;
}

/** Motivo pelo qual um update foi adiado. Entra no diagnóstico do ciclo. */
export type UpdateDenialReason = "busy-scans" | "outro-escritor" | "servico-a-encerrar";

/**
 * O resultado de `beginUpdateComMotivo`, com a CAUSA.
 *
 * CODEX (2026-10-03), oitava ronda: `beginUpdate` devolvia só `null`, e o
 * updater escrebia SEMPRE "ha scans ClamAV activos que nao drenaram". Com
 * zero scans — depois de um shutdown, ou com outro escritor a segurar a vez —
 * essa frase era falsa, e é o que o utilizador lia no painel.
 *
 * Existe em vez de um campo partilhado no gate porque um campo partilhado
 * seria uma leitura com corrida: entre o `await` e a leitura, outro update
 * podia ter escrito por cima. O motivo vem no próprio resultado.
 */
export interface UpdateRefusal {
  readonly refused: true;
  readonly reason: UpdateDenialReason;
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
   * chegar a minutos. 30 s drena o caso comum e recusa o caso patológico, que
   * é o que se quer: melhor adiar a actualização do que matar um scan.
   */
  drainBudgetMs?: number;
}

const DEFAULT_DRAIN_BUDGET_MS = 30_000;

/**
 * Um pedido de update, e a sua identidade. É o token de posse: sem ele não há
 * como distinguir "o update que está a escrever" de "o update que espera a vez".
 */
interface PedidoUpdate {
  granted: boolean;
  /** Já DRAINOU e está EFFECTIVAMENTE a escrever. */
  writing: boolean;
  /** A promise de posse já resolveu. */
  settled: boolean;
  /** Marcador registado no âmbito enquanto este pedido escreve. */
  marker?: object;
  timer?: ReturnType<typeof setTimeout>;
  resolveGrant(ok: boolean): void;
}

/**
 * O ESTADO COMPARTILHADO DO PROCESSO.
 *
 * Tudo o que tem de coordenar entre instâncias vive aqui: as leases de scan
 * vivas, os escritores sem prova de morte, o dono da vez, a fila e os waiters de
 * drenagem. Deixá-los por instância foi exactamente o que o Codex apanhou.
 */
class AmbitoClamDatabase {
  /** Leases de scan vivas, em qualquer gate do processo. */
  readonly leasesDeScanVivas = new Set<ClamDatabaseLease>();
  /** Escritores que declararam estar a escrever e ainda não devolveram a posse. */
  readonly escritoresSemProvaDeMorte = new Set<object>();
  /** Quem tem a vez. É a ÚNICA fonte de `updateActive`. */
  owner: PedidoUpdate | null = null;
  /** Quem espera a vez, por ordem de chegada. */
  queue: PedidoUpdate[] = [];
  /** Todo o pedido em curso, dono ou não. É a fonte de `updatePending`. */
  readonly requests = new Set<PedidoUpdate>();
  /** Quem está à espera de `activeScans === 0`, em qualquer gate. */
  drainWaiters: Array<(drained: boolean) => void> = [];
  /** O serviço está a sair. Depois disto nada adquire posse nova. */
  disposed = false;

  get activeScans(): number {
    return this.leasesDeScanVivas.size;
  }

  /**
   * Acorda TODOS os waiters de drenagem do processo, de qualquer gate.
   *
   * CODEX (2026-10-03): a versao anterior acordava apenas os waiters da
   * instancia. Um scan libertado no gate B nao acordava o gate A, que expirava
   * pelo orcamento com a base ja livre. Reproduzido 100/100. A lista e do
   * AMBITO, e e por isso que isto fecha.
   */
  static acordarDrenagem(amb: AmbitoClamDatabase, drained: boolean = true): void {
    // Copia antes de resolver: um `finish` remove-se a si proprio da lista.
    const waiters = amb.drainWaiters;
    amb.drainWaiters = [];
    for (const w of waiters) w(drained);
  }
}

function criarAmbito(): AmbitoClamDatabase {
  return new AmbitoClamDatabase();
}

/**
 * O âmbito do processo. UMA fonte de verdade: duas instâncias do gate no mesmo
 * processo coordenam por aqui, que é o que a decisão de desenho exige.
 */
let ambito: AmbitoClamDatabase = criarAmbito();

/**
 * Substitui o âmbito por um vazio. SÓ PARA TESTES.
 *
 * O âmbito é de processo, e é isso que fecha a coordenação entre gates — mas
 * significa que um teste que deixe um scan ou um escritor vivo contamina todos
 * os seguintes. Esta função dá a cada teste um âmbito limpo, e é a razão de o
 * isolamento estar numa função explícita em vez de num `reset()` a fingir que
 * não houve nada.
 *
 * NUNCA chamar em produção: esquecer-se de limpar o âmbito é precisamente o
 * buraco que ele serve para tapar.
 */
export function reiniciarAmbitoDeTeste(): void {
  ambito = criarAmbito();
}

/** Só para testes: o âmbito vivo. */
export function ambitoActual(): AmbitoClamDatabase {
  return ambito;
}

export class ClamDatabaseGate {
  /**
   * Quanto espera um pedido antes de desistir. É configuração do CHAMADOR, e
   * por isso fica na instância: o gate novo de um serviço reiniciado pode
   * decidir um orçamento diferente. A espera em si vive no âmbito.
   */
  readonly drainBudgetMs: number;

  constructor(options: ClamDatabaseGateOptions = {}) {
    this.drainBudgetMs = options.drainBudgetMs ?? DEFAULT_DRAIN_BUDGET_MS;
  }

  /** O âmbito vivo. Pode mudar entre duas chamadas se um teste o recriar. */
  private get a(): AmbitoClamDatabase {
    return ambito;
  }

  // ── Lado do SCAN ───────────────────────────────────────────────────────────

  /**
   * Tenta entrar. SÍNCRONO DE PROPÓSITO — é a peça que fecha o TOCTOU.
   *
   * O `if` e o `activeScans++` correm sem interrupção: o runtime de JS não pode
   * ceder o controlo aqui, porque não há await, nem callback, nem promessa.
   */
  tryAcquireScanLease(): LeaseAttempt {
    const amb = this.a;
    if (amb.disposed) return { ok: false, reason: "gate-disposed" };
    // Um escritor de ANTES deste gate — de um serviço que já foi descartado —
    // continua a poder estar vivo. Uma instância nova que não olhasse para o
    // âmbito admitia o primeiro scan por cima dele.
    if (amb.escritoresSemProvaDeMorte.size > 0) return { ok: false, reason: "update-active" };
    // A ordem das perguntas é a ordem da verdade. "Activo" é o dono a ESCREVER;
    // um dono que ainda está a drenar tem a vez mas não escreve ainda, e dizer
    // "update-active" seria afirmar ao utilizador que há um freshclam a escrever
    // quando ainda não.
    if (amb.owner !== null && amb.owner.writing) return { ok: false, reason: "update-active" };
    if (amb.requests.size > 0) return { ok: false, reason: "update-pending" };

    const escopo = amb;
    let released = false;
    const lease: ClamDatabaseLease = {
      release(): void {
        // IDEMPOTENTE. Um duplo release faria o gate achar que há menos scans
        // vivos do que há — o caminho directo para o freshclam começar por
        // cima de um scan a correr.
        if (released) return;
        released = true;
        escopo.leasesDeScanVivas.delete(lease);
        if (escopo.leasesDeScanVivas.size === 0) AmbitoClamDatabase.acordarDrenagem(escopo, true);
      },
      get released(): boolean {
        return released;
      },
    };
    amb.leasesDeScanVivas.add(lease);
    return { ok: true, lease };
  }

  /** Snapshot para diagnóstico e para os testes. */
  get state(): ClamDatabaseGateState {
    const amb = this.a;
    return {
      activeScans: amb.leasesDeScanVivas.size,
      updatePending: amb.requests.size > 0,
      updateActive: amb.owner !== null && amb.owner.writing,
      updateWaiters: amb.queue.length,
    };
  }

  /** Atalho de leitura para o scan recusar sem materializar um `LeaseAttempt`. */
  get databaseIsUnavailable(): boolean {
    return this.a.requests.size > 0;
  }

  // ── Lado do UPDATE ─────────────────────────────────────────────────────────

  /**
   * Pedir a troca da base. É o ponto do contrato (B).
   *
   * Devolve a POSSE, ou `null` se a troca não pode acontecer com honestidade:
   * o orçamento expirou, ou o serviço está a sair. `null` significa sempre a
   * mesma coisa ao chamador — NÃO NASCE FRESHCLAM.
   *
   * ORDEM IMPORTA e é esta:
   *  1. regista o pedido — SINCRONO, ANTES de qualquer await. É esta linha que
   *     fecha a corrida "o update pediu entre o check e o uso do scan".
   *  2. `await` a posse, se outro update a tiver.
   *  3. `await` os scans activos drenarem, com orçamento.
   *  4. só com zero scans vivos é que o update escreve.
   */
  async beginUpdate(): Promise<ClamDatabaseUpdateLease | null> {
    return (await this.beginUpdateComMotivo()).lease ?? null;
  }

  /** Como `beginUpdate`, mas a recusa vem com a CAUSA. */
  async beginUpdateComMotivo(): Promise<{ lease: ClamDatabaseUpdateLease | null; refusal: UpdateRefusal | null }> {
    const amb = this.a;
    const adiado = (reason: UpdateDenialReason) => ({ lease: null, refusal: { refused: true, reason } as UpdateRefusal });
    // PASSO 1 — antes do primeiro await. Esta linha é o contrato.
    if (amb.disposed) return adiado("servico-a-encerrar");
    const req: PedidoUpdate = {
      granted: false,
      writing: false,
      settled: false,
      resolveGrant: () => {
        /* substituído abaixo, antes de qualquer await */
      },
    };
    amb.requests.add(req);

    // PASSO 2 — a exclusão mútua entre UPDATES, à escala do processo.
    if (!(await this.acquireOwnership(req))) {
      this.discard(req);
      // CODEX (2026-10-03), finding 17: a causa sai do ESTADO REAL.
      //
      // A classificação anterior era `amb.owner === req || amb.escritoresSemProvaDeMorte
      // .size > 0`. O primeiro termo é um RAMO MORTO: `acquireOwnership` só devolve
      // `true` quando promove o PRÓPRIO pedido a dono, portanto neste ponto
      // `amb.owner === req` é sempre falso. Sobrava o segundo termo — e ele mente
      // justamente nos dois casos em que o orçamento expira à espera de OUTRO
      // escritor: um dono que ainda não chamou `markWriting` (é o `markWriting` que
      // põe o marcador no registo de processo, ver o `markWriting` mais abaixo
      // neste ficheiro) não está nele, e um `reset` limpa o registo. Nos dois, a
      // recusa caía em "busy-scans".
      //
      // MEDIDO (output/manual-retest/f17-probe.mjs, caso A): dois updates
      // concorrentes + `reset()` → um deles anunciava "ha scans ClamAV activos que
      // nao drenaram dentro do orcamento" com `activeScans === 0`. Caso B: fila
      // expirada com o dono vivo e sem `markWriting` → `busy-scans` com
      // `activeScans === 0` e o dono ainda por omissão.
      //
      // A distinção honesta são três perguntas, por esta ordem: o serviço está a
      // encerrar? havia mesmo scans vivos quando o orçamento expirou? se não havia,
      // quem segurava a vez era outro ESCRITOR — que é a verdade. `discard` fica
      // ANTES de ler o estado, e não toca em `disposed` nem em
      // `leasesDeScanVivas`, por isso a leitura é a mesma de antes.
      if (amb.disposed) return adiado("servico-a-encerrar");
      return adiado(amb.leasesDeScanVivas.size > 0 ? "busy-scans" : "outro-escritor");
    }

    // PASSO 3 — drena, se houver alguém a usar a base. A contagem é a de
    // QUALQUER gate do processo, não a desta instância: é a diferença entre
    // "ninguém tem a base" e "ninguém, nem sequer um scan que veio de outro gate
    // antes do shutdown".
    if (amb.leasesDeScanVivas.size > 0) {
      const drained = await this.waitForDrain(this.drainBudgetMs);
      // A posse é RECONFIRMADA depois do await: um `reset` feito enquanto este
      // pedido estava suspenso no drain limpava o estado e esta continuação
      // voltava a autorizar escrita.
      if (!drained || !this.stillOwner(req)) {
        this.discard(req);
        return adiado(amb.disposed ? "servico-a-encerrar" : "busy-scans");
      }
    } else if (!this.stillOwner(req)) {
      this.discard(req);
      return adiado(amb.disposed ? "servico-a-encerrar" : "busy-scans");
    }

    // PASSO 4 — a base está livre e a posse é nossa.
    //
    // `writing` NÃO é posto aqui: fica para o `markWriting`, que o updater chama
    // imediatamente antes do `spawn`. Entre a posse concedida e o spawn há um
    // `await` (a preparação da config), e dizer "updateActive" nesse intervalo
    // seria afirmar que há um freshclam na base antes de existir algum.
    let released = false;
    const gate = this;
    const lease: ClamDatabaseUpdateLease = {
      release(): void {
        // IDEMPOTENTE. Um duplo `release` desligaria a posse do update SEGUINTE,
        // que já a tinha recebido por passagem de vez.
        if (released) return;
        released = true;
        // O marcador sai AQUI, e não dentro do `endOwnership`: depois de um
        // `reset` o dono já não é este pedido, e o marcador ficava retido
        // para sempre, a crescer e a bloquear scans.
        if (req.marker) {
          amb.escritoresSemProvaDeMorte.delete(req.marker);
          req.marker = undefined;
        }
        gate.endOwnership(req);
      },
      get released(): boolean {
        return released;
      },
      get valid(): boolean {
        return !released && gate.stillOwner(req);
      },
      markWriting(): void {
        // Só o dono vivo pode declarar que está a escrever.
        if (!gate.stillOwner(req)) return;
        req.writing = true;
        // CODEX (2026-10-03), achado único da sétima ronda: o marcador era
        // SUBSTITUÍDO a cada chamada, e o `release` só knew remover o último.
        // Duas marcações deixavam um órfão no registo de processo, que
        // bloqueava scans e updates para sempre — e sobrevivia ao shutdown.
        // Reproduzido 100/100. Não há chamadas duplicadas em produção, o que é
        // exactamente o ponto: um buraco que só um teste encontra e que o
        // próximo refactor pode introduzir tem de estar fechado por construção.
        if (req.marker) return;
        // A partir de agora este writer é responsabilidade do PROCESSO, não
        // desta instância.
        req.marker = {};
        amb.escritoresSemProvaDeMorte.add(req.marker);
      },
    };
    return { lease, refusal: null };
  }

  /**
   * Torna este pedido o dono, ou espera a vez.
   *
   * O caminho rápido é SÍNCRONO: sem dono, o pedido é promovido na mesma, sem
   * passar por uma promise. Isso não é só eficiência — é o que garante que dois
   * pedidos seguidos nunca dependem do tempo de arranque de uma promise para se
   * excluírem.
   */
  private acquireOwnership(req: PedidoUpdate): Promise<boolean> {
    const amb = this.a;
    if (amb.disposed) return Promise.resolve(false);
    // Um escritor de antes deste gate continua a poder estar vivo. Um registo
    // que só protege metade dos lados não é um registo.
    if (amb.escritoresSemProvaDeMorte.size > 0) return Promise.resolve(false);
    if (amb.owner === null) {
      amb.owner = req;
      req.granted = true;
      req.settled = true;
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      req.resolveGrant = resolve;
      const timer = setTimeout(() => {
        if (req.settled) return;
        req.settled = true;
        const at = amb.queue.indexOf(req);
        if (at >= 0) amb.queue.splice(at, 1);
        resolve(false);
      }, this.drainBudgetMs);
      timer.unref?.();
      req.timer = timer;
      amb.queue.push(req);
    });
  }

  /**
   * Este pedido desistiu. Se tinha a posse, passa-a; se estava à espera, só
   * desaparece.
   *
   * O segundo caso é o bug 2 do Codex: um pedido que expirou o orçamento tem de
   * mexer APENAS em si próprio. Desligar o update activo aqui desligaria o
   * update que estava vivo a escrever.
   */
  private discard(req: PedidoUpdate): void {
    const amb = this.a;
    if (amb.owner === req) {
      this.endOwnership(req);
      return;
    }
    const at = amb.queue.indexOf(req);
    if (at >= 0) amb.queue.splice(at, 1);
    if (!req.settled) {
      req.settled = true;
      if (req.timer) clearTimeout(req.timer);
    }
    amb.requests.delete(req);
  }

  /**
   * O update terminou. Devolve a posse e passa-a a UM, SYNCRONAMENTE.
   *
   * O `owner = next` ANTES de resolver a promise do próximo é o que fecha o bug
   * 3 do Codex. Resolver uma promise não a executa: o waiter só retoma numa
   * microtarefa. Se a posse ficasse livre nesse intervalo, um `beginUpdate`
   * novo entrava — e o waiter acordado entrava à também.
   */
  private endOwnership(req: PedidoUpdate): void {
    const amb = this.a;
    if (amb.owner !== req) return;
    amb.owner = null;
    amb.requests.delete(req);

    const next = amb.queue.shift();
    if (next && !next.settled && !amb.disposed) {
      next.granted = true;
      next.settled = true;
      if (next.timer) clearTimeout(next.timer);
      amb.owner = next; // RESERVADO antes de resolver. Ver o comentário acima.
      next.resolveGrant(true);
    }
  }

  /** Este pedido continua a ser o dono depois do `await` que veio a seguir? */
  private stillOwner(req: PedidoUpdate): boolean {
    const amb = this.a;
    return !amb.disposed && amb.owner === req;
  }

  // ── Drenagem ───────────────────────────────────────────────────────────────

  /**
   * Espera que não haja scans vivos no PROCESSO, ou que o orçamento expire.
   *
   * `true` = drenou. `false` = orçamento esgotado, e o chamador NÃO escreve.
   *
   * Não há polling: quem resolve é o próprio `release` da lease, o que evita o
   * atraso de um intervalo e torna o teste determinístico.
   */
  private waitForDrain(budgetMs: number): Promise<boolean> {
    const amb = this.a;
    if (amb.leasesDeScanVivas.size === 0) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const at = amb.drainWaiters.indexOf(finish);
        if (at >= 0) amb.drainWaiters.splice(at, 1);
        resolve(drained);
      };

      const timer = setTimeout(() => finish(false), budgetMs);
      timer.unref?.();

      // Rede de segurança: se o último scan libertou entre o `if` de cima e
      // este registo, ninguem mais resolve esta promise e o update ficava
      // pendurado até ao orçamento — à espera de um drain que já aconteceu.
      if (amb.leasesDeScanVivas.size === 0) {
        finish(true);
        return;
      }
      amb.drainWaiters.push(finish);
    });
  }

  // ── Shutdown ───────────────────────────────────────────────────────────────

  /**
   * Liberta o gate. Só para `dispose`/shutdown do serviço.
   *
   * CODEX (2026-10-03), achados 3 e 10. `reset` não pode dar por morto um scan
   * nem um escritor que ninguém confirmou morto: por omissão as leases
   * continuam contadas, e é essa a posição honesta.
   *
   * `scansConfirmadosMortos` é a excepção, e tem de ser o `dispose` a dizer
   * que matou os filhos — não o inverso. A versão anterior passava-a
   * incondicionalmente sem matar clamscans, e a "confirmação" era falsa: um
   * freshclam nascia por cima de um clamscan vivo.
   */
  reset(opcoes: { scansConfirmadosMortos?: boolean } = {}): void {
    const amb = this.a;
    amb.disposed = true;

    // Quem estava à espera da vez recebe `false`: não vai escrever.
    const waiting = amb.queue;
    amb.queue = [];
    for (const req of waiting) {
      if (req.settled) continue;
      req.settled = true;
      if (req.timer) clearTimeout(req.timer);
      req.resolveGrant(false);
    }

    AmbitoClamDatabase.acordarDrenagem(amb, false);
    amb.owner = null;
    amb.requests.clear();

    if (opcoes.scansConfirmadosMortos) amb.leasesDeScanVivas.clear();
  }
}
