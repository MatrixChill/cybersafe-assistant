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
