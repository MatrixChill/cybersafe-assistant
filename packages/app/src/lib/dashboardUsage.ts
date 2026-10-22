/**
 * Painel › «A usar agora» — o que mostrar no lugar das quatro métricas.
 *
 * Antes, sem `hardware` aparecia SEMPRE o esqueleto de carregamento, mesmo com
 * o serviço desligado (o App põe `hardware=null` e `isLoading=false` quando a
 * ligação cai): a página prometia uma leitura que não ia chegar.
 */
export type UsageReadState = "ready" | "loading" | "service-down" | "no-reading";

/**
 * Origem explícita dos dados exibidos numa superfície:
 * - `DEMO`: fixtures sintéticas passadas explicitamente por um harness (`isDemo=true` ou `dataOrigin="DEMO"`).
 * - `LIVE`: snapshot real com serviço confirmado (`serviceConnected !== false`).
 * - `CACHED`: última leitura real em cache quando a ligação ao serviço cai (`serviceConnected === false`).
 * - `UNAVAILABLE`: sem snapshot disponível.
 *
 * Regra SPRINT60: `serviceConnected === false` por si NUNCA infere `DEMO`.
 */
export type SurfaceDataOrigin = "DEMO" | "LIVE" | "CACHED" | "UNAVAILABLE";

export function resolveSurfaceDataOrigin(opts: {
  dataOrigin?: SurfaceDataOrigin;
  isDemo?: boolean;
  hasSnapshot: boolean;
  serviceConnected?: boolean | null;
}): SurfaceDataOrigin {
  if (opts.dataOrigin) return opts.dataOrigin;
  if (opts.isDemo === true) return "DEMO";
  if (!opts.hasSnapshot) return "UNAVAILABLE";
  if (opts.serviceConnected === false) return "CACHED";
  return "LIVE";
}

export function usageReadState(hasHardware: boolean, isLoading: boolean, serviceConnected: boolean | null | undefined): UsageReadState {
  if (hasHardware) return "ready";
  if (serviceConnected === false) return "service-down";
  if (isLoading) return "loading";
  return "no-reading";
}

export const USAGE_UNAVAILABLE_COPY: Record<Exclude<UsageReadState, "ready" | "loading">, { title: string; detail: string }> = {
  "service-down": {
    title: "Sem medições: o serviço de proteção está desligado",
    detail: "CPU, memória, disco e rede voltam a aparecer quando o serviço voltar a responder. Nada aqui é estimado.",
  },
  "no-reading": {
    title: "Ainda sem medições do serviço",
    // Não afirma que o serviço está ligado: aqui a ligação pode ser desconhecida.
    detail: "CPU, memória, disco e rede aparecem quando o serviço os enviar; a leitura é pedida a cada 2 segundos. Nada aqui é estimado.",
  },
};
