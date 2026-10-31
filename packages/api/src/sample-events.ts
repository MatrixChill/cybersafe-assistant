/**
 * Política dos eventos de exemplo da API (AUD-001), isolada do módulo de base
 * de dados para poder ser testada sem abrir uma DB real.
 *
 * Regra: a amostra só existe por opt-in explícito E nunca em produção. O
 * arranque normal não escreve nada.
 */
export const SAMPLE_EVENTS_ENV = "CYBERSAFE_API_SAMPLE_EVENTS";

export function sampleEventsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env[SAMPLE_EVENTS_ENV] === "1";
}
