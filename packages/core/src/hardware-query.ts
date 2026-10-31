import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
/** Cooperative admission for opaque hardware providers in THIS process.
 * One provider can internally fan out (graphics: seven PS). This is NOT a cap
 * on physical children, USB, native-windows or other processes. Never patch SI.
 * Queue expiry/abort does not free a running lease: only actual settlement does.
 * 'adl': leitura ADL da AMD (o worker é um processo à parte; entrar aqui serve
 * para NÃO somar polling concorrente com as restantes fontes de temperatura).
 */
const OPERATIONS = ['cpu-info','os-info','battery','graphics','cpu-temperature','adl','volumes','network','network-interfaces','ram-layout','acpi','storage-smart'] as const;
export type HardwareQueryOperation = typeof OPERATIONS[number];
type Task = { id: number; key: HardwareQueryOperation; work: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void; enqueued: number; timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal; traceSink?: (line: string) => void; abort?: () => void };
export class HardwareQueryCoordinator {
  private queue: Task[] = [];
  private running = false;
  private sequence = 0;
  private shared = new Map<HardwareQueryOperation, Promise<unknown>>();
  private totals = { started: 0, completed: 0, failed: 0, expired: 0, rejected: 0, peakQueued: 0, queueMs: 0, runMs: 0 };
  constructor(private readonly queueLimit = 32, private readonly queueMs = 15000) {}
  snapshot() { return { ...this.totals, active: this.running ? 1 : 0, queued: this.queue.length, scope: 'opaque hardware groups in this process; not a physical child cap' }; }
  run<T>(key: HardwareQueryOperation, work: () => Promise<T>, options: { share?: boolean; signal?: AbortSignal; traceSink?: (line: string) => void } = {}): Promise<T> {
    if (!OPERATIONS.includes(key)) return Promise.reject(new Error('Unknown hardware operation'));
    if (options.signal?.aborted) return Promise.reject(new Error('Hardware query aborted'));
    // Shared work is only used for parameterless equivalent reads. A cancellable
    // caller cannot own/cancel another caller's shared job.
    if (options.share && !options.signal) {
      const existing = this.shared.get(key); if (existing) return existing as Promise<T>;
    }
    if (this.queue.length >= this.queueLimit) { this.totals.rejected++; return Promise.reject(new Error('Hardware query queue full')); }
    const promise = new Promise<T>((resolve, reject) => {
      const task: Task = { id: ++this.sequence, key, work: AsyncResource.bind(work), resolve: resolve as (v: unknown) => void, reject, enqueued: performance.now(), signal: options.signal, traceSink: options.traceSink };
      const remove = (reason: string) => { const i = this.queue.indexOf(task); if (i < 0) return; this.queue.splice(i, 1); this.cleanup(task); this.totals.expired++; task.reject(new Error(reason)); };
      task.timer = setTimeout(() => remove('Hardware query queue deadline exceeded'), this.queueMs);
      task.abort = () => remove('Hardware query aborted');
      task.signal?.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task); this.totals.peakQueued = Math.max(this.totals.peakQueued, this.queue.length); this.pump();
    });
    if (options.share && !options.signal) { this.shared.set(key, promise); void promise.finally(() => { if (this.shared.get(key) === promise) this.shared.delete(key); }).catch(() => {}); }
    return promise;
  }
  private cleanup(task: Task) { clearTimeout(task.timer); if (task.abort) task.signal?.removeEventListener('abort', task.abort); }
  private trace(task: Task, phase: string, queueMs: number, runMs = 0) {
    if (process.env.CYBERSAFE_QUERY_TRACE !== '1') return;
    // Fixed operation names, monotonic timings, role/PID only. Never commands,
    // paths, output, environment values, device identifiers or credentials.
    const line = JSON.stringify({ operation: task.key, id: task.id, phase, pid: process.pid, parentPid: process.ppid, component: 'core-hardware', monotonicMs: performance.now(), at: new Date().toISOString(), queueMs, runMs });
    try { if (task.traceSink) task.traceSink(line); else console.info('[hardware-query]', line); } catch { /* diagnostics must never fail a query */ }
  }
  private pump() {
    if (this.running) return;
    const task = this.queue.shift(); if (!task) return;
    this.cleanup(task); const wait = performance.now() - task.enqueued;
    if (task.signal?.aborted || wait >= this.queueMs) { this.totals.expired++; task.reject(new Error('Hardware query expired before admission')); this.pump(); return; }
    this.running = true; this.totals.queueMs += wait;
    const began = performance.now(); let invoked = false;
    void Promise.resolve().then(() => { if (task.signal?.aborted) throw new Error('Hardware query aborted'); invoked = true; this.totals.started++; this.trace(task, 'start', wait); return task.work(); }).then(value => { this.totals.completed++; task.resolve(value); }, () => { if (invoked) this.totals.failed++; else this.totals.expired++; task.reject(new Error(invoked ? 'Hardware provider failed' : 'Hardware query aborted')); }).finally(() => {
      const runMs = performance.now() - began; this.totals.runMs += runMs; this.trace(task, invoked ? 'settled' : 'cancelled-before-start', wait, runMs); this.running = false; this.pump();
    });
  }
}
const signals = new AsyncLocalStorage<{ signal: AbortSignal; traceSink?: (line: string) => void }>();
export const withHardwareQuerySignal = <T>(signal: AbortSignal, work: () => T, traceSink?: (line: string) => void): T => signals.run({ signal, traceSink }, work);
const coordinator = new HardwareQueryCoordinator();
export const hardwareQuerySnapshot = () => coordinator.snapshot();
export function runHardwareQuery<T>(key: HardwareQueryOperation, work: () => Promise<T>, share = false): Promise<T> {
  return process.platform === 'win32' ? coordinator.run(key, work, { share, signal: signals.getStore()?.signal, traceSink: signals.getStore()?.traceSink }) : Promise.resolve().then(work);
}
