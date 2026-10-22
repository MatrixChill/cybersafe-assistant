/**
 * Guarda das leituras IPC pedidas pelo renderer.
 *
 * Durante o shutdown o `ServiceClient` já fez `disconnect()`; qualquer pedido
 * novo ou em voo era rejeitado com "Service client disconnected" e o Electron
 * logava "Error occurred in handler for 'service:...'". Aqui esses cancelamentos
 * são esperados (devolvemos null) e os erros reais continuam a propagar.
 */

/** `isAppQuitting` no main é `() => isQuitting`. */
export async function guardedServiceRequest<T>(
  isAppQuitting: () => boolean,
  call: () => Promise<T>,
): Promise<T | null> {
  // Encerramento em curso: não iniciar novas leituras.
  if (isAppQuitting()) return null;
  try {
    const result = await call();
    return isAppQuitting() ? null : result;
  } catch (error) {
    // Pedido em voo cancelado pelo shutdown: cancelamento controlado.
    if (isAppQuitting()) return null;
    // Falha real durante runtime normal: propaga (nunca é silenciada).
    throw error;
  }
}

/** Restringe IPC à janela principal, ao frame principal e ao documento esperado. */
export function trustedIpcHandler<E extends {
  sender: unknown;
  senderFrame: { url: string } | null;
}, A extends unknown[], R>(
  expectedContents: () => { mainFrame: unknown; isDestroyed(): boolean } | null,
  expectedUrl: () => string,
  handler: (event: E, ...args: A) => R,
): (event: E, ...args: A) => R {
  return (event, ...args) => {
    const contents = expectedContents();
    let sameDocument = false;
    try {
      const actual = new URL(event.senderFrame?.url ?? "");
      const expected = new URL(expectedUrl());
      actual.hash = "";
      expected.hash = "";
      sameDocument = actual.href === expected.href;
    } catch { /* Um URL inválido nunca autoriza. */ }
    if (!contents || contents.isDestroyed() || event.sender !== contents ||
        !event.senderFrame || event.senderFrame !== contents.mainFrame || !sameDocument) {
      throw new Error("Emissor IPC não autorizado");
    }
    return handler(event, ...args);
  };
}

/** Relatórios HTML são conteúdo sem acesso à ponte privilegiada. */
export function reportWindowPreferences() {
  return { contextIsolation: true, nodeIntegration: false, sandbox: true };
}
