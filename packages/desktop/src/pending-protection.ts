/**
 * Maquina do PEDIDO PENDENTE da tray — modulo puro (sem Electron) para ser
 * testavel, incluido o interleaving que o REVIEW CODEX classificou P1:
 *
 *   A (starting) fica pendurada no deadline -> o motor confirma A por evento
 *   -> o utilizador inicia B (stopping) -> o refresh de A RESOLVE TARDE e,
 *   sem identidade, apagava o pending de B e desarmava o deadline de B.
 *
 * A regra: cada voo captura um token. Depois de QUALQUER await, limpar ou
 * notificar so se o token ainda for o do voo — quem chegou depois manda, e o
 * estado invalidado de um voo antigo nunca toca no novo. `isQuitting` tambem
 * e checado depois de cada await: no encerramento nada pinta nem notifica.
 */

import type { TrayPendingAction } from "./tray-menu.js";

/** Prazo de seguranca: um RPC que nunca resolve nao pode fixar o pending. */
export const PENDING_DEADLINE_MS = 20_000;

export interface PendingNotify {
  title: string;
  body: string;
}

export interface PendingDeps {
  /** Agenda o disparo do deadline; devolve o cancelamento. */
  schedule(fn: () => void, ms: number): () => void;
  /** Le o estado REAL do motor (refreshTrayProtectionInfo no shell). */
  refreshState(): Promise<void>;
  /** Redesenha menu/icone a partir do estado + pending atuais. */
  repaint(): void;
  /** Notificacao de desktop — so chamada pelo dono do token vigente. */
  notify(n: PendingNotify): void;
  /** O encerramento comecou: depois de qualquer await, nada se afirma. */
  isQuitting(): boolean;
  /** Log do prazo expirado (opcional; o comportamento nao depende dele). */
  onDeadlineExpired?(action: TrayPendingAction): void;
  /** Log de resolucao atrasada descartada (diagnostico do P1 do Codex). */
  onStaleResolution?(action: TrayPendingAction, token: number): void;
}

export class PendingProtection {
  private action: TrayPendingAction | null = null;
  /**
   * Cada voo captura `++token` no begin. Qualquer caminho de saida (RPC,
   * deadline, evento do motor, quit) incrementa de novo ao libertar, para que
   * resolucoes atrasadas de voos JÁ resolvidos sejam reconheciveis como
   * stale — inclusive duas resolucoes do mesmo voo.
   */
  private token = 0;
  private cancelDeadline: (() => void) | null = null;
  private deps: PendingDeps;
  private deadlineMs: number;

  // NOTA: sem parameter properties — os testes importam este .ts no modo
  // strip-only do Node (node --test), que nao faz transformacoes de sintaxe.
  constructor(deps: PendingDeps, deadlineMs: number = PENDING_DEADLINE_MS) {
    this.deps = deps;
    this.deadlineMs = deadlineMs;
  }

  /** O pedido em curso, ou null. `main.ts` pinta isto no menu. */
  get current(): TrayPendingAction | null {
    return this.action;
  }

  /** true enquanto ha um pedido nao confirmado — guarda anti-duplo. */
  get busy(): boolean {
    return this.action !== null;
  }

  /**
   * Clique aceite: marca pending, arma o deadline deste voo, redesenha.
   * Devolve o token do voo — e A UNICA coisa que pode libertar este pedido.
   */
  begin(action: TrayPendingAction): number {
    this.cancelDeadline?.();
    this.cancelDeadline = null;
    this.action = action;
    const mine = ++this.token;
    this.cancelDeadline = this.deps.schedule(() => {
      void this.expired(mine);
    }, this.deadlineMs);
    this.deps.repaint();
    return mine;
  }

