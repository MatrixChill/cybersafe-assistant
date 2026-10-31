/**
 * Leituras independentes limitadas, barreiras ordenadas para mutações. Uma
 * instância por pipe.
 *
 * AUD-002: `maxReads` limita a CONCORRÊNCIA, não o trabalho acumulado. O tecto
 * (`maxOutstanding`) conta **ativas + pendentes**: uma operação já iniciada
 * também retém uma closure e o seu resultado. Sem isto, um cliente autenticado
 * que enviasse pedidos em catadupa fazia crescer a fila sem limite. `enqueue`
 * responde se aceitou; quem chama recusa com resposta em vez de desaparecer.
 */
export class RpcRequestQueue {
  private pending: Array<{ read: boolean; work: () => Promise<void> }> = [];
  private active = 0;
  private writing = false;
  private closed = false;
  constructor(
    private readonly maxReads = 4,
    private readonly maxOutstanding = 64,
  ) {}
  /** Pedidos à espera de vez (não inclui os que já estão a correr). */
  get pendingCount(): number {
    return this.pending.length;
  }
  /** Trabalho total por concluir: à espera + a correr. */
  get outstandingCount(): number {
    return this.pending.length + this.active;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  enqueue(read: boolean, work: () => Promise<void>): boolean {
    if (this.closed) return false;
    if (this.outstandingCount >= this.maxOutstanding) return false;
    this.pending.push({ read, work });
    this.pump();
    return true;
  }
  close(): void {
    this.closed = true;
    this.pending = [];
  }
  private pump(): void {
    if (this.closed || this.writing) return;
    while (this.pending.length && this.active < this.maxReads) {
      const next = this.pending[0];
      if (!next.read && this.active > 0) return;
      this.pending.shift();
      this.active++;
      if (!next.read) this.writing = true;
      void new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => {
          if (!this.closed) return next.work();
        })
        .catch(() => {})
        .finally(() => {
          this.active--;
          if (!next.read) this.writing = false;
          this.pump();
        });
      if (!next.read) return;
    }
  }
}
export const INDEPENDENT_READ_METHODS: ReadonlySet<string> = new Set([
  'protection.getState', 'events.list', 'threats.list', 'processes.list', 'connections.list',
  'quarantine.list', 'pcstate.get', 'hardware.snapshot', 'windows.healthSnapshot',
]);
