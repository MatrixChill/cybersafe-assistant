import type { AuthSessionStore } from "./auth-session-store.js";

/** Registration must use the shell's trustedIpcHandler sender/document guard. */
export function registerAuthSessionIpc(
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => unknown,
  createStore: () => AuthSessionStore,
): void {
  let store: AuthSessionStore | undefined;
  const current = () => store ??= createStore();
  const safely = <T>(run: () => T): T => {
    try { return run(); }
    catch { throw new Error("Não foi possível aceder à sessão de forma segura."); }
  };
  handle("auth-session:read", () => safely(() => current().read()));
  handle("auth-session:write", (_event, token, remember) => safely(() => current().write(token, remember)));
  handle("auth-session:clear", () => safely(() => current().clear()));
}
