/**
 * Estado global de encerramento do renderer.
 *
 * Durante o shutdown (o utilizador confirmou "Sair"), o renderer tem de parar
 * de pedir dados: o `ServiceClient` do processo principal já foi desligado
 * (`disconnect()`) e cada request nova — ou ainda em voo — era rejeitada com
 * "Service client disconnected", o que o Electron reportava como
 * "Error occurred in handler for 'service:...'" repetidamente.
 *
 * É o único estado partilhado necessário: nada de arquitetura nova.
 */

export interface ShutdownState {
  isShuttingDown(): boolean;
  /** Idempotente: a primeira chamada avisa todos os subscritores. */
  begin(): void;
  /** Regista um cleanup de shutdown; devolve o unsubscribe. */
  onShutdown(listener: () => void): () => void;
}

export function createShutdownState(): ShutdownState {
  let shuttingDown = false;
  const listeners = new Set<() => void>();

  const notify = (listener: () => void) => {
    try {
      listener();
    } catch (error) {
      console.error("[Shutdown] cleanup falhou:", error);
    }
  };

  return {
    isShuttingDown: () => shuttingDown,
    begin() {
      if (shuttingDown) return;
      shuttingDown = true;
      // Cópia: um listener pode desregistar-se durante o aviso.
      for (const listener of [...listeners]) notify(listener);
      listeners.clear();
    },
    onShutdown(listener) {
      if (shuttingDown) {
        // Já estamos a encerrar: corre já, para não deixar timers vivos.
        notify(listener);
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Estado real da aplicação. */
export const appShutdown = createShutdownState();

export const isAppShuttingDown = (): boolean => appShutdown.isShuttingDown();

/** Chamado quando o utilizador confirma "Sair" (antes de responder ao main). */
export const beginAppShutdown = (): void => appShutdown.begin();

export const onAppShutdown = (listener: () => void): (() => void) =>
  appShutdown.onShutdown(listener);

/**
 * Corre um trabalho periódico só enquanto a app não estiver a encerrar.
 * Devolve false quando o trabalho foi ignorado (polling parou).
 */
export function runUnlessShuttingDown(
  job: () => void,
  state: ShutdownState = appShutdown,
): boolean {
  if (state.isShuttingDown()) return false;
  job();
  return true;
}

/**
 * Chamada ao bridge só fora do shutdown:
 * - antes de encerrar devolve null SEM chamar nada (cancelamento silencioso);
 * - em voo quando o shutdown começa devolve null (cancelamento esperado);
 * - erro REAL em runtime normal propaga sempre (nunca escondemos falhas).
 */
export async function ipcUnlessShuttingDown<T>(
  call: () => Promise<T>,
  state: ShutdownState = appShutdown,
): Promise<T | null> {
  if (state.isShuttingDown()) return null;
  try {
    const result = await call();
    return state.isShuttingDown() ? null : result;
  } catch (error) {
    if (state.isShuttingDown()) return null;
    throw error;
  }
}
