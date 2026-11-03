import type {UpdateSnapshot} from './types.js';
interface Checkable {
  snapshotCopy(): Pick<UpdateSnapshot, 'automaticCheckEnabled' | 'phase'>;
  check(): Promise<unknown>;
}
type Schedule = (tick: () => Promise<void>, intervalMs: number) => () => void;
/** Availability only: no download/install, explicit preference checked each tick. */
export function startAutomaticChecks(updater: Checkable, options: {schedule?: Schedule} = {}): () => void {
  let disposed = false;
  let pending = false;
  const tick = async () => {
    if (disposed || pending) return;
    const state = updater.snapshotCopy();
    if (!state.automaticCheckEnabled || !['idle', 'upToDate', 'error'].includes(state.phase)) return;
    pending = true;
    try { await updater.check(); }
    catch { /* The next scheduled attempt can recover; never reject a timer callback. */ }
    finally { pending = false; }
  };
  const schedule: Schedule = options.schedule ?? ((callback, interval) => {
    const timer = setInterval(() => { void callback(); }, interval);
    timer.unref();
    return () => clearInterval(timer);
  });
  const cancel = schedule(tick, 15 * 60 * 1000);
  return () => { disposed = true; cancel(); };
}
