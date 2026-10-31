/**
 * Prazo máximo para uma promessa que atravessa o bridge (IPC).
 *
 * O `ipcRenderer.invoke` não tem deadline: se o pedido do serviço nunca
 * responder (serviço ocupado, pipe meio-aberto, `openSocket` a repetir ligações),
 * a promessa fica pendurada e qualquer ecrã de "a carregar" fica preso para
 * sempre. Esta é a rede de segurança: NUNCA rejeita, NUNCA deixa o timer vivo, e
 * devolve um resultado explícito para que a UI possa terminar num estado honesto.
 */

export type DeadlineResult<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown };

export async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<DeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<DeadlineResult<T>>([
      promise.then((value) => ({ kind: "value", value })),
      new Promise<DeadlineResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    return result;
  } catch (error) {
    return { kind: "error", error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
