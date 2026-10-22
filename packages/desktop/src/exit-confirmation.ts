/**
 * Controller da confirmação de saída — módulo puro (sem Electron), testável.
 *
 * Garantias (a lógica de shutdown existente não é alterada, só passa a ser
 * sempre invocada daqui):
 *   - uma pergunta em curso nunca é duplicada (tray clicada duas vezes, etc.);
 *   - confirmar executa o shutdown EXATAMENTE uma vez;
 *   - cancelar NUNCA executa o shutdown;
 *   - sem resposta dentro do prazo ⇒ cancelar (nunca encerrar por timeout);
 *   - uma falha ao perguntar nunca rebenta o processo principal.
 */

export interface ExitConfirmationOptions {
  /** Pergunta ao utilizador (modal CyberSafe). true = confirmar a saída. */
  ask: () => Promise<boolean>;
  /** Executa o shutdown já existente (quitCyberSafe). */
  onConfirmed: () => void | Promise<void>;
  /** Sem resposta dentro deste prazo ⇒ cancelar. */
  timeoutMs?: number;
  onTimeout?: () => void;
  onError?: (error: unknown) => void;
}

export interface ExitConfirmation {
  /** Resolve true se o shutdown foi (ou já tinha sido) pedido. */
  request: () => Promise<boolean>;
  /** true enquanto o utilizador tem o modal aberto. */
  readonly isPending: boolean;
  /** true depois de o shutdown ter sido pedido uma vez. */
  readonly isConfirmed: boolean;
}

export const DEFAULT_EXIT_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Promise com prazo: resolve(false) e avisa `onTimeout` se ninguém responder.
 * Rejeições propagam-se (o caller decide o que logar).
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T | false> {
  return new Promise<T | false>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      resolve(false);
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createExitConfirmation(options: ExitConfirmationOptions): ExitConfirmation {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXIT_CONFIRM_TIMEOUT_MS;
  let pending: Promise<boolean> | null = null;
  let confirmed = false;

  async function run(): Promise<boolean> {
    let answer = false;
    try {
      answer = Boolean(await withTimeout(options.ask(), timeoutMs, options.onTimeout));
    } catch (error) {
      options.onError?.(error);
      return false;
    }

    // Cancelar nunca encerra.
    if (!answer) return false;

    // Já houve um pedido confirmado: não repetir o shutdown.
    if (confirmed) return true;
    confirmed = true;

    try {
      await options.onConfirmed();
    } catch (error) {
      options.onError?.(error);
    }
    return true;
  }

  return {
    request() {
      if (!pending) {
        // Dedupe: pedidos concorrentes partilham a mesma pergunta/confirmação.
        pending = run().finally(() => {
          pending = null;
        });
      }
      return pending;
    },
    get isPending() {
      return pending !== null;
    },
    get isConfirmed() {
      return confirmed;
    },
  };
}
