/**
 * Plausibilidade do tempo restante da bateria (minutos).
 *
 * Porque existe: em Linux o `systeminformation` calcula a autonomia como
 * `energy_now / power_now`. Com o portátil quase em repouso, ou com um
 * `power_now` que o firmware deixa a 0/ínfimo, a divisão dá estimativas
 * absurdas (observado: 216 h). Uma estimativa assim é pior do que nenhuma.
 *
 * Regras (conservadoras, iguais no produtor e na UI):
 *  - não finito, ≤ 0, ou a carregar → sem estimativa;
 *  - acima de `BATTERY_ESTIMATE_MAX_MINUTES` (24 h) → sem estimativa;
 *  - inconsistente com a percentagem: mais de 15 min por cada 1 % restante
 *    (equivale a > 25 h com a bateria cheia) → sem estimativa.
 *
 * Devolve os minutos arredondados quando a estimativa é confiável, senão
 * `null` — a UI apresenta «Estimativa indisponível», nunca um número.
 */
export const BATTERY_ESTIMATE_MAX_MINUTES = 24 * 60;
const MAX_MINUTES_PER_PERCENT = 15;

export function plausibleBatteryMinutes(input: {
  minutes: unknown;
  percent?: unknown;
  isCharging?: unknown;
}): number | null {
  if (input.isCharging === true) return null;
  const m = input.minutes;
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return null;
  if (m > BATTERY_ESTIMATE_MAX_MINUTES) return null;
  const p = input.percent;
  if (typeof p === "number" && Number.isFinite(p) && p > 0 && p <= 100) {
    if (m / p > MAX_MINUTES_PER_PERCENT) return null;
  }
  return Math.round(m);
}
