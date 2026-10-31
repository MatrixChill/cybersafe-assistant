/** Explicit opt-in probe. Opening MATRIX/configuration never invokes this function. */
export async function verifyMatrixProvider(base: string, headers: HeadersInit, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{ operational: boolean; label: string }> {
  try {
    const response = await fetcher(`${base}/api/ai/status`, { headers, signal });
    if (!response.ok) return { operational: false, label: response.status === 401 ? "Sessão local não autenticada" : "Provider indisponível" };
    const status = await response.json();
    return { operational: status.enabled === true, label: status.enabled === true ? "Provider operacional — verificado agora" : status.errorKind === "auth" ? "Erro de autenticação do provider" : status.errorKind === "network" || status.errorKind === "timeout" ? "Erro de rede ou tempo excedido" : "Provider indisponível" };
  } catch { return { operational: false, label: "Erro de rede ou API indisponível" }; }
}
