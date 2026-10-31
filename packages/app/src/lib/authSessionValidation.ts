/** Only validates a saved bearer. Never calls login/register or invents a user.
 * The local API starts after the renderer, so transient startup failures get
 * bounded retries. Invalid credentials are returned immediately for clearing.
 */
export async function validateSavedSession(
  base: string, token: string, signal?: AbortSignal,
  budgetMs = 30000, retryMs = 400,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, budgetMs);
  try {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`${base}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        if (![500, 502, 503, 504].includes(response.status)) return response;
        await response.body?.cancel();
      } catch { if (controller.signal.aborted) break; }
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, retryMs);
        controller.signal.addEventListener("abort", finish, { once: true });
        if (controller.signal.aborted) finish();
      });
    }
    throw new Error("A validação da sessão não foi confirmada.");
  } finally { clearTimeout(deadline); signal?.removeEventListener("abort", abort); }
}
