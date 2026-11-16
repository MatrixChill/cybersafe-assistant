/** Only called after the API has authenticated the account. No raw IPC,
 * backend diagnostics or credentials are echoed in the form. */
export function authSessionFailure(error: unknown, remember: boolean) {
  const keyringUnavailable = remember && String(error).includes("SESSION_KEYRING_UNAVAILABLE");
  return {
    error: keyringUnavailable
      ? "A conta foi autenticada, mas não foi possível guardar a sessão no porta-chaves Linux. Ative e desbloqueie o Secret Service ou entre sem guardar a sessão."
      : "Não foi possível guardar a sessão com segurança.",
    campo: "geral" as const,
    sessionOnlyRetry: keyringUnavailable,
  };
}
