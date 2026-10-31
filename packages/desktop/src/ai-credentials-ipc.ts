import type { AiCredentialsStore } from "./ai-credentials-store.js";

/** Caller must provide Main's trusted-frame + read-only-policy wrapper. */
export function registerAiCredentialsIpc(
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => unknown,
  createStore: () => AiCredentialsStore,
  configure: (store: AiCredentialsStore) => Promise<boolean>,
): void {
  let store: AiCredentialsStore | undefined;
  let busy = false;
  const current = () => store ??= createStore();
  handle("ai-credentials:get-status", () => {
    try { return { hasKey: current().hasKey(), provider: current().getProvider(), state: "unverified" }; }
    catch { return { hasKey: false, provider: "groq", state: "unavailable" }; }
  });
  const change = async (clear: boolean, key?: unknown, provider?: unknown) => {
    if (busy) return { ok: false, error: "A configuração anterior ainda está em curso." };
    busy = true;
    try {
      if (clear) current().clear(); else current().writeKey(key, provider);
      const applied = await configure(current());
      return { ok: true, applied, hasKey: current().hasKey(), provider: current().getProvider(), state: applied ? "configured" : "pending-api" };
    } catch { return { ok: false, error: "Não foi possível atualizar a configuração protegida da IA." }; }
    finally { busy = false; }
  };
  handle("ai-credentials:save", (_event, key, provider) => change(false, key, provider));
  handle("ai-credentials:clear", () => change(true));
}