  /**
   * O RPC do voo `mine` resolveu (ok OU falha do motor). Ordem fixa:
   * refrescar o estado real -> revalidar identidade -> libertar -> notificar.
   * Se outro voo (ou o deadline, ou o evento) tomou conta entretanto, nada e
   * pintado, nada e notificado: o resultado de A nao pode falar por B.
   */
  async settle(mine: number, ok: boolean, notify: PendingNotify, notifyFailed: PendingNotify): Promise<void> {
    await this.deps.refreshState();
    if (this.deps.isQuitting()) return;
    if (mine !== this.token || this.action === null) {
      this.deps.onStaleResolution?.(this.action ?? "starting", mine);
      return;
    }
    this.release(mine);
    this.deps.repaint();
    this.deps.notify(ok ? notify : notifyFailed);
  }

  /**
   * RE-REVIEW CODEX (P1-A): o evento `protection.changed` NÃO liberta voos.
   * Ele confirma ESTADO GLOBAL, não "o meu pedido" — sem correlação entre
   * evento e voo, um `changed` ATRASADO de A apagava o pending de B. O ciclo
   * de vida do pending passou a ser SÓ do seu RPC (`settle`) ou do seu
   * deadline (`expired`), ambos revalidados por token. O evento limita-se a
   * pintar o snapshot pela via do `SnapshotCommitter`.
   */

  /** Encerramento: o timer morre, o pending desaparece, nada se afirma. */
  abandon(): void {
    this.cancelDeadline?.();
    this.cancelDeadline = null;
    if (this.action !== null) {
      this.action = null;
      this.token += 1;
    }
  }

  /**
   * Prazo expirado sem resposta do serviço: rele o estado real e, se este voo
   * ainda for o vigente, liberta o pending SEM notificar nem afirmar — a tray
   * volta a aceitar acoes e o proximo evento/poll diz a verdade.
   */
  private async expired(mine: number): Promise<void> {
    this.cancelDeadline = null;
    if (this.action === null || mine !== this.token) return;
    const action = this.action;
    await this.deps.refreshState();
    if (this.deps.isQuitting()) return;
    // Revalida DEPOIS do await — foi aqui que o P1 acontecia: o refresh de A
    // resolvia depois de B ter comecado, e o clear sem identidade apagava B.
    if (this.action === null || mine !== this.token) {
      this.deps.onStaleResolution?.(action, mine);
      return;
    }
    this.release(mine);
    this.deps.onDeadlineExpired?.(action);
    this.deps.repaint();
  }

  /** Libertacao canónica: só o token vigente pode; sempre invalida o voo. */
  private release(mine: number): void {
    if (mine !== this.token || this.action === null) return;
    this.cancelDeadline?.();
    this.cancelDeadline = null;
    this.action = null;
    this.token += 1;
  }
}

/**
 * P1-B (RE-REVIEW CODEX): `refreshState` escrevia o snapshot do estado ANTES
 * de revalidar quem chegou depois — uma leitura velha podia sobrescrever um
 * evento mais recente. A regra: cada leitura abre uma GERACAO; o commit só
 * pinta se nenhuma outra escrita (leitura mais nova ou evento) abriu geracao
 * entretanto. O evento pinta por `paint`, que passa a ganhar de imediato.
 */
export class SnapshotCommitter<T> {
  private generation = 0;
  private current: T | null = null;

  /** O valor pintado mais recente, ou null enquanto não houve leitura. */
  get value(): T | null {
    return this.current;
  }

  /** Inicia uma leitura: devolve a geracao desta leitura. */
  begin(): number {
    return ++this.generation;
  }

  /**
   * Commit de uma leitura: pinta SÓ se a geracao ainda for esta. Se uma
   * leitura mais nova ou um evento pintou entretanto, o snapshot velho e
   * descartado — devolver false e nao escrever e o comportamento correto.
   */
  commit(myGeneration: number, value: T): boolean {
    if (myGeneration !== this.generation) return false;
    this.current = value;
    return true;
  }

  /** Escrita imediata (evento do motor): invalida leituras em curso. */
  paint(value: T): void {
    this.generation += 1;
    this.current = value;
  }
}
