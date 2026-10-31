import type { EventEmitter } from 'node:events';

/** Only the inherited Node IPC channel of an isolated, explicitly owned child. */
export function installDevParentShutdown(
  parent: EventEmitter & { connected?: boolean },
  env: NodeJS.ProcessEnv,
  close: () => Promise<void>,
): () => void {
  if (env.NODE_ENV === 'production' || env.CYBERSAFE_DEV_ISOLATION !== '1' ||
      env.CYBERSAFE_DEV_OWNED_CHILD !== '1' || parent.connected !== true) return () => {};
  let pending: Promise<void> | undefined;
  const begin = () => { pending ??= close().catch((error) => { console.error('[DEV] Encerramento não confirmado:', error); }); };
  const message = (value: unknown) => {
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'cybersafe:dev:shutdown') begin();
  };
  parent.on('message', message);
  parent.on('disconnect', begin);
  return () => { parent.off('message', message); parent.off('disconnect', begin); };
}
