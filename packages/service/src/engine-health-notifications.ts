/**
 * Quando é que uma indisponibilidade de motor merece uma notificação?
 *
 * Evidência humana (R6 na VM/PC): os motores alternaram entre `active` e
 * `degraded` e as notificações repetiram-se. O `getProtectionState` publicava
 * sempre que a disponibilidade passava a `false`, sem qualquer histerese — um
 * probe que oscila (ex.: prova de carga a repetir) gerava uma notificação por
 * oscilação. Uma degradação REAL continua a ser anunciada; o que se corta é a
 * repetição da MESMA transição dentro da janela de arrefecimento.
 *
 * Regras:
 *  - só uma transição real (antes disponível → agora indisponível) anuncia;
 *  - a mesma transição não repete dentro de `cooldownMs`;
 *  - voltar a estar disponível nunca gera notificação de indisponibilidade.
 */
export interface EngineHealthSnapshot {
  engine: string;
  available: boolean;
  status: string;
}

export const ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS = 10 * 60_000;

export function shouldPublishEngineUnavailable(
  previous: EngineHealthSnapshot | null,
  next: EngineHealthSnapshot,
  now: number,
  lastPublishedAt: number | undefined,
  cooldownMs: number = ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS,
): boolean {
  if (next.available) return false;
  if (!previous || previous.available !== true) return false;
  if (lastPublishedAt !== undefined && Number.isFinite(lastPublishedAt) && now - lastPublishedAt < cooldownMs) return false;
  return true;
}
